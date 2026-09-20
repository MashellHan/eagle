import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LiveBridge, redactScreen } from "../agent/realtime.ts";
import { submitTerminalInput } from "../agent/terminal-input.ts";

test("live bridge shares subscriptions, rejects replaced terminals, and stops all reads on unsubscribe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eagle-live-"));
  const path = join(directory, "herdr.sock");
  let reads = 0,
    writes = 0;
  let output = "API_KEY=super-secret\nready";
  let terminalId = "new-terminal",
    replaceDuringRead = false;
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
                    terminal_id: terminalId,
                    title: `${".".repeat(224)}machine-credential`,
                    revision: 0,
                  },
                ],
                layouts: [],
              },
            }
          : {
              read: {
                text: output,
                revision: 0,
                pane_id: "p1",
                workspace_id: "w1",
                tab_id: "t1",
              },
            };
      if (request.method === "pane.read" && replaceDuringRead) {
        terminalId = "replacement-terminal";
        output = "replacement screen";
        replaceDuringRead = false;
      }
      socket.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  const messages: { type: string; text?: string; status?: string }[] = [];
  let resolutions = 0;
  const bridge = new LiveBridge(
    ["machine-credential"],
    (message) => messages.push(message),
    async () => {
      resolutions++;
      return path;
    },
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
    assert(
      !JSON.stringify(messages).includes("machine-credenti"),
      "Topology must redact credentials before truncating pane titles",
    );
    bridge.receive({
      type: "subscriptions",
      spaces: [{ spaceId: "default:w1", subscriptionId: "epoch" }],
    });
    assert.equal(
      resolutions,
      1,
      "A second viewer must reuse the same Space polling loop",
    );
    await new Promise((r) => setTimeout(r, 420));
    output = "output changed with revision zero";
    await new Promise((r) => setTimeout(r, 420));
    assert(messages.some((m) => m.type === "frame" && m.text === output));
    output = "racy old capture";
    replaceDuringRead = true;
    await new Promise((r) => setTimeout(r, 800));
    assert(
      !messages.some(
        (m) => m.type === "frame" && m.text === "racy old capture",
      ),
    );
    assert(
      messages.some(
        (m) => m.type === "frame" && m.text === "replacement screen",
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

test("screen redaction covers wrapping and visible credential fragments", () => {
  const token = "fixture-secret-abcdefghijklmnopqrstuvwxyz-0123456789";
  for (const value of [
    token.slice(0, 23) + "\n" + token.slice(23),
    token.slice(12, 32),
    token.slice(-18),
  ]) {
    const screen = redactScreen(value, [token]).replace(/\s/g, "");
    assert(!screen.includes(value.replace(/\s/g, "")));
    assert(!screen.includes(token.slice(12, 24)));
  }
});

test("screen redaction hides private key bodies when either or both PEM boundaries are offscreen", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const lines = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString()
    .trim()
    .split("\n");
  for (const viewport of [
    lines,
    lines.slice(0, 12),
    lines.slice(-12),
    lines.slice(4, 16),
    lines.slice(4, 16).flatMap((line) => line.match(/.{1,32}/g) ?? []),
  ]) {
    const screen = redactScreen(viewport.join("\n"), []);
    for (const line of viewport.filter((line) => !line.startsWith("-----")))
      assert(!screen.includes(line), "Private key body escaped redaction");
  }
  assert.equal(
    redactScreen("build passed\nnext step: deploy", []),
    "build passed\nnext step: deploy",
  );
});

test("input never falls back to pane routing after the validated terminal is replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eagle-input-race-"));
  const path = join(directory, "herdr.sock");
  let unsafeWrites = 0;
  let replaced = false;
  let validatingInput = false;
  const snapshot = () => ({
    workspaces: [{ workspace_id: "w1", label: "W" }],
    tabs: [{ workspace_id: "w1", tab_id: "t1", label: "T" }],
    panes: [
      {
        workspace_id: "w1",
        tab_id: "t1",
        pane_id: "p1",
        terminal_id: replaced ? "replacement" : "original",
      },
    ],
    layouts: [
      {
        tab_id: "t1",
        area: { x: 0, y: 0, width: 80, height: 24 },
        panes: [{ pane_id: "p1", rect: { x: 0, y: 0, width: 80, height: 24 } }],
      },
    ],
  });
  const api = createServer((socket) =>
    socket.once("data", (bytes) => {
      const request = JSON.parse(String(bytes));
      if (request.method === "pane.send_input") unsafeWrites++;
      const result =
        request.method === "session.snapshot"
          ? { snapshot: snapshot() }
          : {
              read: {
                text: "ready",
                pane_id: "p1",
                tab_id: "t1",
                workspace_id: "w1",
              },
            };
      if (validatingInput && request.method === "session.snapshot")
        replaced = true;
      socket.end(JSON.stringify({ id: request.id, result }) + "\n");
    }),
  );
  await new Promise<void>((r) => api.listen(path, r));
  const messages: { type: string; status?: string }[] = [];
  const bridge = new LiveBridge(
    [],
    (m) => messages.push(m),
    async () => path,
  );
  try {
    bridge.receive({
      type: "subscriptions",
      spaces: [{ spaceId: "default:w1", subscriptionId: "epoch" }],
    });
    await new Promise((r) => setTimeout(r, 100));
    validatingInput = true;
    bridge.receive({
      type: "input",
      spaceId: "default:w1",
      subscriptionId: "epoch",
      clientId: "c",
      seq: 1,
      paneId: "p1",
      terminalId: "original",
      text: "wrong destination",
      keys: [],
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      unsafeWrites,
      0,
      "must never send input using the replaceable pane ID",
    );
    assert(messages.some((m) => m.type === "ack" && m.status === "rejected"));
  } finally {
    bridge.close();
    await new Promise<void>((r) => api.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("native input binds the terminal before paste/keys, confirms only submission and reclaims sockets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eagle-native-"));
  const path = join(directory, "herdr-client.sock");
  const frames: Buffer[] = [];
  const sockets = new Set<import("node:net").Socket>();
  let protocol = 22;
  let flags = 0,
    modify = 0;
  let stall = false,
    holdDetach = false,
    changeModeDuringValidation = false;
  const framed = (bytes: number[] | Buffer) => {
    const data = Buffer.from(bytes);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(data.length);
    return Buffer.concat([size, data]);
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const length = buffer.readUInt32LE();
        const payload = buffer.subarray(4, length + 4);
        buffer = buffer.subarray(length + 4);
        frames.push(payload);
        if (stall) continue;
        if (payload[0] === 0) socket.write(framed([0, protocol, 1, 0]));
        if (payload[0] === 5) {
          // Mode control precedes the initial full terminal frame; split TCP delivery is valid.
          socket.write(framed([16, flags, modify]));
          const screen = framed([1, 1, 80, 24, 1, 0]);
          socket.write(screen.subarray(0, 2));
          socket.write(screen.subarray(2));
        }
        if (payload[0] === 4 && !holdDetach)
          socket.end(framed([3, 1, 8, ...Buffer.from("detached")]));
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  const input = {
    type: "input" as const,
    seq: 1,
    paneId: "p",
    terminalId: "term_original",
    text: "hello",
    keys: [
      "enter" as const,
    ] as import("../src/shared/realtime.ts").LiveInput["keys"],
  };
  const submit = (signal = new AbortController().signal, valid = true) =>
    submitTerminalInput(
      join(directory, "herdr.sock"),
      input,
      { width: 80, height: 24 },
      signal,
      async () => {
        if (changeModeDuringValidation) {
          for (const socket of sockets) socket.write(framed([16, 31, 0]));
          await new Promise((r) => setTimeout(r, 30));
        }
        return valid;
      },
    );
  try {
    assert.equal(await submit(), "submitted");
    assert.deepEqual(frames[0], Buffer.from([0, 22, 80, 24, 0, 0, 0]));
    assert.deepEqual(
      frames[1],
      Buffer.from([5, 13, ...Buffer.from("term_original"), 0]),
    );
    assert.equal(frames[2].subarray(2).toString(), "\x1b[200~hello\x1b[201~");
    assert.deepEqual(frames[3], Buffer.from([1, 1, 13]));
    assert.deepEqual(frames[4], Buffer.from([4]));
    frames.length = 0;
    assert.equal(await submit(undefined, false), "rejected");
    assert(!frames.some((f) => f[0] === 1));
    input.text = "";
    flags = 1;
    input.keys = ["esc", "ctrl+c", "shift+tab"];
    frames.length = 0;
    assert.equal(await submit(), "submitted");
    assert.deepEqual(
      frames.filter((f) => f[0] === 1).map((f) => f.subarray(2).toString()),
      ["\x1b[27;1u", "\x1b[99;5u", "\x1b[9;2u"],
    );
    flags = 3;
    input.keys = ["ctrl+c", "shift+tab"];
    frames.length = 0;
    assert.equal(await submit(), "submitted");
    assert.deepEqual(
      frames.filter((f) => f[0] === 1).map((f) => f.subarray(2).toString()),
      ["\x1b[99;5:1u\x1b[99;5:3u", "\x1b[9;2:1u"],
    );
    flags = 31;
    input.keys = ["enter"];
    frames.length = 0;
    assert.equal(await submit(), "submitted");
    assert.equal(
      frames
        .find((f) => f[0] === 1)
        ?.subarray(2)
        .toString(),
      "\x1b[13;1:1u\x1b[13;1:3u",
    );
    flags = 0;
    changeModeDuringValidation = true;
    frames.length = 0;
    assert.equal(await submit(), "submitted");
    assert.equal(
      frames
        .find((f) => f[0] === 1)
        ?.subarray(2)
        .toString(),
      "\x1b[13;1:1u\x1b[13;1:3u",
      "Use the most recent keyboard mode after asynchronous identity validation",
    );
    changeModeDuringValidation = false;
    modify = 2;
    input.keys = ["shift+tab", "ctrl+c", "ctrl+d", "ctrl+l"];
    frames.length = 0;
    assert.equal(await submit(), "submitted");
    assert.deepEqual(
      frames.filter((f) => f[0] === 1).map((f) => f.subarray(2).toString()),
      ["\x1b[27;2;9~", "\x1b[27;5;99~", "\x1b[27;5;100~", "\x1b[27;5;108~"],
    );
    modify = 1;
    input.keys = ["ctrl+c", "ctrl+d", "ctrl+l"];
    frames.length = 0;
    assert.equal(await submit(), "submitted");
    assert.deepEqual(
      frames.filter((f) => f[0] === 1).map((f) => f.subarray(2).toString()),
      ["\x03", "\x04", "\x0c"],
    );
    frames.length = 0;
    protocol = 23;
    assert.equal(await submit(), "rejected");
    assert.equal(
      frames.length,
      1,
      "unsupported protocol cannot attach or write",
    );
    protocol = 22;
    holdDetach = true;
    const uncertainAbort = new AbortController();
    const uncertain = submit(uncertainAbort.signal);
    setTimeout(() => uncertainAbort.abort(), 30);
    assert.equal(
      await uncertain,
      "unknown",
      "a cancelled submission is never reported as rejected or replayed",
    );
    stall = true;
    const abort = new AbortController();
    const stopped = submit(abort.signal);
    setTimeout(() => abort.abort(), 20);
    assert.equal(await stopped, "rejected");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sockets.size, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  }
});
