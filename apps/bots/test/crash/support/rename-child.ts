// A child that runs the production delete and stops between its two steps, so the parent
// can kill it there (docs/bots/OBSERVABILITY.md, recipe R4): `BotDirectory.remove` renames
// the bot directory, then writes the catalog. The wrapper stops the process after the
// rename, which is exactly the state a kill leaves behind.
//
//   node --experimental-strip-types test/crash/support/rename-child.ts <root> <botId>

import { mkdir } from "node:fs/promises";
import { BotDirectory, type DirectoryFs, nodeDirectoryFs } from "../../../src/core/BotDirectory.ts";

const root = process.argv[2];
const botId = process.argv[3] ?? "b_crash";
if (root === undefined) throw new Error("usage: rename-child.ts <root> <botId>");

const fs = await nodeDirectoryFs();
const stopping: DirectoryFs = {
  ...fs,
  rename: async (from, to) => {
    await fs.rename(from, to);
    if (!from.includes("/bots/")) return;
    // The first step of the delete finished; the catalog write never runs.
    process.stdout.write("renamed\n");
    await new Promise<void>(() => undefined);
  },
};
const directory = new BotDirectory(root, stopping);
await directory.create({
  id: botId,
  title: "待删",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  model: { provider: "faux", modelId: "faux-1" },
});
await mkdir(root, { recursive: true });
await directory.remove(botId);
