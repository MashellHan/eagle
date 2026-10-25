// A daemon-shaped child that dies mid-answer, so the parent can prove recovery
// (docs/bots/RUNTIME.md, "Recovery semantics"). It prints `ready` once the input is
// durably admitted and the attempt is in flight, then waits to be killed.
//
//   node --experimental-strip-types test/runtime/support/interrupt-child.ts <dir> <requestId>

import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, watchEvents } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const dir = process.argv[2];
const requestId = process.argv[3] ?? "r_interrupt_1";
if (dir === undefined) throw new Error("usage: interrupt-child.ts <dir> <requestId>");

const context = BACKGROUND_CONTEXT;
const faux = fauxProvider({ tokensPerSecond: 4, tokenSize: { min: 2, max: 3 } });
const models = createModels();
models.setProvider(faux.provider);
// Slow enough that the attempt is still streaming when the process dies, so recovery has
// a partial to convert (F22) instead of nothing.
faux.setResponses([
  fauxAssistantMessage(
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi " +
      "rho sigma tau upsilon phi chi psi omega alpha beta gamma delta epsilon zeta eta theta",
  ),
]);

const harness = await Harness.open(
  await openNodeSqliteStorage(join(dir, "session.sqlite")),
  { models, registry: createRegistry(), settings: { compaction: { enabled: false } } as never },
  context,
);
const root = await harness.root(context, {
  agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } },
});
harness.resume();
const stream = await watchEvents(harness, root.id, context);
stream.start(async (batch) => {
  if (batch.some((event) => event.type === "message_update")) {
    process.stdout.write("streaming\n");
  }
});
const submission = await root.submit(
  { type: "input", content: "会被杀死的问题", requestId, whenBusy: "followUp" },
  context,
);
await submission.status(context);
process.stdout.write("ready\n");
setInterval(() => undefined, 1_000);
