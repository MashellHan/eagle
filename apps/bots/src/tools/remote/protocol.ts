// Version-1 remote wire adapter. Bots imports no Eagle implementation or schema.
import { z } from "zod";
import type { RemoteConfiguration, RemoteTarget } from "../../core/domain.ts";

const id = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);
export const machineId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const session = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const revision = id(64);
export const remoteOperation = z.union([
  z.strictObject({
    tool: z.literal("command.exec"),
    program: z.string().min(1).max(4096),
    args: z.array(z.string().max(8192)).max(128),
    cwd: z.string().min(1).max(4096).optional(),
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
  }),
  z.strictObject({
    tool: z.enum(["file.read", "file.list"]),
    grantId: id(80),
    generation: id(128),
    path: z.string().min(1).max(4096),
    timeoutMs: z.number().int().min(1).max(5000).optional(),
  }),
  z.strictObject({
    tool: z.literal("herdr.setup"),
    action: z.enum(["probe", "install", "verify"]),
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
  }),
  z.strictObject({
    tool: z.literal("herdr.setup"),
    action: z.enum(["configure", "create_session"]),
    session,
    enabled: z.boolean(),
    expectedRevision: revision,
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
  }),
  z.strictObject({
    tool: z.literal("herdr.setup"),
    action: z.literal("disable"),
    expectedRevision: revision,
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
  }),
  z.strictObject({
    tool: z.literal("herdr.inspect"),
    action: z.enum(["agents", "workspaces", "panes"]),
    session,
    expectedRevision: revision,
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
  }),
]);
export type RemoteOperation = z.infer<typeof remoteOperation>;
export type RemoteDestination = {
  readonly namespace: string;
  readonly botId: string;
  readonly revision: string;
  readonly target: RemoteTarget;
};
export type RemoteAuthority = () => RemoteConfiguration;
export type RemoteRequest =
  | { readonly type: "status" }
  | {
      readonly type: "run";
      readonly operation: RemoteOperation & { readonly id: string; readonly machineId: string };
    }
  | { readonly type: "get" | "cancel"; readonly operationId: string };
export const remoteRecord = z
  .strictObject({
    id: id(120),
    state: z.enum(["running", "succeeded", "failed", "cancelled", "unknown"]),
    stdout: z.string().max(65_536),
    stderr: z.string().max(65_536),
    exitCode: z.number().int().min(0).max(255).nullable(),
  })
  .refine(
    (value) =>
      Buffer.byteLength(value.stdout + value.stderr) <= 65_536 &&
      (value.state !== "succeeded" || value.exitCode === null || value.exitCode === 0) &&
      (!["running", "cancelled", "unknown"].includes(value.state) || value.exitCode === null),
  );
export const remoteStatus = z.strictObject({
  type: z.literal("status"),
  machineId,
  online: z.boolean(),
  observedAt: z.string().datetime().nullable(),
  agentVersion: z.string().min(1).max(80).nullable(),
  capabilities: z
    .strictObject({
      commands: z.boolean(),
      files: z
        .strictObject({
          state: z.enum(["ready", "unknown"]),
          grants: z
            .array(
              z.strictObject({
                id: id(80),
                generation: z.string().max(128),
                name: z.string().min(1).max(120),
                available: z.boolean(),
              }),
            )
            .max(32),
        })
        .optional(),
      herdr: z
        .strictObject({
          state: z.enum([
            "unknown",
            "not_installed",
            "disabled",
            "needs_local_setup",
            "unavailable",
            "ready",
          ]),
          installed: z.boolean().nullable(),
          version: z.string().max(80).nullable(),
          enabled: z.boolean(),
          session: session.nullable(),
          revision,
          sessions: z.array(z.strictObject({ name: session, running: z.boolean() })).max(64),
          checks: z.strictObject({
            cli: z.boolean().nullable(),
            server: z.boolean().nullable(),
            session: z.boolean().nullable(),
            tools: z.boolean().nullable(),
          }),
          observedAt: z.string().datetime().nullable(),
        })
        .optional(),
    })
    .nullable(),
});
export const remoteMessage = z.union([
  remoteStatus,
  z.strictObject({ type: z.literal("pong") }),
  z.strictObject({ type: z.literal("result"), requestId: id(64), operation: remoteRecord }),
  z.strictObject({
    type: z.literal("cancel-ack"),
    requestId: id(64),
    operationId: id(120),
    requested: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("error"),
    requestId: id(64),
    operationId: id(120),
    code: z.enum([
      "offline",
      "not_found",
      "disabled",
      "busy",
      "conflict",
      "invalid",
      "unavailable",
      "denied",
    ]),
  }),
]);
export type RemoteMessage = z.infer<typeof remoteMessage>;
export type RemoteRecord = z.infer<typeof remoteRecord>;
