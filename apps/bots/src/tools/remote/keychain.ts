import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { RemoteBinding } from "../../core/domain.ts";

export type RemoteCredential = {
  readonly binding: RemoteBinding;
  readonly ownerToken: string;
  readonly accessClientID?: string;
  readonly accessClientSecret?: string;
};

export class RemoteError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Remote operation ${code}`);
    this.code = code;
  }
}

const identifier = (maximum: number, minimum = 1) =>
  z
    .string()
    .min(minimum)
    .max(maximum)
    .refine((value) => /^[A-Za-z0-9_-]+$/.exec(value)?.[0] === value);
export const remoteOrigin = z
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
export const remoteBinding = z.strictObject({
  namespace: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/),
  botId: identifier(80),
  credentialRef: identifier(120, 8),
  origin: remoteOrigin,
});
const secret = (minimum: number) =>
  z
    .string()
    .refine(
      (value) =>
        Buffer.byteLength(value) >= minimum &&
        Buffer.byteLength(value) <= 8192 &&
        !/[\s\p{Cc}]/u.test(value),
    );
const credentialSchema = z
  .strictObject({
    binding: remoteBinding,
    ownerToken: secret(32),
    accessClientID: secret(1).optional(),
    accessClientSecret: secret(1).optional(),
  })
  .refine(
    (value) => (value.accessClientID === undefined) === (value.accessClientSecret === undefined),
  );

export const parseRemoteCredential = (raw: unknown, binding: RemoteBinding): RemoteCredential => {
  const parsed = credentialSchema.safeParse(raw);
  if (
    !parsed.success ||
    Object.entries(binding).some(
      ([key, value]) => parsed.data.binding[key as keyof RemoteBinding] !== value,
    )
  )
    throw new RemoteError("needs_local");
  return {
    binding: parsed.data.binding,
    ownerToken: parsed.data.ownerToken,
    ...(parsed.data.accessClientID === undefined
      ? {}
      : {
          accessClientID: parsed.data.accessClientID,
          accessClientSecret: parsed.data.accessClientSecret as string,
        }),
  };
};

export const credentialStrings = (credential: RemoteCredential): readonly string[] =>
  [credential.ownerToken, credential.accessClientID, credential.accessClientSecret].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );

export const containsRemoteCredential = (value: unknown, credential: RemoteCredential): boolean => {
  if (typeof value === "string")
    return credentialStrings(credential).some((secret) => value.includes(secret));
  if (Array.isArray(value))
    return value.some((entry) => containsRemoteCredential(entry, credential));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).some(
      ([key, entry]) =>
        containsRemoteCredential(key, credential) || containsRemoteCredential(entry, credential),
    );
  return false;
};

export interface RemoteCredentials {
  read(binding: RemoteBinding, signal?: AbortSignal): Promise<RemoteCredential>;
  status(binding: RemoteBinding, signal?: AbortSignal): Promise<boolean>;
  remove(binding: RemoteBinding, signal?: AbortSignal): Promise<void>;
}

export const createRemoteCredentials = (path: string): RemoteCredentials => {
  const invoke = (
    action: "read" | "status" | "remove",
    binding: RemoteBinding,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (!isAbsolute(path) || !remoteBinding.safeParse(binding).success || signal?.aborted) {
        reject(new RemoteError("needs_local"));
        return;
      }
      const input = JSON.stringify({ action, binding });
      if (Buffer.byteLength(input) > 65_536) {
        reject(new RemoteError("needs_local"));
        return;
      }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(path, [], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        });
      } catch {
        reject(new RemoteError("needs_local"));
        return;
      }
      let done = false;
      let stopping = false;
      let reapDeadline: NodeJS.Timeout | undefined;
      let size = 0;
      const output: Buffer[] = [];
      const finish = (value?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(reapDeadline);
        signal?.removeEventListener("abort", failed);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        if (value === undefined) {
          child.unref();
          reject(new RemoteError("needs_local"));
        } else resolve(value);
      };
      const failed = () => {
        if (done || stopping) return;
        stopping = true;
        clearTimeout(timer);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill("SIGKILL");
        // Confirm normal exits without allowing inherited/stalled pipes to extend
        // the request indefinitely. A fallback is an uncertain failure, never success.
        reapDeadline = setTimeout(() => finish(), 500);
      };
      const timer = setTimeout(failed, 15_000);
      signal?.addEventListener("abort", failed, { once: true });
      child.once("error", failed);
      child.stdin.once("error", failed);
      child.stderr.on("data", () => {});
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65_536) {
          failed();
          return;
        }
        output.push(chunk);
      });
      child.once("close", (code) => {
        if (done) return;
        if (stopping || code !== 0) {
          finish();
          return;
        }
        try {
          finish(
            JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(output))),
          );
        } catch {
          failed();
        }
      });
      child.stdin.end(input);
      if (signal?.aborted) failed();
    });
  return {
    async read(binding, signal) {
      return parseRemoteCredential(await invoke("read", binding, signal), binding);
    },
    async status(binding, signal) {
      const result = z
        .strictObject({ available: z.boolean() })
        .safeParse(await invoke("status", binding, signal));
      if (!result.success) throw new RemoteError("needs_local");
      return result.data.available;
    },
    async remove(binding, signal) {
      const result = z
        .strictObject({ available: z.literal(false) })
        .safeParse(await invoke("remove", binding, signal));
      if (!result.success) throw new RemoteError("needs_local");
    },
  };
};
