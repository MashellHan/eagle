import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REMOTE_OPERATIONS, type RemoteConfiguration, type RemoteTarget } from "../core/domain.ts";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const origin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        value === url.origin &&
        !url.username &&
        !url.password &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  });
const targetSchema = z.strictObject({
  alias: identifier,
  enabled: z.boolean(),
  origin,
  machineId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  credentialRef: z.string().regex(/^[A-Za-z0-9_-]{8,120}$/),
  operations: z
    .array(z.enum(REMOTE_OPERATIONS))
    .min(1)
    .max(5)
    .refine((values) => new Set(values).size === values.length),
});
const inputSchema = z.strictObject({
  revision: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  targets: z
    .array(targetSchema)
    .max(8)
    .refine(
      (targets) =>
        new Set(targets.map((target) => target.alias)).size === targets.length &&
        new Set(targets.map((target) => target.credentialRef)).size === targets.length,
    ),
});
const removalSchema = z.strictObject({
  origin,
  credentialRef: z.string().regex(/^[A-Za-z0-9_-]{8,120}$/),
});
const fileSchema = inputSchema.extend({
  namespace: z.string().regex(/^[a-f0-9]{64}$/),
  pendingRemovals: z.array(removalSchema).max(128).default([]),
  blocked: z.boolean().default(false),
});
export type RemoteRemoval = z.infer<typeof removalSchema>;
export type StoredRemoteConfiguration = RemoteConfiguration & {
  readonly pendingRemovals: readonly RemoteRemoval[];
  readonly blocked: boolean;
};
export type PublicRemoteConfiguration = RemoteConfiguration & {
  readonly helperAvailable: boolean;
  readonly cleanupPending: boolean;
};
export interface RemoteSettingsApi {
  read(botId: string): PublicRemoteConfiguration;
  save(botId: string, input: unknown): Promise<PublicRemoteConfiguration>;
}

export class RemoteSettingsError extends Error {
  readonly code: "invalid" | "conflict" | "unavailable";
  constructor(code: "invalid" | "conflict" | "unavailable") {
    super(`Remote settings ${code}`);
    this.code = code;
  }
}

