import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LiveBridge } from "../agent/realtime.ts";

test("live bridge shares subscriptions, rejects replaced terminals, and stops all reads on unsubscribe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eagle-live-"));
  const path = join(directory, "herdr.sock");
  let reads = 0,
    writes = 0;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (bytes) => {
      const request = JSON.parse(String(bytes));
      reads++;
      if (request.method === "pane.send_input") writes++;
      const result =
        request.method === "session.snapshot"
          ? {
              snapshot: {
                workspaces: [{ workspace_id: "w1", label: "Test" }],
                tabs: [{ workspace_id: "w1", tab_id: "t1", label: "Tab" }],
                panes: [
                  {
                    workspace_id: "w1",
                    tab_id: "t1",
                    pane_id: "p1",
                    terminal_id: "new-terminal",
                    revision: 1,
                  },
                ],
                layouts: [],
              },
            }
          : { read: { text: "API_KEY=super-secret\nready", revision: 1 } };
      socket.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  const messages: { type: string; text?: string; status?: string }[] = [];
  const bridge = new LiveBridge(
    ["machine-credential"],
    (message) => messages.push(message),
    async () => path,
  );
  try {
    bridge.receive({
      type: "subscriptions",
      spaces: [{ spaceId: "default:w1", subscriptionId: "epoch" }],
    });
    await new Promise((r) => setTimeout(r, 150));
    assert(
      messages.some(
        (m) => m.type === "frame" && m.text?.includes("[REDACTED]"),
      ),
    );
    bridge.receive({
      type: "input",
      spaceId: "default:w1",
      subscriptionId: "epoch",
      clientId: "client",
      seq: 1,
      paneId: "p1",
      terminalId: "old-terminal",
      text: "danger",
      keys: [],
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(writes, 0);
    assert(messages.some((m) => m.type === "ack" && m.status === "rejected"));
    bridge.receive({ type: "subscriptions", spaces: [] });
    await new Promise((r) => setTimeout(r, 50));
    const stoppedAt = reads;
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(reads, stoppedAt);
    assert.equal(sockets.size, 0);
  } finally {
    bridge.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  }
});
