import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";

export type OperationOutcome = {
  state: "succeeded" | "failed" | "cancelled" | "unknown";
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type OperationRecord = Omit<OperationOutcome, "state"> & {
  id: string;
  state: "running" | OperationOutcome["state"];
};
export type OperationScope = {
  kind: "file";
  grantId: string;
  generation: string;
  rootFingerprint: string;
};

type Row = {
  id: string;
  fingerprint: string;
  state: OperationRecord["state"];
  stdout: string;
  stderr: string;
  exit_code: number | null;
  scope: string | null;
};

const terminalStates = new Set(["succeeded", "failed", "cancelled", "unknown"]);
function scopeText(scope?: OperationScope | null): string | null {
  if (!scope) return null;
  if (
    scope.kind !== "file" ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(scope.grantId) ||
    typeof scope.generation !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(scope.generation) ||
    !/^[a-f0-9]{64}$/.test(scope.rootFingerprint) ||
    Object.keys(scope).some(
      (key) =>
        !["kind", "grantId", "generation", "rootFingerprint"].includes(key),
    )
  )
    throw new OperationAdmissionError("Invalid operation scope");
  return JSON.stringify({
    kind: scope.kind,
    grantId: scope.grantId,
    generation: scope.generation,
    rootFingerprint: scope.rootFingerprint,
  });
}
// Shared even when source/built copies of this module are loaded together. On
// POSIX, closing any descriptor for the database can release this process's
// SQLite locks. Reject another owner before opening a descriptor at all.
const ownerSymbol = Symbol.for("eagle.operation-journal.owners");
const shared = globalThis as { [key: symbol]: unknown };
shared[ownerSymbol] ??= new Set<string>();
const localOwners = shared[ownerSymbol] as Set<string>;

/** Hold an existing journal idle without recovery or modifying any operation. */
export function withIdleJournal<T>(path: string, action: () => T): T {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return action();
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600
  )
    throw new Error("Invalid private operation journal");
  const keys = [`path:${realpathSync(path)}`, `inode:${info.dev}:${info.ino}`];
  if (keys.some((key) => localOwners.has(key)))
    throw new Error("Operation journal is busy");
  for (const key of keys) localOwners.add(key);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    database.exec("PRAGMA busy_timeout = 100; BEGIN EXCLUSIVE;");
    return action();
  } finally {
    database?.close();
    for (const key of keys) localOwners.delete(key);
  }
}
const record = (row: Row): OperationRecord => ({
  id: row.id,
  state: row.state,
  stdout: row.stdout,
  stderr: row.stderr,
  exitCode: row.exit_code,
});

/** Expected admission rejection; other journal errors mean storage is unhealthy. */
export class OperationAdmissionError extends Error {}

export class OperationJournal {
  private database: DatabaseSync;
  private capacity: number;
  private closed = false;
  private ownerKeys: string[] = [];

