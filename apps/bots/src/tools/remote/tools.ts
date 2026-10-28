import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { z } from "zod";
import { REMOTE_OPERATIONS, type RemoteOperationName } from "../../core/domain.ts";
import { RemoteMachineClient } from "./client.ts";
import {
  containsRemoteCredential,
  type RemoteCredentials,
  RemoteError,
  remoteBinding,
} from "./keychain.ts";
import {
  machineId,
  type RemoteAuthority,
  type RemoteDestination,
  type RemoteMessage,
  type RemoteOperation,
  remoteOperation,
} from "./protocol.ts";

export const REMOTE_EXTENSION = "bots-remote";
export type RemoteToolOptions = {
  readonly botId: string;
  /** The existing private daemon token authenticates receipts; never serialized. */
  readonly receiptKey: string;
  readonly read: RemoteAuthority;
  readonly credentials: RemoteCredentials;
};

const receiptSchema = remoteBinding.extend({
  version: z.literal(1),
  alias: z.string().min(1).max(80),
  machineId,
  revision: z.string().min(1).max(80),
  tool: z.enum(REMOTE_OPERATIONS),
  conversationId: z.string().min(1).max(80),
  callId: z.string().min(1).max(256),
  id: z.string().regex(/^br_[a-f0-9]{64}$/),
});
type Receipt = z.infer<typeof receiptSchema>;
const operationId = (value: Omit<Receipt, "id">): string =>
  "br_" +
  createHash("sha256")
    .update(
      JSON.stringify([
        value.version,
        value.namespace,
        value.origin,
        value.machineId,
        value.botId,
        value.conversationId,
        value.callId,
        value.tool,
      ]),
    )
    .digest("hex");
const mac = (payload: string, key: string) =>
  createHmac("sha256", key).update("bots.remote-receipt.v1\0").update(payload).digest();
