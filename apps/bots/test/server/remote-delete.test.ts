import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readConfig } from "../../src/config.ts";
import { startDaemon } from "../../src/main.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bots-remote-delete-"));
  const held: { response: ServerResponse; action: string; binding: unknown }[] = [];
  let hold = "";
  let failRemoval = false;
  let removals = 0;
  const answer = (response: ServerResponse, action: string, binding: unknown) => {
    response.end(
      JSON.stringify(
        action === "read"
          ? { binding, ownerToken: "isolated-delete-owner-credential-0123456789" }
          : failRemoval
            ? { error: true }
            : { available: false },
      ),
    );
  };
  const control = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const value = JSON.parse(raw) as { action: string; binding: unknown };
    if (value.action === "remove") removals++;
    if (value.action === hold) held.push({ response, ...value });
    else answer(response, value.action, value.binding);
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const address = control.address();
  assert(address && typeof address !== "string");
  const helper = join(root, "helper");
  await writeFile(
    helper,
    `#!${process.execPath}\nlet body='';for await(const part of process.stdin)body+=part;
    const reply=await fetch('http://127.0.0.1:${address.port}',{method:'POST',body});process.stdout.write(await reply.text());`,
    { mode: 0o700 },
  );
  const config = readConfig({
    env: { BOTS_ROOT: root, BOTS_CREDENTIAL_HELPER: helper },
    argv: ["--port", "0"],
  });
  let daemon = await startDaemon(config);
  const bot = await daemon.registry.create("Removal fixture", "tr_delete_fixture");
  const request = (method: string, remote = true, body?: unknown) =>
    fetch(`http://127.0.0.1:${daemon.port}/v1/bots/${bot.id}${remote ? "/remote-tools" : ""}`, {
      method,
      headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const read = async () =>
    (await (await request("GET")).json()) as {
      remoteTools: { revision: string; targets: { enabled: boolean }[]; cleanupPending: boolean };
    };
  const target = {
    alias: "mac",
    enabled: true,
    origin: "https://fixture.example.test",
    machineId: "machine-b",
    credentialRef: "fixture-reference",
    operations: ["file.read"],
  };
  const grant = async (enabled = true) => {
    const state = await read();
    assert.equal(
      (
        await request("PUT", true, {
          revision: state.remoteTools.revision,
          targets: [{ ...target, enabled }],
        })
      ).status,
      200,
    );
  };
  const until = async (predicate: () => boolean) => {
    const limit = performance.now() + 3000;
    while (!predicate()) {
      assert(performance.now() < limit, "helper interleaving reached");
      await delay(5);
    }
  };
  const release = () => {
    for (const item of held.splice(0)) answer(item.response, item.action, item.binding);
  };
  return {
    root,
    bot,
    target,
    request,
    read,
    grant,
    until,
    held,
    release,
    hold: (action: string) => {
      hold = action;
    },
    fail: (value: boolean) => {
      failRemoval = value;
    },
    removals: () => removals,
    exists: () => daemon.registry.summaries().some((value) => value.id === bot.id),
    restart: async () => {
      await daemon.close();
      daemon = await startDaemon(config);
    },
    close: async () => {
      hold = "";
      release();
      try {
        await daemon.close();
      } finally {
        await new Promise<void>((resolve) => control.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

test("deleting denies authority before cleanup, blocks new PUTs and shares duplicate deletion", async () => {
  const f = await fixture();
  const pending: Promise<Response>[] = [];
  try {
    await f.grant();
    f.hold("remove");
    const first = f.request("DELETE", false);
    pending.push(first);
    await f.until(() => f.held.length === 1);
    assert(f.exists(), "the Bot remains available for cleanup until the helper confirms");
    const current = await f.read();
    assert.deepEqual(current.remoteTools.targets, []);
    assert.equal(current.remoteTools.cleanupPending, true);
    const second = f.request("DELETE", false);
    pending.push(second);
    assert.equal(
      (
        await f.request("PUT", true, {
          revision: current.remoteTools.revision,
          targets: [f.target],
        })
      ).status,
      409,
    );
    f.release();
    assert.equal((await first).status, 204);
    assert.equal((await second).status, 204);
    assert.equal(f.removals(), 1);
    assert.equal(f.exists(), false);
  } finally {
    f.release();
    await Promise.allSettled(pending);
    await f.close();
  }
});

test("failed cleanup keeps the Bot and can finish after a daemon restart", async () => {
  const f = await fixture();
  try {
    await f.grant();
    f.fail(true);
    assert.equal((await f.request("DELETE", false)).status, 503);
    assert(f.exists());
    assert.equal((await f.read()).remoteTools.cleanupPending, true);
    await f.restart();
    f.fail(false);
    assert.equal((await f.request("DELETE", false)).status, 204);
    assert.equal(f.exists(), false);
  } finally {
    await f.close();
  }
});

test("an old expanding PUT cannot restore a deleted Bot's authority", async () => {
  const f = await fixture();
  let pending: Promise<Response> | undefined;
  try {
    await f.grant();
    const current = await f.read();
    f.hold("read");
    pending = f.request("PUT", true, {
      revision: current.remoteTools.revision,
      targets: [{ ...f.target, operations: ["file.read", "command.exec"] }],
    });
    await f.until(() => f.held.length === 1);
    assert.equal((await f.request("DELETE", false)).status, 204);
    f.release();
    assert.equal((await pending).status, 409);
    assert.equal(f.exists(), false);
  } finally {
    f.release();
    await pending;
    await f.close();
  }
});

test("a reserved private copy must be explicitly resolved before deletion", async () => {
  const f = await fixture();
  try {
    await f.grant(false);
    assert.equal((await f.request("DELETE", false)).status, 409);
    assert(f.exists());
    assert.equal((await f.read()).remoteTools.targets.length, 1);
    assert.equal(f.removals(), 0);
  } finally {
    await f.close();
  }
});

test("corrupted remote authority cannot be discarded by deleting its Bot", async () => {
  const f = await fixture();
  try {
    await f.read();
    await writeFile(join(f.root, "remote-tools", `${f.bot.id}.json`), "broken", { mode: 0o600 });
    assert.equal((await f.request("DELETE", false)).status, 503);
    assert(f.exists());
  } finally {
    await f.close();
  }
});
