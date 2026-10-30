import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  AgentDoc,
  type AgentState,
  type ConversationId,
  type Cursor,
  defineDoc,
  defineDocFamily,
  type EntryDraft,
  type EntryId,
  type EntryRecord,
  type Harness,
  type Registry,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { ClassifiedFailure } from "../../core/domain.ts";
import {
  INVOCATION_ID,
  MAX_INVOCATION_TEXT,
  MAX_REPLICA_BODY_BYTES,
  type RuntimeHandle,
} from "../../core/RuntimePort.ts";
import { FailureClassifier } from "./classify.ts";
import { historyMessage } from "./historyMessages.ts";
import { convertSubmission } from "./mapEvents.ts";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestIdSchema = z.string().regex(INVOCATION_ID);
const entrySchema = z.strictObject({
  id,
  conversationId: id,
  byTaskId: id.optional(),
  kind: z.string().min(1),
  model: z.array(historyMessage).optional(),
  data: z.json().optional(),
  head: id.optional(),
  edits: z
    .array(
      z.discriminatedUnion("action", [
        z.strictObject({ target: id, action: z.literal("omit") }),
        z.strictObject({
          target: id,
          action: z.literal("replace"),
          messages: z.array(historyMessage),
        }),
      ]),
    )
    .optional(),
});
const agentSchema = z.strictObject({
  model: z.strictObject({ provider: z.string(), modelId: z.string() }).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  extensions: z
    .union([
      z.array(z.string()),
      z.strictObject({
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      }),
    ])
    .optional(),
  tools: z.union([z.array(z.string()), z.strictObject({ remove: z.array(z.string()) })]).optional(),
  modelTools: z
    .union([
      z.array(z.string()),
      z.strictObject({
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      }),
    ])
    .optional(),
  instructions: z.string().optional(),
  cwd: z.string().optional(),
});
export const resourceSchema = z.strictObject({
  name: z.string().min(1).max(4096),
  kind: z.enum(["attachment", "instructions", "skill"]),
  sha256: digest,
  base64: z.string(),
});
const originSchema = z.strictObject({
  replicaId: z.uuid(),
  conversationId: id,
  entryId: id,
  taskId: id.optional(),
});
const payloadSchema = z.strictObject({
  version: z.literal(1),
  engine: z.literal("pi-durable@1.4.0"),
  source: z.strictObject({ replicaId: z.uuid(), botId: z.string().min(1), conversationId: id }),
  parents: z.array(digest),
  entries: z.array(entrySchema).min(1),
  origins: z.record(z.string(), originSchema),
  agent: agentSchema,
  resources: z.array(resourceSchema),
});
export const bundleSchema = payloadSchema.extend({ head: digest });
export type HistoryBundle = z.infer<typeof bundleSchema>;

const identity = defineDoc({
  kind: "bots.replica.identity",
  version: 1,
  scope: "session",
  initial: () => ({ replicaId: randomUUID() }),
  checkpointWhen: () => true,
});
const imports = defineDocFamily({
  kind: "bots.replica.import",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ bundle: "", conversationId: 0, entries: {} as Record<string, number> }),
  checkpointWhen: () => true,
});
const runs = defineDocFamily({
  kind: "bots.replica.run",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ head: "", text: "", conversationId: 0 }),
  checkpointWhen: () => true,
});

/** SDK prompt sections use object insertion order, so sorting JSON changes history semantics. */
export const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const reject = (message: string): never => {
  throw new ClassifiedFailure(
    new FailureClassifier().classify("replica:preflight", "invalid_command", "runtime")
      .classification.failure,
    "not_admitted",
    message,
  );
};
const parsed = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  return result.success ? result.data : reject("invalid replica request");
};

export const validateBundle = (value: unknown): HistoryBundle => {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_REPLICA_BODY_BYTES - 32)
    reject("history exceeds local handoff limit");
  const bundle = parsed(bundleSchema, value);
  const { head, ...payload } = bundle;
  if (hash(payload) !== head) reject("history digest mismatch");
  const seen = new Set<number>();
  let previous = 0;
  for (const entry of bundle.entries) {
    if (entry.id <= previous || seen.has(entry.id)) reject("unordered history");
    if (entry.head !== undefined && entry.head !== entry.id && !seen.has(entry.head))
      reject("missing head dependency");
    if (entry.edits?.some((edit) => !seen.has(edit.target))) reject("missing edit dependency");
    if (bundle.origins[String(entry.id)] === undefined) reject("missing entry origin");
    seen.add(entry.id);
    previous = entry.id;
  }
  if (
    Object.keys(bundle.origins).some((key) => !seen.has(Number(key))) ||
    Object.keys(bundle.origins).length !== seen.size
  )
    reject("missing entry for original provenance");
  for (const resource of bundle.resources) {
    const bytes = Buffer.from(resource.base64, "base64");
    if (
      bytes.toString("base64") !== resource.base64 ||
      createHash("sha256").update(bytes).digest("hex") !== resource.sha256
    )
      reject("invalid resource bytes");
  }
  return bundle;
};

