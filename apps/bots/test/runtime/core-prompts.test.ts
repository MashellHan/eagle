// The core prompts in the real adapter: what the model actually receives, and in which order
// (docs/bots/PRODUCT.md, "Core prompts").
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { assistant, createBench, trace, waitFor } from "../support/pi.ts";

/** Runs one turn and returns every message the model was handed for it. */
const system = async (
  groups: readonly string[],
  prompts: {
    readonly corePrompt?: () => string | undefined;
    readonly machinePrompt?: () => { readonly path: string; readonly text: string } | undefined;
  },
): Promise<string> => {
  let seen = "";
  const bench = await createBench(prompts);
  try {
    const handle = await bench.runtime.open({ ...bench.spec(), toolGroups: groups });
    try {
      const events: RuntimeEvent[] = [];
      await handle.subscribe(trace, (event) => events.push(event));
      bench.faux.setResponses([
        (context) => {
          seen = JSON.stringify(context.messages);
          return assistant("好");
        },
      ]);
      await handle.submit({ requestId: "r_core", text: "开始", whenBusy: "followUp", trace });
      await waitFor(
        () => events.some((event) => event.type === "submission"),
        "the run to settle",
        10_000,
      );
    } finally {
      await handle.close(trace, 5_000);
    }
  } finally {
    await bench.cleanup();
  }
  return seen;
};

test("the model reads the persona and the machine prompt before any tool section", async () => {
  const seen = await system(["persona", "machine", "core", "coding"], {
    corePrompt: () => "只说结论，不要客套。",
    machinePrompt: () => ({ path: "/m/AGENTS.md", text: "机器规则：先跑测试。" }),
  });
  assert.match(seen, /只说结论，不要客套。/, "the persona section reached the model");
  assert.match(seen, /机器规则：先跑测试。/, "the machine section reached the model");
  const persona = seen.indexOf("只说结论");
  const machine = seen.indexOf("机器规则");
  const tools = seen.indexOf("default working directory");
  assert.ok(persona >= 0, "the persona is present");
  assert.ok(machine > persona, "the persona leads the machine prompt");
  assert.ok(tools > machine, "both core prompts lead the tool sections");
});

test("a bot without the two groups receives neither section", async () => {
  const seen = await system(["core", "coding"], {
    corePrompt: () => "不该出现的人格",
    machinePrompt: () => ({ path: "/m/AGENTS.md", text: "不该出现的机器规则" }),
  });
  assert.equal(seen.includes("不该出现的人格"), false);
  assert.equal(seen.includes("不该出现的机器规则"), false);
  assert.match(seen, /default working directory/, "the tool section is still there");
});