  constructor(path: string, capacity = 10_000) {
    if (!isMainThread)
      throw new Error("Operation journal must be owned by the primary thread");
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000)
      throw new Error("Invalid operation journal capacity");
    this.capacity = capacity;
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0)
      throw new Error("Operation journal needs a private directory");
    const canonicalPath = join(realpathSync(directory), basename(path));
    const pathKey = `path:${canonicalPath}`;
    const existing = lstatSync(canonicalPath, { throwIfNoEntry: false });
    const inodeKey = existing ? `inode:${existing.dev}:${existing.ino}` : null;
    if (localOwners.has(pathKey) || (inodeKey && localOwners.has(inodeKey)))
      throw new Error("Operation journal is locked by this process");
    this.ownerKeys.push(pathKey);
    localOwners.add(pathKey);
    let database: DatabaseSync | undefined;
    try {
      const fd = openSync(
        canonicalPath,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const file = fstatSync(fd);
        if (!file.isFile())
          throw new Error("Operation journal must be a regular file");
        fchmodSync(fd, 0o600);
        const key = `inode:${file.dev}:${file.ino}`;
        this.ownerKeys.push(key);
        localOwners.add(key);
      } finally {
        closeSync(fd);
      }
      database = new DatabaseSync(canonicalPath);
      this.database = database;
      // An exclusive connection retains its lock across transactions. Recovery
      // cannot run while another service owns this journal, even in this process.
      this.database.exec(`
        PRAGMA busy_timeout = 100;
        PRAGMA locking_mode = EXCLUSIVE;
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS operations (
          id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN
            ('running','succeeded','failed','cancelled','unknown')),
          stdout TEXT NOT NULL DEFAULT '',
          stderr TEXT NOT NULL DEFAULT '',
          exit_code INTEGER,
          scope TEXT
        );
        UPDATE operations SET state = 'unknown', exit_code = NULL
          WHERE state = 'running';
        COMMIT;
      `);
      const columns = this.database
        .prepare("PRAGMA table_info(operations)")
        .all() as { name: string }[];
      if (!columns.some((column) => column.name === "scope"))
        this.database.exec("ALTER TABLE operations ADD COLUMN scope TEXT");
    } catch (error) {
      database?.close();
      for (const key of this.ownerKeys) localOwners.delete(key);
      throw error;
    }
  }

  begin(
    id: string,
    fingerprint: string,
    scope?: OperationScope,
  ): { created: boolean; operation: OperationRecord } {
    if (
      !/^[a-zA-Z0-9_-]{1,120}$/.test(id) ||
      !/^[a-f0-9]{64}$/.test(fingerprint)
    )
      throw new OperationAdmissionError("Invalid operation identity");
    const scopeValue = scopeText(scope);
    const previous = this.row(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.scope !== scopeValue)
        throw new OperationAdmissionError("Operation identity conflict");
      return { created: false, operation: record(previous) };
    }
    const count = this.database
      .prepare("SELECT COUNT(*) AS count FROM operations")
      .get() as { count: number };
    if (count.count >= this.capacity)
      throw new OperationAdmissionError("Operation journal capacity reached");
    this.database
      .prepare(
        "INSERT INTO operations (id, fingerprint, state, scope) VALUES (?, ?, 'running', ?)",
      )
      .run(id, fingerprint, scopeValue);
    return {
      created: true,
      operation: {
        id,
        state: "running",
        stdout: "",
        stderr: "",
        exitCode: null,
      },
    };
  }

  finish(id: string, outcome: OperationOutcome): OperationRecord {
    if (
      !terminalStates.has(outcome.state) ||
      typeof outcome.stdout !== "string" ||
      typeof outcome.stderr !== "string" ||
      Buffer.byteLength(outcome.stdout) + Buffer.byteLength(outcome.stderr) >
        65_536 ||
      (outcome.exitCode !== null &&
        (!Number.isInteger(outcome.exitCode) ||
          outcome.exitCode < 0 ||
          outcome.exitCode > 255)) ||
      (outcome.state === "succeeded" &&
        outcome.exitCode !== 0 &&
        outcome.exitCode !== null) ||
      (["cancelled", "unknown"].includes(outcome.state) &&
        outcome.exitCode !== null)
    )
      throw new Error("Invalid or over-budget operation result");
    const previous = this.row(id);
    if (!previous) throw new Error("Unknown operation");
    if (previous.state !== "running") return record(previous);
    this.database
      .prepare(
        "UPDATE operations SET state = ?, stdout = ?, stderr = ?, exit_code = ? WHERE id = ?",
      )
      .run(outcome.state, outcome.stdout, outcome.stderr, outcome.exitCode, id);
    const stored = this.row(id);
    if (!stored) throw new Error("Operation result was not persisted");
    return record(stored);
  }

  get(id: string): OperationRecord | null {
    const row = this.row(id);
    return row ? record(row) : null;
  }
  getScope(id: string): OperationScope | null {
    const value = this.row(id)?.scope;
    if (!value) return null;
    const scope = JSON.parse(value) as OperationScope;
    scopeText(scope);
    return scope;
  }

  private row(id: string): Row | undefined {
    return this.database
      .prepare("SELECT * FROM operations WHERE id = ?")
      .get(id) as Row | undefined;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
    for (const key of this.ownerKeys) localOwners.delete(key);
  }
}