export class RemoteSettingsStore {
  readonly namespace: string;
  readonly #directory: string;
  constructor(root: string, namespace: string) {
    if (!/^[a-f0-9]{64}$/.test(namespace)) throw new RemoteSettingsError("invalid");
    this.namespace = namespace;
    this.#directory = join(root, "remote-tools");
  }
  #path(botId: string): string {
    if (!identifier.safeParse(botId).success) throw new RemoteSettingsError("invalid");
    try {
      mkdirSync(this.#directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new RemoteSettingsError("unavailable");
    }
    const directory = lstatSync(this.#directory);
    if (
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o777) !== 0o700
    )
      throw new RemoteSettingsError("unavailable");
    return join(this.#directory, `${botId}.json`);
  }
  read(botId: string): StoredRemoteConfiguration {
    const value = this.#load(botId);
    const blocked = value.blocked || !this.#hasRevocationCapacity(value);
    return blocked
      ? {
          ...value,
          blocked,
          targets: value.targets.map((target) => ({ ...target, enabled: false })),
        }
      : value;
  }
  #hasRevocationCapacity(value: StoredRemoteConfiguration): boolean {
    const pendingRemovals = [...value.pendingRemovals];
    for (const target of value.targets) {
      if (
        target.enabled &&
        !pendingRemovals.some(
          (binding) =>
            binding.origin === target.origin && binding.credentialRef === target.credentialRef,
        )
      ) {
        pendingRemovals.push({ origin: target.origin, credentialRef: target.credentialRef });
      }
    }
    // Retaining disabled rows is larger than targets: []; reserve that full denial.
    const reserved = {
      ...value,
      revision: "0".repeat(36),
      blocked: false,
      targets: value.targets.map((target) => ({ ...target, enabled: false })),
      pendingRemovals,
    };
    return (
      fileSchema.safeParse(reserved).success &&
      Buffer.byteLength(JSON.stringify(reserved)) <= 65_536
    );
  }
  #load(botId: string): StoredRemoteConfiguration {
    let fd: number | undefined;
    try {
      const file = this.#path(botId);
      try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return {
            namespace: this.namespace,
            revision: "unconfigured",
            targets: [],
            pendingRemovals: [],
            blocked: false,
          };
        throw error;
      }
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o600 ||
        info.nlink !== 1 ||
        info.size > 65_536
      )
        throw new RemoteSettingsError("unavailable");
      const buffer = Buffer.alloc(65_537);
      let count = 0;
      while (count < buffer.length) {
        const bytes = readSync(fd, buffer, count, buffer.length - count, count);
        if (bytes === 0) break;
        count += bytes;
      }
      if (count > 65_536) throw new RemoteSettingsError("unavailable");
      const value = fileSchema.parse(
        JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(buffer.subarray(0, count))),
      );
      if (value.namespace !== this.namespace) throw new RemoteSettingsError("unavailable");
      return value;
    } catch (error) {
      throw error instanceof RemoteSettingsError ? error : new RemoteSettingsError("unavailable");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  async save(
    botId: string,
    input: unknown,
    verify: (target: RemoteTarget, signal: AbortSignal) => Promise<boolean>,
  ): Promise<StoredRemoteConfiguration> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new RemoteSettingsError("invalid");
    const old = this.#load(botId);
    if (parsed.data.revision !== old.revision) throw new RemoteSettingsError("conflict");
    const pendingRemovals = [...old.pendingRemovals];
    for (const prior of old.targets) {
      if (
        prior.enabled &&
        !parsed.data.targets.some(
          (target) =>
            target.enabled &&
            target.origin === prior.origin &&
            target.credentialRef === prior.credentialRef &&
            target.machineId === prior.machineId,
        )
      ) {
        if (
          !pendingRemovals.some(
            (value) => value.origin === prior.origin && value.credentialRef === prior.credentialRef,
          )
        ) {
          pendingRemovals.push({ origin: prior.origin, credentialRef: prior.credentialRef });
        }
      }
    }
    if (
      parsed.data.targets.some(
        (target) =>
          target.enabled &&
          pendingRemovals.some(
            (value) =>
              value.origin === target.origin && value.credentialRef === target.credentialRef,
          ),
      )
    )
      throw new RemoteSettingsError("unavailable");
    const next = { ...parsed.data, namespace: this.namespace, pendingRemovals, blocked: false };
    if (!this.#hasRevocationCapacity(next)) throw new RemoteSettingsError("unavailable");
    const previouslyBlocked = old.blocked || !this.#hasRevocationCapacity(old);
    const expanded = parsed.data.targets.filter(
      (target) =>
        target.enabled &&
        (previouslyBlocked ||
          !old.targets.some(
            (prior) =>
              prior.enabled &&
              prior.alias === target.alias &&
              prior.origin === target.origin &&
              prior.machineId === target.machineId &&
              prior.credentialRef === target.credentialRef &&
              target.operations.every((operation) => prior.operations.includes(operation)),
          )),
    );
    if (expanded.length > 0) {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new RemoteSettingsError("unavailable"));
        }, 15_000);
      });
      try {
        await Promise.race([
          deadline,
          (async () => {
            for (const target of expanded)
              if (!(await verify(target, controller.signal)))
                throw new RemoteSettingsError("unavailable");
          })(),
        ]);
      } catch {
        throw new RemoteSettingsError("unavailable");
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }
    // Checking credentials is asynchronous; recheck persisted authority before publication.
    // No await follows this check. The daemon's existing single-owner process makes
    // this commit indivisible without putting revocations behind a verification queue.
    return this.#commit(botId, old.revision, next);
  }
  completeRemoval(botId: string, binding: RemoteRemoval): void {
    const current = this.#load(botId);
    if (
      current.targets.some(
        (target) =>
          target.enabled &&
          target.origin === binding.origin &&
          target.credentialRef === binding.credentialRef,
      )
    )
      throw new RemoteSettingsError("conflict");
    // Persist a legacy capacity denial before freeing space. Later cleanup must
    // not turn the old grants back on merely because they fit again.
    this.#commit(botId, current.revision, {
      ...current,
      blocked: current.blocked || !this.#hasRevocationCapacity(current),
      pendingRemovals: current.pendingRemovals.filter(
        (value) => value.origin !== binding.origin || value.credentialRef !== binding.credentialRef,
      ),
    });
  }
  #commit(
    botId: string,
    expected: string,
    value: StoredRemoteConfiguration,
  ): StoredRemoteConfiguration {
    if (this.#load(botId).revision !== expected) throw new RemoteSettingsError("conflict");
    const next = { ...value, revision: randomUUID() };
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > 65_536 || !fileSchema.safeParse(next).success)
      throw new RemoteSettingsError("unavailable");
    const file = this.#path(botId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    let owned = false;
    try {
      const fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      owned = true;
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, file);
      owned = false;
      const directory = openSync(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      return next;
    } catch {
      throw new RemoteSettingsError("unavailable");
    } finally {
      if (owned) unlinkSync(temporary);
    }
  }
}
