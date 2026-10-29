import { z } from "zod";

export const EXECUTION_MESSAGE_BYTES = 512 * 1024;
export const ExecutionMachineId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
const operationId = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const clientId = z.string().uuid();
export const FileCapabilitiesSchema = z.strictObject({
  state: z.enum(["ready", "unknown"]),
  grants: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
        generation: z.string().max(128),
        name: z.string().min(1).max(120),
        available: z.boolean(),
      }),
    )
    .max(32),
});
const herdrSession = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const herdrRevision = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const HerdrStatusSchema = z.strictObject({
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
  session: herdrSession.nullable(),
  revision: herdrRevision,
  sessions: z
    .array(z.strictObject({ name: herdrSession, running: z.boolean() }))
    .max(64),
  checks: z.strictObject({
    cli: z.boolean().nullable(),
    server: z.boolean().nullable(),
    session: z.boolean().nullable(),
    tools: z.boolean().nullable(),
  }),
  observedAt: z.string().datetime().nullable(),
});
export type HerdrStatus = z.infer<typeof HerdrStatusSchema>;
const herdrProbe = z.strictObject({
  tool: z.literal("herdr.setup"),
  action: z.enum(["probe", "install", "verify"]),
});
const herdrConfigure = z.strictObject({
  tool: z.literal("herdr.setup"),
  action: z.enum(["configure", "create_session"]),
  session: herdrSession,
  enabled: z.boolean(),
  expectedRevision: herdrRevision,
});
const herdrDisable = z.strictObject({
  tool: z.literal("herdr.setup"),
  action: z.literal("disable"),
  expectedRevision: herdrRevision,
});
const herdrInspect = z.strictObject({
  tool: z.literal("herdr.inspect"),
  action: z.enum(["agents", "workspaces", "panes"]),
  session: herdrSession,
  expectedRevision: herdrRevision,
});
export const HerdrRequestSchema = z.union([
  herdrProbe,
  herdrConfigure,
  herdrDisable,
  herdrInspect,
]);
export type HerdrRequest = z.infer<typeof HerdrRequestSchema>;
export const ExecutionCapabilitiesSchema = z.strictObject({
  commands: z.boolean(),
  files: FileCapabilitiesSchema.optional(),
  herdr: HerdrStatusSchema.optional(),
});
export type ExecutionCapabilities = z.infer<typeof ExecutionCapabilitiesSchema>;
export const ExecutionStatusSchema = z.strictObject({
  machineId: ExecutionMachineId,
  online: z.boolean(),
  observedAt: z.string().datetime().nullable(),
  agentVersion: z.string().min(1).max(80).nullable(),
  capabilities: ExecutionCapabilitiesSchema.nullable(),
});
const commandOperation = z.strictObject({
  id: operationId,
  machineId: ExecutionMachineId,
  tool: z.literal("command.exec"),
  program: z.string().min(1).max(4096),
  args: z.array(z.string().max(8192)).max(128),
  cwd: z.string().min(1).max(4096).optional(),
  timeoutMs: z.number().int().min(1).max(120_000).optional(),
});
const fileOperation = z.strictObject({
  id: operationId,
  machineId: ExecutionMachineId,
  tool: z.enum(["file.read", "file.list"]),
  grantId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  generation: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  path: z.string().min(1).max(4096),
  timeoutMs: z.number().int().min(1).max(5000).optional(),
});
const herdrIdentity = {
  id: operationId,
  machineId: ExecutionMachineId,
  timeoutMs: z.number().int().min(1).max(120_000).optional(),
};
export const ExecutionOperationSchema = z.union([
  commandOperation,
  fileOperation,
  herdrProbe.extend(herdrIdentity),
  herdrConfigure.extend(herdrIdentity),
  herdrDisable.extend(herdrIdentity),
  herdrInspect.extend(herdrIdentity),
]);
export type ExecutionOperation = z.infer<typeof ExecutionOperationSchema>;
export function executionTimeoutMs(operation: ExecutionOperation): number {
  return (
    operation.timeoutMs ??
    (operation.tool === "file.read" || operation.tool === "file.list"
      ? 5000
      : operation.tool === "herdr.setup" && operation.action === "install"
        ? 120_000
        : operation.tool === "herdr.setup" || operation.tool === "herdr.inspect"
          ? 15_000
          : 30_000)
  );
}
export const ExecutionRecordSchema = z
  .strictObject({
    id: operationId,
    state: z.enum(["running", "succeeded", "failed", "cancelled", "unknown"]),
    stdout: z.string().max(65_536),
    stderr: z.string().max(65_536),
    exitCode: z.number().int().min(0).max(255).nullable(),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(value.stdout + value.stderr).length <= 65_536 &&
      (value.state !== "succeeded" ||
        value.exitCode === 0 ||
        value.exitCode === null) &&
      (!["running", "cancelled", "unknown"].includes(value.state) ||
        value.exitCode === null),
  );
const run = z.strictObject({
  type: z.literal("run"),
  requestId,
  operation: ExecutionOperationSchema,
});
const query = z.strictObject({
  type: z.enum(["get", "cancel"]),
  requestId,
  operationId,
});
export const ExecutionRequestSchema = z.union([run, query]);
export const ExecutionViewerMessageSchema = z.union([
  run,
  query,
  z.strictObject({ type: z.literal("ping") }),
]);
export const ExecutionBridgeMessageSchema = z.union([
  run.extend({ clientId }),
  query.extend({ clientId }),
  z.strictObject({ type: z.literal("pong") }),
]);
const result = z.strictObject({
  type: z.literal("result"),
  clientId,
  requestId,
  operation: ExecutionRecordSchema,
});
const error = z.strictObject({
  type: z.literal("error"),
  clientId,
  requestId,
  operationId,
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
});
const cancel = z.strictObject({
  type: z.literal("cancel-ack"),
  clientId,
  requestId,
  operationId,
  requested: z.boolean(),
});
export const ExecutionResponseSchema = z.union([result, error, cancel]);
export const ExecutionServerMessageSchema = z.union([
  result.omit({ clientId: true }),
  error.omit({ clientId: true }),
  cancel.omit({ clientId: true }),
  ExecutionStatusSchema.extend({ type: z.literal("status") }),
  z.strictObject({ type: z.literal("pong") }),
]);
export const ExecutionHelloSchema = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: z.literal(1),
  machineId: ExecutionMachineId,
  instanceId: z.string().uuid(),
  agentVersion: z.string().min(1).max(80),
  capabilities: ExecutionCapabilitiesSchema,
});
export const ExecutionAgentMessageSchema = z.union([
  ExecutionHelloSchema,
  result,
  error,
  cancel,
  z.strictObject({ type: z.literal("ping") }),
]);
export type ExecutionResponse = z.infer<typeof ExecutionResponseSchema>;
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;
export type ExecutionHello = z.infer<typeof ExecutionHelloSchema>;
export type ExecutionServerMessage = z.infer<
  typeof ExecutionServerMessageSchema
>;
