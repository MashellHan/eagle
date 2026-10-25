// A child that stops between the two steps of a delete, so the parent can kill it there
// (docs/bots/OBSERVABILITY.md, recipe R4). It prints `renamed` once the bot directory has
// moved to `trash/<id>` and the catalog entry still names it, then waits to be killed.
//
//   node --experimental-strip-types test/crash/support/rename-child.ts <root> <botId>

import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { BotDirectory, nodeDirectoryFs } from "../../../src/core/BotDirectory.ts";

const root = process.argv[2];
const botId = process.argv[3] ?? "b_crash";
if (root === undefined) throw new Error("usage: rename-child.ts <root> <botId>");

const directory = new BotDirectory(root, await nodeDirectoryFs());
const config = {
  id: botId,
  title: "待删",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  model: { provider: "faux", modelId: "faux-1" },
};
await directory.create(config);
// Step one of the delete, and nothing after it: the catalog still holds the entry.
await mkdir(join(root, "trash"), { recursive: true });
await rename(directory.botDir(botId), directory.trashDir(botId));
process.stdout.write("renamed\n");
setInterval(() => undefined, 1_000);
