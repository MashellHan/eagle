import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRemoteCredentials, RemoteError } from "../../src/tools/remote/keychain.ts";

test("remote credentials cross only private pipes with exact binding, bounded replies and fixed failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-remote-helper-pipe-"));
  const binary = join(root, "helper");
  const evidence = join(root, "observed.json");
  const binding = {
    namespace: "a".repeat(64),
    botId: "bot-a",
    credentialRef: randomUUID(),
    origin: "https://fixture.example.test",
  };
  const credential = {
    binding,
    ownerToken: `fixture-owner-${randomUUID()}`,
    accessClientID: "fixture-access-id",
    accessClientSecret: `fixture-access-${randomUUID()}`,
  };
  const helper = createRemoteCredentials(binary);
  const make = (body: string) =>
    writeFile(binary, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  const refused = (error: unknown) =>
    error instanceof RemoteError &&
    error.code === "needs_local" &&
    !error.message.includes(credential.ownerToken);
  try {
    await make(`let input=''; for await (const chunk of process.stdin) input+=chunk; const request=JSON.parse(input);
      const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({argv:process.argv.slice(2),env:process.env,request}));
      if(request.action==='read')process.stdout.write(JSON.stringify(${JSON.stringify(credential)}));
      else process.stdout.write(JSON.stringify({available:request.action!=='remove'}));`);
    assert.equal(await helper.status(binding), true);
    const read = await helper.read(binding);
    assert.equal(read.ownerToken === credential.ownerToken, true);
    assert.deepEqual(read.binding, binding);
    const transport = JSON.parse(await readFile(evidence, "utf8"));
    assert.deepEqual(transport.argv, []);
    assert.deepEqual(transport.request, { action: "read", binding });
    for (const secret of [
      credential.ownerToken,
      credential.accessClientID,
      credential.accessClientSecret,
    ]) {
      assert.equal(JSON.stringify(transport).includes(secret), false);
    }
    await helper.remove(binding);
    for (const invalid of [
      { ...credential, binding: { ...binding, origin: "https://other.example.test" } },
      { ...credential, ownerToken: `${credential.ownerToken} internal space` },
      { ...credential, extra: true },
      { ...credential, accessClientID: undefined },
    ]) {
      await make(`process.stdout.write(${JSON.stringify(JSON.stringify(invalid))});`);
      await assert.rejects(helper.read(binding), refused);
    }
    await make(
      `process.stderr.write('x'.repeat(1024*1024));process.stdout.write(${JSON.stringify(JSON.stringify(credential))});`,
    );
    assert.equal(
      (await helper.read(binding)).ownerToken === credential.ownerToken,
      true,
      "stderr is drained without being returned",
    );
    await make("process.stdout.write('x'.repeat(65537));");
    await assert.rejects(helper.read(binding), refused);
    await make(`process.stderr.write(${JSON.stringify(credential.ownerToken)});process.exit(1);`);
    await assert.rejects(helper.read(binding), refused);
    await make("setInterval(()=>{},1000);");
    const abort = new AbortController();
    const pending = helper.read(binding, abort.signal);
    abort.abort();
    await assert.rejects(pending, refused);
    await assert.rejects(helper.read({ ...binding, namespace: `${binding.namespace}\n` }), refused);
    const started = performance.now();
    await assert.rejects(helper.read(binding), refused);
    assert.ok(
      performance.now() - started < 17_000,
      "helper timeout does not wait indefinitely for a pipe",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synchronous helper spawn errors stay fixed and cancellation reaps the child before returning", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-remote-reap-"));
  const binding = {
    namespace: "a".repeat(64),
    botId: "bot-a",
    credentialRef: "fixture-ref",
    origin: "https://fixture.example.test",
  };
  const binary = join(root, "helper");
  const pidFile = join(root, "pid");
  try {
    await assert.rejects(
      createRemoteCredentials("/invalid\0helper").status(binding),
      (error: unknown) => error instanceof RemoteError && error.code === "needs_local",
    );
    await writeFile(
      binary,
      `#!${process.execPath}\nconst fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`,
      { mode: 0o700 },
    );
    const controller = new AbortController();
    const pending = assert.rejects(
      createRemoteCredentials(binary).read(binding, controller.signal),
    );
    let pid = 0;
    const until = Date.now() + 3000;
    while (!pid && Date.now() < until) {
      pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(pid > 0);
    controller.abort();
    await pending;
    assert.throws(
      () => process.kill(pid, 0),
      "return follows child exit, not just a delivered signal",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
