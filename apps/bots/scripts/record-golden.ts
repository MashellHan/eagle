// Records golden pi event sequences (docs/bots/TESTING.md, "Golden fixtures").
//
// Each scenario runs a real Harness over `MemoryStorage` with pi-ai's faux provider,
// captures every `AgentEvent` batch, and writes it to test/runtime/golden/<name>.json.
// `--write` fills the `expected` section with the daemon's own mapping; review the diff
// before committing it, because that section is the regression baseline from then on.
//
//   node --experimental-strip-types scripts/record-golden.ts [--write] [name...]

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { type AgentEvent, createRegistry, Harness, watchEvents } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createEventMapper } from "../src/runtime/pi/mapEvents.ts";

const context = BACKGROUND_CONTEXT;
const LONG_ANSWER =
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega " +
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega";

const LONG_ANSWER_TWO =
  "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen" +
  " seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four";

const goldenDir = new URL("../test/runtime/golden/", import.meta.url).pathname;

type Scenario = {
  readonly name: string;
  readonly description: string;
  readonly settings?: Record<string, unknown>;
  readonly options?: Record<string, unknown>;
  readonly run: (session: Session) => Promise<void>;
};

type Session = {
  readonly harness: Harness;
  readonly root: Awaited<ReturnType<Harness["root"]>>;
  readonly faux: ReturnType<typeof fauxProvider>;
  readonly events: AgentEvent[][];
};

const scenarios: readonly Scenario[] = [
  {
    name: "plain-answer",
    description: "one turn, no message_update: message_start carries the whole answer",
    async run({ root, events }) {
      const submission = await root.submit(
        { type: "input", content: "巴黎是哪个国家的首都？", requestId: "r_0000001" },
        context,
      );
      await submission.wait(context);
      events.push([]);
    },
  },
  {
    name: "partial-start",
    description:
      "message_start carries the partial content the first commit had already accumulated",
    options: { tokensPerSecond: 60, tokenSize: { min: 2, max: 3 } },
    async run({ root, faux }) {
      faux.setResponses([fauxAssistantMessage(LONG_ANSWER)]);
      const submission = await root.submit(
        { type: "input", content: "慢慢地数", requestId: "r_0000011" },
        context,
      );
      await submission.wait(context);
    },
  },
  {
    name: "answer-with-deltas",
    description: "one turn with progress commits, so message_update carries relative changes",
    options: { tokensPerSecond: 200, tokenSize: { min: 2, max: 3 } },
    settings: { progress: { partialIntervalMs: 10 } },
    async run({ root, faux }) {
      faux.setResponses([fauxAssistantMessage(LONG_ANSWER)]);
      const submission = await root.submit(
        { type: "input", content: "数一下 alpha 到 theta", requestId: "r_0000002" },
        context,
      );
      await submission.wait(context);
    },
  },
  {
    name: "retry-in-turn",
    description: "a failed attempt is retried inside one turn; the retry gets a new attempt id",
    options: { tokensPerSecond: 40 },
    async run({ root, faux }) {
      faux.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }),
        fauxAssistantMessage("第二次就成功了。"),
      ]);
      const submission = await root.submit(
        { type: "input", content: "重试一次", requestId: "r_0000003" },
        context,
      );
      await submission.wait(context);
    },
  },
  {
    name: "tool-call",
    description: "the model asks for an unregistered tool: an error result, and the run continues",
    async run({ root, faux }) {
      faux.setResponses([
        fauxAssistantMessage([fauxText("我查一下。"), fauxToolCall("search", { q: "paris" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("没有这个工具，我直接回答。"),
      ]);
      const submission = await root.submit(
        { type: "input", content: "搜索一下", requestId: "r_0000004" },
        context,
      );
      await submission.wait(context);
    },
  },
  {
    name: "two-text-blocks",
    description: "two text blocks receive deltas at their own content indexes",
    options: { tokensPerSecond: 200, tokenSize: { min: 2, max: 3 } },
    settings: { progress: { partialIntervalMs: 10 } },
    async run({ root, faux }) {
      faux.setResponses([fauxAssistantMessage([fauxText(LONG_ANSWER), fauxText(LONG_ANSWER_TWO)])]);
      const submission = await root.submit(
        { type: "input", content: "分成两段回答", requestId: "r_0000010" },
        context,
      );
      await submission.wait(context);
    },
  },
  {
    name: "abort-with-queued",
    description: "abort while running settles the running input and the queued one",
    options: { tokensPerSecond: 60, tokenSize: { min: 2, max: 3 } },
    settings: { progress: { partialIntervalMs: 10 } },
    async run({ root, faux }) {
      faux.setResponses([fauxAssistantMessage(LONG_ANSWER)]);
      const running = await root.submit(
        { type: "input", content: "第一个问题", requestId: "r_0000005" },
        context,
      );
      const queued = await root.submit(
        { type: "input", content: "排队的问题", whenBusy: "followUp", requestId: "r_0000006" },
        context,
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
      await root.abort(context);
      await running.wait(context);
      await queued.wait(context);
    },
  },
  {
    name: "provider-error",
    description: "a provider error settles the input unanswered with reason model_error",
    async run({ root, faux }) {
      faux.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 500" }),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 500" }),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 500" }),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 500" }),
      ]);
      const submission = await root.submit(
        { type: "input", content: "会失败的问题", requestId: "r_0000007" },
        context,
      );
      await submission.wait(context);
    },
  },
  {
    name: "deferred-poll",
    description: "a deferred response commits no assistant entry; the poll then answers",
    options: { deferred: { pendingFetches: 1, pollAfterMs: 5 } },
    settings: { stream: { deferred: true } },
    async run({ root, faux }) {
      faux.setResponses([fauxAssistantMessage("轮询之后才有的答案")]);
      const submission = await root.submit(
        { type: "input", content: "延迟的问题", requestId: "r_0000008" },
        context,
      );
      await submission.wait(context);
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  },
];

const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const write = process.argv.includes("--write");

const selected = scenarios.filter(
  (scenario) => wanted.length === 0 || wanted.includes(scenario.name),
);
if (selected.length === 0) {
  console.error(`unknown scenario; known: ${scenarios.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

for (const scenario of selected) {
  const faux = fauxProvider(scenario.options as never);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry(), settings: scenario.settings as never },
    context,
  );
  const root = await harness.root(context, {
    agent: {
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
    },
  });
  harness.resume();

  const events: AgentEvent[][] = [];
  const stream = await watchEvents(harness, root.id, context);
  stream.start(async (batch) => {
    events.push(batch.map((event) => JSON.parse(JSON.stringify(event)) as AgentEvent));
  });

  await scenario.run({ harness, root, faux, events });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await stream.stop();
  await harness.close(context);

  const recorded = events.filter((batch) => batch.length > 0);
  const mapper = createEventMapper({ botId: "b_golden", now: () => new Date(0) });
  const mapped = recorded.flatMap((batch) =>
    batch.flatMap((event) => mapper.map(event, "tr_golden")),
  );
  const file = {
    scenario: scenario.name,
    description: scenario.description,
    events: recorded,
    ...(write ? { expected: mapped } : {}),
  };
  const target = join(goldenDir, `${scenario.name}.json`);
  await writeFile(target, `${JSON.stringify(file, null, 2)}\n`);
  console.log(
    `${scenario.name}: ${recorded.length} batches, ${recorded.flat().length} pi events, ${mapped.length} runtime events`,
  );
}