const encodeReceipt = (value: Receipt, key: string) => {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${mac(payload, key).toString("base64url")}`;
};
const decodeReceipt = (value: string, key: string): Receipt => {
  try {
    if (value.length > 8192) throw new Error();
    const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!parts?.[1] || !parts[2]) throw new Error();
    const tag = Buffer.from(parts[2], "base64url");
    if (tag.length !== 32 || !timingSafeEqual(tag, mac(parts[1], key))) throw new Error();
    const receipt = receiptSchema.parse(
      JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    );
    if (receipt.id !== operationId(receipt)) throw new Error();
    return receipt;
  } catch {
    throw new RemoteError("invalid");
  }
};
const text = (value: unknown, isError = false) => ({
  output: [{ type: "text" as const, text: JSON.stringify(value) }],
  isError,
});
const limits = { maxBytes: 128 * 1024, maxLines: 100_000, retain: "head" as const };
const timeout = Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 }));
const operationParameters = Type.Union([
  Type.Object(
    {
      tool: Type.Literal("command.exec"),
      program: Type.String(),
      args: Type.Array(Type.String()),
      cwd: Type.Optional(Type.String()),
      timeoutMs: timeout,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tool: Type.Union([Type.Literal("file.read"), Type.Literal("file.list")]),
      grantId: Type.String(),
      generation: Type.String(),
      path: Type.String(),
      timeoutMs: timeout,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tool: Type.Literal("herdr.setup"),
      action: Type.Union([Type.Literal("probe"), Type.Literal("install"), Type.Literal("verify")]),
      timeoutMs: timeout,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tool: Type.Literal("herdr.setup"),
      action: Type.Union([Type.Literal("configure"), Type.Literal("create_session")]),
      session: Type.String(),
      enabled: Type.Boolean(),
      expectedRevision: Type.String(),
      timeoutMs: timeout,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tool: Type.Literal("herdr.setup"),
      action: Type.Literal("disable"),
      expectedRevision: Type.String(),
      timeoutMs: timeout,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tool: Type.Literal("herdr.inspect"),
      action: Type.Union([
        Type.Literal("agents"),
        Type.Literal("workspaces"),
        Type.Literal("panes"),
      ]),
      session: Type.String(),
      expectedRevision: Type.String(),
      timeoutMs: timeout,
    },
    { additionalProperties: false },
  ),
]);

export const remoteExtension = (options: RemoteToolOptions) => {
  if (typeof options.receiptKey !== "string" || Buffer.byteLength(options.receiptKey) < 32)
    throw new RemoteError("needs_local");
  const encode = (receipt: Receipt) => encodeReceipt(receipt, options.receiptKey);
  const failure = (error: unknown, receipt?: Receipt) =>
    text(
      {
        error:
          error instanceof RemoteError
            ? error.code
            : error instanceof z.ZodError
              ? "invalid"
              : "unavailable",
        ...(receipt === undefined ? {} : { receipt: encode(receipt), operationId: receipt.id }),
      },
      true,
    );
  const client = new RemoteMachineClient(options.credentials);
  const resolve = (alias: string, tool?: RemoteOperationName): RemoteDestination => {
    const configuration = options.read();
    const target = configuration.targets.find((value) => value.alias === alias && value.enabled);
    if (!target || (tool !== undefined && !target.operations.includes(tool)))
      throw new RemoteError("denied");
    return {
      namespace: configuration.namespace,
      botId: options.botId,
      revision: configuration.revision,
      target,
    };
  };
  const authorize = (receipt: Receipt): RemoteDestination => {
    if (receipt.botId !== options.botId || receipt.id !== operationId(receipt))
      throw new RemoteError("denied");
    const current = resolve(receipt.alias, receipt.tool);
    if (
      current.namespace !== receipt.namespace ||
      current.revision !== receipt.revision ||
      current.target.origin !== receipt.origin ||
      current.target.machineId !== receipt.machineId ||
      current.target.credentialRef !== receipt.credentialRef
    )
      throw new RemoteError("denied");
    return current;
  };
  const dispatch = async (
    receipt: Receipt,
    operation: RemoteOperation,
    resumed: boolean,
    signal?: AbortSignal,
  ): Promise<RemoteMessage> => {
    const query = () =>
      client.request(
        authorize(receipt),
        { type: "get", operationId: receipt.id },
        () => {
          authorize(receipt);
        },
        signal,
      );
    // A persisted memo cannot tell never-admitted from a lost/replaced journal.
    // Replays only query; not_found retains the receipt for explicit inspection.
    if (resumed) return query();
    try {
      return await client.request(
        authorize(receipt),
        { type: "run", operation: { ...operation, id: receipt.id, machineId: receipt.machineId } },
        () => {
          authorize(receipt);
        },
        signal,
      );
    } catch (error) {
      if (
        !signal?.aborted &&
        error instanceof RemoteError &&
        ["offline", "unknown"].includes(error.code)
      )
        return query();
      throw error;
    }
  };
  return defineExtension({
    name: REMOTE_EXTENSION,
    sections: [
      section(
        "bots-remote",
        () =>
          "Remote machine tools are deferred. Use tool_search for remote, then remote_status to list saved target aliases and inspect actual capabilities. Machine access is separate from local coding tools. Use remote_execute for a new operation, preserve its receipt, and remote_operation to query/cancel that same operation. Unknown does not mean failure; never repeat a side effect with a new call to guess its outcome. Herdr setup needs an explicit target and session; no HERDR_ENV is required.",
      ),
    ],
    tools: [
      defineTool({
        name: "remote_status",
        description:
          "List this Bot's authorized remote target aliases, or fetch real capabilities for one saved target. No installation or command is performed.",
        parameters: Type.Object(
          { target: Type.Optional(Type.String({ maxLength: 80 })) },
          { additionalProperties: false },
        ),
        replay: "safe",
        deferred: true,
        outputLimits: limits,
        execute: async (args, _api, context) => {
          try {
            if (args.target === undefined)
              return text({
                targets: options
                  .read()
                  .targets.filter((target) => target.enabled)
                  .map(({ alias, machineId, operations }) => ({ alias, machineId, operations })),
              });
            const target = resolve(args.target);
            const check = () => {
              const current = resolve(args.target as string);
              if (JSON.stringify(current) !== JSON.stringify(target))
                throw new RemoteError("denied");
            };
            return text(
              await client.request(target, { type: "status" }, check, context.abortSignal),
            );
          } catch (error) {
            return failure(error);
          }
        },
      }),
      defineTool({
        name: "remote_execute",
        description:
          "Execute one bounded command, authorized file read/list or fixed Herdr setup/inspection on a saved machine. Use capabilities for grant generations and Herdr revision/session. Returns a durable operation receipt; unknown/running must be queried rather than recreated.",
        parameters: Type.Object(
          { target: Type.String({ maxLength: 80 }), operation: operationParameters },
          { additionalProperties: false },
        ),
        replay: "safe",
        deferred: true,
        outputLimits: limits,
        execute: async (args, api, context) => {
          let receipt: Receipt | undefined;
          try {
            const operation = remoteOperation.parse(args.operation);
            const saved = await api.memo<Receipt>("remote-operation-v1", context);
            if (saved !== undefined) receipt = receiptSchema.parse(saved);
            else {
              const current = resolve(args.target, operation.tool);
              const binding = {
                namespace: current.namespace,
                botId: options.botId,
                credentialRef: current.target.credentialRef,
                origin: current.target.origin,
              };
              const credential = await options.credentials.read(binding, context.abortSignal);
              if (
                containsRemoteCredential(args, credential) ||
                containsRemoteCredential(current, credential)
              )
                throw new RemoteError("denied");
              const identity = {
                ...binding,
                version: 1 as const,
                alias: current.target.alias,
                machineId: current.target.machineId,
                revision: current.revision,
                tool: operation.tool,
                conversationId: String(api.conversationId),
                callId: api.callId,
              };
              const candidate = { ...identity, id: operationId(identity) };
              authorize(candidate);
              receipt = await api.memo("remote-operation-v1", candidate, context);
            }
            if (receipt.alias !== args.target || receipt.tool !== operation.tool)
              throw new RemoteError("conflict");
            const result = await dispatch(
              receipt,
              operation,
              saved !== undefined,
              context.abortSignal,
            );
            authorize(receipt);
            return text(
              { receipt: encode(receipt), operationId: receipt.id, result },
              result.type === "result" &&
                ["failed", "cancelled", "unknown"].includes(result.operation.state),
            );
          } catch (error) {
            return failure(error, receipt);
          }
        },
      }),
      defineTool({
        name: "remote_operation",
        description:
          "Query or explicitly cancel the original remote operation using its exact receipt. Does not start or replay an operation. A revoked/rebound grant is refused.",
        parameters: Type.Object(
          {
            receipt: Type.String({ maxLength: 8192 }),
            action: Type.Union([Type.Literal("get"), Type.Literal("cancel")]),
          },
          { additionalProperties: false },
        ),
        replay: "safe",
        deferred: true,
        outputLimits: limits,
        execute: async (args, _api, context) => {
          let receipt: Receipt | undefined;
          try {
            receipt = decodeReceipt(args.receipt, options.receiptKey);
            const reference = receipt;
            const result = await client.request(
              authorize(reference),
              { type: args.action, operationId: reference.id },
              () => {
                authorize(reference);
              },
              context.abortSignal,
            );
            return text({ receipt: encode(reference), operationId: reference.id, result });
          } catch (error) {
            return failure(error, receipt);
          }
        },
      }),
    ],
  });
};
