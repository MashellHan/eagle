// Ladder row 48: the root is owned by a kernel listener, so a second daemon on the same
// root is refused and a killed one releases the port.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLock, fnv1a, LockError, lockPort } from "../../src/server/singleton.ts";

test("a live daemon rejects a second instance on the same root", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-lock-"));
  try {
    const owner = await acquireLock({ root, pid: 4711 });
    assert.equal(owner.port, lockPort(root));
    await assert.rejects(
      () => acquireLock({ root, pid: 4712 }),
      (error: unknown) => error instanceof LockError && error.reason === "running",
      "the second daemon is refused, and the root alone decides the port",
    );
    await owner.close();
    const taken = await acquireLock({ root, pid: 4713 });
    assert.equal(taken.port, owner.port, "the port is free once the owner is gone");
    await taken.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the lock port is derived from the root alone", () => {
  assert.equal(lockPort("/tmp/a"), 44000 + (fnv1a("/tmp/a") % 1000));
  assert.notEqual(lockPort("/tmp/a"), lockPort("/tmp/b"));
  assert.ok(lockPort("/tmp/a") >= 44000 && lockPort("/tmp/a") < 45000);
  assert.equal(lockPort("/tmp/a"), lockPort("/tmp/a"), "the same root always maps to one port");
});

test("two roots that hash to one lock port fail as a collision", async () => {
  // Find a pair by brute force: the port space is 1000 wide, so a pair exists quickly.
  const buckets = new Map<number, string>();
  let pair: [string, string] | undefined;
  for (let index = 0; index < 5_000 && pair === undefined; index += 1) {
    const candidate = `/tmp/bots-collision-${index}`;
    const port = lockPort(candidate);
    const known = buckets.get(port);
    if (known !== undefined) pair = [known, candidate];
    else buckets.set(port, candidate);
  }
  assert.ok(pair !== undefined, "two roots share a lock port");
  const root = await mkdtemp(join(tmpdir(), "bots-lock-"));
  try {
    const owner = await acquireLock({ root: pair[0], pid: 1 });
    await assert.rejects(
      () => acquireLock({ root: pair[1], pid: 2 }),
      (error: unknown) =>
        error instanceof LockError &&
        error.reason === "collision" &&
        /different root/.test(error.message),
      "the message names both roots and offers no override",
    );
    await owner.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two different roots that hash to one lock port are refused with both names", async () => {
  // The port is derived from the root alone, so a collision is a real possibility.
  const ports = new Map<number, string>();
  let first: string | undefined;
  let second: string | undefined;
  for (let index = 0; index < 5_000; index += 1) {
    const root = `/tmp/bots-collision-${index}`;
    const port = lockPort(root);
    const known = ports.get(port);
    if (known !== undefined) {
      first = known;
      second = root;
      break;
    }
    ports.set(port, root);
  }
  assert.ok(first !== undefined && second !== undefined, "a collision was found to test");
  const owner = await acquireLock({ root: first });
  try {
    const refused = await acquireLock({ root: second as string }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(refused instanceof LockError);
    assert.equal(refused.reason, "collision");
    assert.match(refused.message, /shared/);
    assert.ok(refused.message.includes(second), "the message names the loser's root");
    assert.ok(refused.message.includes(first), "and the owner's root");
  } finally {
    await owner.close();
  }
});

test("a half-spoken lock owner does not hang the probe", async () => {
  // Bind a fake owner on a port the lock derivation can produce, then answer with a
  // partial line and close: the probe must resolve, not wait for a newline that never
  // comes.
  let root: string | undefined;
  const owner = createServer((socket) => {
    socket.once("data", () => {
      socket.write(root ?? "");
      socket.end();
    });
  });
  for (let index = 0; index < 40_000 && root === undefined; index += 1) {
    const candidate = `/tmp/bots-partial-${index}`;
    const port = lockPort(candidate);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        owner.once("error", onError);
        owner.listen(port, "127.0.0.1", () => {
          owner.off("error", onError);
          resolve();
        });
      });
      root = candidate;
    } catch {
      // that port is taken; try the next candidate root
    }
  }
  assert.ok(root !== undefined, "a free port in the lock range was found");
  const started = Date.now();
  try {
    const outcome = await acquireLock({ root, probeTimeoutMs: 30 }).then(
      (acquired) => {
        void acquired.close();
        return "acquired";
      },
      (error: unknown) => error,
    );
    assert.ok(outcome instanceof LockError, "the probe fails instead of hanging");
    assert.equal((outcome as LockError).reason, "unavailable");
    assert.ok(Date.now() - started < 1_000, "and it does not wait for the deadline");
  } finally {
    await new Promise<void>((resolve) => owner.close(() => resolve()));
  }
});
