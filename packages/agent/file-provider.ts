import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, statSync } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { redact } from "./collector.ts";
import type { OperationOutcome } from "./operation-journal.ts";

export type FileGrant = {
  id: string;
  generation: string;
  root: string;
  name?: string;
  rootFingerprint?: string;
};
export type FileRequest = {
  tool: "file.read" | "file.list";
  grantId: string;
  generation: string;
  path: string;
};
export type FileScope = {
  kind: "file";
  grantId: string;
  generation: string;
  rootFingerprint: string;
};
export type FileProviderSettings = {
  grants: () => readonly FileGrant[];
  privateRoot: string;
  secrets?: string[];
};

const byteLimit = 32 * 1024;
export function fileRootFingerprint(root: string): string {
  const info = statSync(root);
  if (!isAbsolute(root) || realpathSync(root) !== root || !info.isDirectory())
    throw new Error("Invalid file grant directory");
  return createHash("sha256")
    .update(JSON.stringify([root, info.dev, info.ino]))
    .digest("hex");
}
const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
};

export class FileProvider {
  private settings: FileProviderSettings;
  private privateRoot: string;
  private privateIdentity: { dev: number; ino: number };
  constructor(settings: FileProviderSettings) {
    this.settings = settings;
    this.privateRoot = realpathSync(settings.privateRoot);
    this.privateIdentity = lstatSync(this.privateRoot);
    this.checkPrivateRoot();
  }
  private checkPrivateRoot(): void {
    try {
      const current = lstatSync(this.privateRoot);
      if (
        !current.isDirectory() ||
        realpathSync(this.privateRoot) !== this.privateRoot ||
        current.dev !== this.privateIdentity.dev ||
        current.ino !== this.privateIdentity.ino
      )
        throw new Error("Changed private directory");
    } catch {
      throw new Error(
        "Private Agent state directory changed; file access unavailable",
      );
    }
  }
  capabilities(): {
    state: "ready" | "unknown";
    grants: {
      id: string;
      generation: string;
      name: string;
      available: boolean;
    }[];
  } {
    try {
      this.checkPrivateRoot();
      const grants = this.settings.grants();
      if (grants.length > 32) throw new Error("Grant limit");
      return {
        state: "ready",
        grants: grants.map((grant) => {
          if (
            [grant.id, grant.generation].some(
              (text) => redact(text, this.settings.secrets ?? []) !== text,
            )
          )
            throw new Error("Invalid grant identity");
          let available = true;
          try {
            this.scope(grant);
          } catch {
            available = false;
          }
          const name = grant.name ?? grant.id;
          return {
            id: grant.id,
            generation: grant.generation,
            name:
              redact(name, this.settings.secrets ?? []) === name
                ? name
                : "Authorized directory",
            available,
          };
        }),
      };
    } catch {
      return { state: "unknown", grants: [] };
    }
  }
  private grant(grantId: string, generation: string): FileGrant {
    const matches = this.settings
      .grants()
      .filter(
        (grant) => grant.id === grantId && grant.generation === generation,
      );
    if (matches.length !== 1 || !isAbsolute(matches[0].root))
      throw new Error("File grant revoked or unavailable");
    return matches[0];
  }
  private scope(grant: FileGrant): FileScope {
    this.checkPrivateRoot();
    const root = realpathSync(grant.root);
    const info = statSync(root);
    if (
      !info.isDirectory() ||
      root !== grant.root ||
      inside(this.privateRoot, root)
    )
      throw new Error("Invalid file grant directory");
    const fingerprint = fileRootFingerprint(root);
    if (grant.rootFingerprint && grant.rootFingerprint !== fingerprint)
      throw new Error("File grant root changed; fresh consent required");
    return {
      kind: "file",
      grantId: grant.id,
      generation: grant.generation,
      rootFingerprint: fingerprint,
    };
  }
  authorize(request: FileRequest): FileScope {
    if (
      !["file.read", "file.list"].includes(request.tool) ||
      typeof request.path !== "string" ||
      request.path.length > 4096 ||
      request.path.includes("\\") ||
      request.path.includes("\0") ||
      isAbsolute(request.path) ||
      (request.path !== "." &&
        request.path
          .split("/")
          .some((part) => !part || part === "." || part === "..")) ||
      [request.path, request.grantId, request.generation].some(
        (value) =>
          typeof value !== "string" ||
          redact(value, this.settings.secrets ?? []) !== value,
      )
    )
      throw new Error("Invalid file request");
    const grant = this.grant(request.grantId, request.generation);
    if (inside(this.privateRoot, resolve(grant.root, request.path)))
      throw new Error("Private Agent state is not exposed");
    return this.scope(grant);
  }
  authorizeScope(scope: FileScope): void {
    const current = this.scope(this.grant(scope.grantId, scope.generation));
    if (current.rootFingerprint !== scope.rootFingerprint)
      throw new Error("File grant changed");
  }
  async run(
    request: FileRequest,
    signal: AbortSignal,
  ): Promise<OperationOutcome> {
    const scope = this.authorize(request);
    const grant = this.grant(scope.grantId, scope.generation);
    const parts = request.path === "." ? [] : request.path.split("/");
    let path = grant.root;
    const chain = [{ path, info: lstatSync(path) }];
    for (const part of parts) {
      path = resolve(path, part);
      chain.push({ path, info: lstatSync(path) });
    }
    const check = () => {
      signal.throwIfAborted();
      this.authorizeScope(scope);
      for (const [index, item] of chain.entries()) {
        const current = lstatSync(item.path);
        if (
          current.isSymbolicLink() ||
          current.dev !== item.info.dev ||
          current.ino !== item.info.ino ||
          (index < chain.length - 1 && !current.isDirectory()) ||
          realpathSync(item.path) !== item.path ||
          inside(this.privateRoot, item.path)
        )
          throw new Error("File path changed or is not authorized");
      }
    };
    check();
    let stdout: string;
    if (request.tool === "file.read") {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        const expected = chain.at(-1)?.info;
        if (
          !expected ||
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > byteLimit ||
          info.dev !== expected.dev ||
          info.ino !== expected.ino
        )
          throw new Error("File identity, type or byte limit rejected");
        check();
        const buffer = Buffer.alloc(byteLimit + 1);
        let size = 0;
        while (size < buffer.length) {
          check();
          const { bytesRead } = await file.read(
            buffer,
            size,
            buffer.length - size,
            size,
          );
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > byteLimit || (await file.stat()).nlink !== 1)
          throw new Error("File type or byte limit rejected");
        stdout = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, size),
        );
        check();
      } finally {
        await file.close();
      }
    } else {
      if (!chain.at(-1)?.info.isDirectory())
        throw new Error("A directory is required");
      const entries: { name: string; kind: "file" | "directory" }[] = [];
      let scanned = 0;
      const listing = await opendir(path, { bufferSize: 32 });
      for await (const entry of listing) {
        check();
        if (++scanned > 2000) throw new Error("Directory entry limit exceeded");
        if (!entry.isFile() && !entry.isDirectory()) continue;
        if (redact(entry.name, this.settings.secrets ?? []) !== entry.name)
          continue;
        const entryPath = resolve(path, entry.name);
        if (inside(this.privateRoot, entryPath)) continue;
        const info = lstatSync(entryPath);
        if (
          (!info.isFile() && !info.isDirectory()) ||
          (info.isFile() && info.nlink !== 1)
        )
          continue;
        entries.push({
          name: entry.name,
          kind: info.isDirectory() ? "directory" : "file",
        });
        if (Buffer.byteLength(JSON.stringify(entries)) > byteLimit)
          throw new Error("Directory byte limit exceeded");
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      stdout = JSON.stringify(entries);
    }
    check();
    if (request.tool === "file.read")
      stdout = redact(stdout, this.settings.secrets ?? []);
    if (Buffer.byteLength(stdout) > byteLimit)
      throw new Error("File result limit exceeded");
    return { state: "succeeded", stdout, stderr: "", exitCode: null };
  }
}
