// Normative fixture gate. `check` proves the committed files still round-trip through
// the codec; `write` regenerates them after a documented protocol change.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeCommand, encodeServerEvent, serialize } from "../src/protocol/encode.ts";
import { decodeCommand, decodeServerEvent } from "../src/protocol/frames.ts";

const dir = new URL("../../../fixtures/bots-protocol/", import.meta.url).pathname;
const mode = process.argv[2] ?? "check";
const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort();

let failures = 0;
for (const name of files) {
  if (name === "entities.json") {
    // Entity samples are decoded through their enclosing frames, never skipped.
    const entities = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    try {
      decodeServerEvent({ type: "bots", bots: [entities.bot] });
      for (const key of ["message", "userMessage"]) {
        decodeServerEvent({ type: "append", rev: 1, trace, message: entities[key] });
      }
      decodeServerEvent({
        type: "snapshot",
        rev: 1,
        trace,
        value: {
          botId: "b_1",
          messages: [],
          streaming: null,
          pending: [],
          inbox: [entities.inboxItem],
          running: false,
        },
      });
    } catch (error) {
      failures += 1;
      console.error(`fixtures:check: ${name}: ${(error as Error).message}`);
    }
    continue;
  }
  const text = readFileSync(join(dir, name), "utf8");
  const wire = JSON.parse(text) as Record<string, unknown>;
  try {
    const encoded = name.endsWith(".client.json")
      ? encodeCommand(decodeCommand(wire))
      : encodeServerEvent(decodeServerEvent(wire));
    const next = serialize(encoded as Record<string, unknown>);
    if (mode === "write") {
      if (next !== text) writeFileSync(join(dir, name), next);
      continue;
    }
    if (next !== text) {
      failures += 1;
      console.error(`fixtures:check: ${name} does not round-trip byte for byte`);
    }
  } catch (error) {
    failures += 1;
    console.error(`fixtures:check: ${name}: ${(error as Error).message}`);
  }
}

if (failures > 0) process.exitCode = 1;
else console.log(`fixtures:${mode}: ${files.length} files ok`);
