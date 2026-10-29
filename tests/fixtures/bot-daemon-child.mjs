// Narrow IPC around the actual daemon; never substitutes a runtime or tool registry.

import { readConfig } from "../../apps/bots/src/config.ts";
import { startDaemon } from "../../apps/bots/src/main.ts";

const daemon = await startDaemon(
  readConfig({
    argv: ["--root", process.env.BOTS_ROOT, "--port", "0"],
    env: process.env,
  }),
);
process.on("message", async ({ id, action, bot, request, title, trace }) => {
  try {
    let result;
    if (action === "create")
      result = await daemon.registry.create(title, trace);
    else if (action === "open") {
      await daemon.registry.open(bot, trace);
      result = null;
    } else if (action === "submit")
      result = await (await daemon.registry.open(bot, "tr_child_open")).submit(
        request,
      );
    else if (action === "submission")
      result = await (
        await daemon.registry.open(bot, "tr_child_open")
      ).submission(request);
    else if (action === "close") {
      await daemon.close();
      process.send({ id, result: null }, () => process.exit(0));
      return;
    } else throw new Error("invalid fixture action");
    process.send({ id, result });
  } catch (error) {
    process.send({ id, error: error.code ?? error.name });
  }
});
process.send({ ready: true, port: daemon.port });
