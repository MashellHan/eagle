// End-to-end smoke test for the configured model endpoint.
//
// Proves, without touching the daemon or its storage: the endpoint answers in the
// OpenAI Responses shape, pi-ai can stream it, and pi-durable can commit a
// conversation turn on top of it.
//
//   node --env-file=.env --experimental-strip-types scripts/smoke-model.ts
//
// Prints timing and usage. Never prints the key. Exits non-zero on any failure.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createRegistry, Harness, watchEvents } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";

const context = BACKGROUND_CONTEXT;
const now = () => performance.now();
const ms = (since: number) => Math.round(performance.now() - since);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set; copy .env.example to .env and fill it in`);
  if (value === "REPLACE_WITH_KEY") throw new Error(`${name} still holds the .env placeholder`);
  return value;
}

const baseUrl = required("BOTS_BASE_URL");
const apiKey = required("BOTS_API_KEY");
const providerId = process.env.BOTS_PROVIDER?.trim() || "magpie";
const modelId = process.env.BOTS_MODEL?.trim() || "auto/gpt-6-luna";

console.log(
  JSON.stringify({
    event: "smoke.start",
    baseUrl,
    providerId,
    modelId,
    keyLength: apiKey.length,
  }),
);

const provider = createProvider({
  id: providerId,
  name: "Bots model endpoint",
  baseUrl,
  auth: { apiKey: envApiKeyAuth("Bots model API key", ["BOTS_API_KEY"]) },
  models: [
    {
      id: modelId,
      name: modelId,
      provider: providerId,
      baseUrl,
      api: "openai-responses",
      reasoning: true,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 8_192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
  api: openAIResponsesApi(),
});

const models = createModels();
models.setProvider(provider);

const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
const root = await harness.root(context, { agent: { model: { provider: providerId, modelId } } });

type Watch = { seen: string[]; firstDeltaAt: number | null; stop: () => Promise<void> };

function startWatch(): Watch {
  const startedAt = now();
  const watch: Watch = { seen: [], firstDeltaAt: null, stop: async () => {} };
  void watchEvents(harness, root.id, context).then((stream) => {
    watch.stop = async () => {
      await stream.stop();
    };
    stream.start(async (events) => {
      for (const event of events) {
        watch.seen.push(event.type);
        if (event.type === "message_update" && watch.firstDeltaAt === null)
          watch.firstDeltaAt = ms(startedAt);
      }
    });
  });
  return watch;
}

async function turn(prompt: string) {
  const watch = startWatch();
  const started = now();
  const submission = await root.submit({ type: "input", content: prompt }, context);
  const settled = await submission.wait(context);
  const text = await lastAssistantText();
  const elapsed = ms(started);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await watch.stop();
  return { settled, text, elapsed, events: watch.seen, firstDeltaAt: watch.firstDeltaAt };
}

async function lastAssistantText(): Promise<string> {
  const page = await root.entries({}, 50, undefined, context);
  const entry = [...page.items].reverse().find((item) => item.kind === "pi.assistant");
  const message = entry?.model?.[0];
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

const first = await turn("用一句话回答：巴黎是哪个国家的首都？");
console.log(
  JSON.stringify({
    event: "smoke.turn",
    turn: 1,
    settled: first.settled.status,
    reason: first.settled.status === "unanswered" ? first.settled.reason : undefined,
    answer: first.text.slice(0, 200),
    ms: first.elapsed,
    firstDeltaMs: first.firstDeltaAt,
    events: [...new Set(first.events)],
  }),
);

const second = await turn("我刚才问的是哪个城市？只回答城市名。");
console.log(
  JSON.stringify({
    event: "smoke.turn",
    turn: 2,
    settled: second.settled.status,
    answer: second.text.slice(0, 200),
    ms: second.elapsed,
    firstDeltaMs: second.firstDeltaAt,
  }),
);

const usage = await harness.usage(context);
console.log(JSON.stringify({ event: "smoke.usage", usage }));
await harness.close(context);

const ok =
  first.settled.status === "done" &&
  first.text.length > 0 &&
  second.settled.status === "done" &&
  /巴黎|paris/i.test(second.text);
console.log(JSON.stringify({ event: ok ? "smoke.pass" : "smoke.fail" }));
if (!ok) process.exitCode = 1;