/** Public SDK commits only: imported entries cannot create a submission or a task. */
export class HistoryReplica {
  readonly #harness: Harness;
  readonly #rootId: ConversationId;
  readonly #botId: string;
  readonly #cwd: string;
  readonly #registry: Registry;

  constructor(
    harness: Harness,
    rootId: ConversationId,
    botId: string,
    cwd: string,
    registry: Registry,
  ) {
    this.#harness = harness;
    this.#rootId = rootId;
    this.#botId = botId;
    this.#cwd = cwd;
    this.#registry = registry;
  }

  async command(command: Parameters<NonNullable<RuntimeHandle["replica"]>>[0]): Promise<unknown> {
    switch (command.method) {
      case "import": {
        const { bundle } = parsed(z.strictObject({ bundle: z.unknown() }), command.params);
        return this.#import(validateBundle(bundle));
      }
      case "export":
        return this.#export(command.params);
      case "run":
        return this.#run(command.params);
      case "status": {
        const { requestId } = parsed(
          z.strictObject({ requestId: requestIdSchema }),
          command.params,
        );
        const run = await this.#harness.snapshot(runs, hash(requestId), ctx);
        if (run === undefined || run.conversationId === 0) return { submission: null };
        const record = await this.#harness.commit(
          (tx) => tx.submissionByRequest(run.conversationId as ConversationId, requestId),
          ctx,
        );
        return {
          branch: requestId,
          submission: record === undefined ? null : convertSubmission(record),
        };
      }
    }
  }

  async #import(bundle: HistoryBundle): Promise<{ head: string }> {
    await this.#harness.commit(async (tx) => {
      const receipt = await tx.doc(imports, bundle.head, null);
      if (receipt.conversationId !== 0) return;
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      Object.assign(await tx.doc(AgentDoc, conversation.id), bundle.agent);
      for (const original of bundle.entries) {
        const { id: sourceId, head, edits } = original;
        const draft: EntryDraft = {
          kind: original.kind,
          ...(original.model === undefined ? {} : { model: original.model }),
          ...(original.data === undefined ? {} : { data: original.data }),
          ...(head === undefined
            ? {}
            : { head: head === sourceId ? "self" : (receipt.entries[String(head)] as EntryId) }),
          ...(edits === undefined
            ? {}
            : {
                edits: edits.map((edit) => ({
                  ...edit,
                  target: receipt.entries[String(edit.target)] as EntryId,
                })),
              }),
        };
        const mapped = await tx.appendEntry(conversation.id, draft);
        receipt.entries[String(sourceId)] = mapped.id;
      }
      receipt.conversationId = conversation.id;
      receipt.bundle = JSON.stringify(bundle);
    }, ctx);
    return { head: bundle.head };
  }

  async #export(params: unknown): Promise<HistoryBundle> {
    const input = parsed(
      z.strictObject({
        head: digest.optional(),
        branch: requestIdSchema.optional(),
        resources: z.array(resourceSchema).optional(),
      }),
      params,
    );
    if (input.head !== undefined) {
      if (input.branch !== undefined || input.resources !== undefined)
        reject("select one immutable head");
      const receipt = await this.#harness.snapshot(imports, input.head, ctx);
      return receipt?.bundle
        ? validateBundle(JSON.parse(receipt.bundle))
        : reject("unknown history head");
    }
    const run =
      input.branch === undefined
        ? undefined
        : await this.#harness.snapshot(runs, hash(input.branch), ctx);
    if (input.branch !== undefined && (run === undefined || run.conversationId === 0))
      reject("unknown local branch");
    const inherited =
      run === undefined ? undefined : await this.#harness.snapshot(imports, run.head, ctx);
    const parent = inherited?.bundle ? validateBundle(JSON.parse(inherited.bundle)) : undefined;
    const conversationId = (run?.conversationId ?? this.#rootId) as ConversationId;
    const payload = await this.#harness.commit(async (tx) => {
      let cursor: Cursor | undefined;
      let ancestor: ConversationId | undefined = conversationId;
      while (ancestor !== undefined) {
        do {
          const page = await tx.scanTasks({ conversationId: ancestor }, 128, cursor);
          if (page.items.some((task) => task.state.status !== "terminal"))
            reject("history is not a complete head");
          if (
            page.items.some(
              (task) =>
                task.kind === "pi.tool" &&
                task.input !== null &&
                typeof task.input === "object" &&
                !Array.isArray(task.input) &&
                task.input.kind === "nested",
            )
          )
            reject("nested tool results are unsupported by P0 history export");
          cursor = page.next;
        } while (cursor !== undefined);
        ancestor = (await tx.conversation(ancestor))?.parent?.conversationId;
      }
      const entries: EntryRecord[] = [];
      let bytes = 0;
      do {
        const page = await tx.scanEntries({ conversationId, order: "ascending" }, 128, cursor);
        bytes += Buffer.byteLength(JSON.stringify(page.items));
        if (bytes > MAX_REPLICA_BODY_BYTES - 32) reject("history exceeds local handoff limit");
        entries.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined);
      if (entries.length === 0) reject("history is empty");
      const source = await tx.doc(identity);
      const agent = JSON.parse(
        JSON.stringify(await tx.doc(AgentDoc, conversationId)),
      ) as AgentState;
      const origins: HistoryBundle["origins"] = {};
      const originalIds = new Map(
        Object.entries(inherited?.entries ?? {}).map(([original, local]) => [local, original]),
      );
      for (const entry of entries) {
        const originalId = originalIds.get(entry.id);
        origins[String(entry.id)] =
          originalId === undefined
            ? {
                replicaId: source.replicaId,
                conversationId: entry.conversationId,
                entryId: entry.id,
                ...(entry.byTaskId === undefined ? {} : { taskId: entry.byTaskId }),
              }
            : (parent?.origins[originalId] ?? reject("missing original provenance"));
      }
      return parsed(payloadSchema, {
        version: 1,
        engine: "pi-durable@1.4.0",
        source: { replicaId: source.replicaId, botId: this.#botId, conversationId },
        parents: run === undefined ? [] : [run.head],
        entries,
        origins,
        agent,
        resources: input.resources ?? parent?.resources ?? [],
      });
    }, ctx);
    const bundle = validateBundle({ ...payload, head: hash(payload) });
    // Pin it before replying: a lost response or process exit can re-export the same head.
    await this.#import(bundle);
    return bundle;
  }

  async #run(params: unknown): Promise<unknown> {
    const input = parsed(
      z.strictObject({
        head: digest,
        requestId: requestIdSchema,
        text: z
          .string()
          .min(1)
          .refine((value) => Array.from(value).length <= MAX_INVOCATION_TEXT),
      }),
      params,
    );
    const receipt = await this.#harness.snapshot(imports, input.head, ctx);
    if (receipt === undefined || receipt.conversationId === 0)
      return reject("unknown history head");
    const bundle = validateBundle(JSON.parse(receipt.bundle));
    if (bundle.resources.some((resource) => resource.kind !== "attachment"))
      reject("history resources require installation before continuation");
    const installed = new Set(
      this.#registry
        .snapshot()
        .installed()
        .map((extension) => extension.name),
    );
    const selected = bundle.agent.extensions;
    const required = Array.isArray(selected) ? selected : (selected?.add ?? []);
    if (required.some((name) => !installed.has(name)))
      reject("history requires unavailable extensions");
    const conversationId = await this.#harness.commit(async (tx) => {
      const run = await tx.doc(runs, hash(input.requestId), null);
      if (run.conversationId !== 0) {
        if (run.head !== input.head || run.text !== input.text) reject("run request id conflict");
        return run.conversationId as ConversationId;
      }
      const tail = bundle.entries.at(-1);
      const at = receipt.entries[String(tail?.id)] as EntryId;
      const branch = await tx.forkConversation(receipt.conversationId as ConversationId, at, {
        ownership: { kind: "ownerless" },
      });
      (await tx.doc(AgentDoc, branch.id)).cwd = this.#cwd;
      run.head = input.head;
      run.text = input.text;
      run.conversationId = branch.id;
      return branch.id;
    }, ctx);
    const conversation = await this.#harness.conversation(conversationId, ctx);
    if (conversation === undefined) return reject("missing local branch");
    // The durable fork intent precedes submit; retry after a crash uses this same branch/key.
    const submission = await conversation.submit(
      { type: "input", content: input.text, requestId: input.requestId, whenBusy: "reject" },
      ctx,
    );
    return { branch: input.requestId, submission: convertSubmission(await submission.status(ctx)) };
  }
}
