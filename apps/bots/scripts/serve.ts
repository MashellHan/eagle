// The daemon process (docs/bots/ARCHITECTURE.md, "Process model"): configuration in, one
// composition root, a start line a supervisor can parse, and a shutdown on a signal. The
// behaviour lives in `src/`; this file is only process wiring and has no test double.
import { join } from "node:path";
import { readConfig } from "../src/config.ts";
import { startDaemon } from "../src/main.ts";

const handle = await startDaemon(readConfig());
process.stdout.write(
  `${JSON.stringify({
    event: "daemon.start",
    root: handle.config.root,
    port: handle.port,
    tokenFile: join(handle.config.root, "token"),
  })}\n`,
);

const shutdown = async (): Promise<void> => {
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
