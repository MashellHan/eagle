import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readConfig } from "../../src/config.ts";
import { startDaemon } from "../../src/main.ts";

test("startDaemon binds non-secret remote grants to its real root and Bot routes before runtime use", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-remote-entry-"));
  const helper = join(root, "helper");
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const helperBody = `#!${process.execPath}\nlet input='';for await(const part of process.stdin)input+=part;
      const request=JSON.parse(input);process.stdout.write(JSON.stringify(request.action==='read'?{binding:request.binding,ownerToken:'fixture-owner-header-0123456789-abcdefgh'}:{available:request.action!=='remove'}));`;
    await writeFile(helper, helperBody, { mode: 0o700 });
    const config = readConfig({
      env: { BOTS_ROOT: root, BOTS_CREDENTIAL_HELPER: helper },
      argv: ["--port", "0"],
    });
    daemon = await startDaemon(config);
    const auth = { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" };
    const base = `http://127.0.0.1:${daemon.port}`;
    const created = await fetch(`${base}/v1/bots`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "Fixture A" }),
    });
    assert.equal(created.status, 201);
    const { bot } = (await created.json()) as { bot: { id: string } };
    const url = `${base}/v1/bots/${bot.id}/remote-tools`;
    assert.equal((await fetch(url)).status, 401);
    const initial = await fetch(url, { headers: auth });
    assert.equal(initial.status, 200);
    const { remoteTools } = (await initial.json()) as {
      remoteTools: {
        namespace: string;
        revision: string;
        helperAvailable: boolean;
        cleanupPending: boolean;
        targets: unknown[];
      };
    };
    assert.equal(remoteTools.helperAvailable, true);
    assert.equal(remoteTools.cleanupPending, false);
    assert.equal(
      remoteTools.namespace,
      createHash("sha256").update(daemon.config.root).digest("hex"),
    );
    const target = {
      alias: "build-mac",
      enabled: true,
      origin: "https://fixture.example.test",
      machineId: "machine-b",
      credentialRef: "fixture-ref",
      operations: ["command.exec", "herdr.setup"],
    };
    const saved = await fetch(url, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ revision: remoteTools.revision, targets: [target] }),
    });
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as {
      remoteTools: { revision: string; targets: unknown[]; cleanupPending: boolean };
    };
    assert.deepEqual(body.remoteTools.targets, [target]);
    assert.equal(JSON.stringify(body).includes("fixture-owner-header"), false);
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: auth,
          body: JSON.stringify({ revision: remoteTools.revision, targets: [] }),
        })
      ).status,
      409,
    );
    const other = await daemon.registry.create("Fixture B", "tr_remote_fixture");
    const otherData = (await (
      await fetch(`${base}/v1/bots/${other.id}/remote-tools`, { headers: auth })
    ).json()) as { remoteTools: { targets: unknown[] } };
    assert.deepEqual(otherData.remoteTools.targets, []);
    assert.equal(
      (await fetch(`${base}/v1/bots/absent/remote-tools`, { headers: auth })).status,
      404,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: auth,
          body: JSON.stringify({
            revision: body.remoteTools.revision,
            targets: [target],
            ownerToken: "must-not-be-accepted",
          }),
        })
      ).status,
      400,
    );
    await writeFile(
      helper,
      `#!${process.execPath}\nprocess.stderr.write('fixture-secret-must-not-leak');process.exit(1);`,
      { mode: 0o700 },
    );
    const removing = await fetch(url, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ revision: body.remoteTools.revision, targets: [] }),
    });
    assert.equal(removing.status, 503, "a failed credential cleanup is not reported complete");
    assert.equal((await removing.text()).includes("fixture-secret-must-not-leak"), false);
    const denied = (await (await fetch(url, { headers: auth })).json()) as {
      remoteTools: { revision: string; cleanupPending: boolean; targets: unknown[] };
    };
    assert.deepEqual(denied.remoteTools.targets, []);
    assert.equal(denied.remoteTools.cleanupPending, true);
    await writeFile(helper, helperBody, { mode: 0o700 });
    const repaired = await fetch(url, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ revision: denied.remoteTools.revision, targets: [] }),
    });
    assert.equal(repaired.status, 200);
    const final = (await repaired.json()) as { remoteTools: { cleanupPending: boolean } };
    assert.equal(final.remoteTools.cleanupPending, false);
  } finally {
    await daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("overlapping cleanup retries share one helper removal and cannot delete a newly authorized binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-remote-cleanup-race-"));
  const helper = join(root, "helper");
  const removals: ServerResponse[] = [];
  let credentialPresent = true;
  const control = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const value = JSON.parse(body) as { action: string; binding: unknown };
    if (value.action === "remove") {
      removals.push(response);
      return;
    }
    response.end(
      JSON.stringify(
        credentialPresent
          ? { binding: value.binding, ownerToken: "fixture-owner-credential-for-cleanup-123456789" }
          : { available: false },
      ),
    );
  });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const requests: Promise<Response>[] = [];
  const waitFor = async (predicate: () => Promise<boolean> | boolean) => {
    const deadline = performance.now() + 5000;
    while (!(await predicate())) {
      assert.ok(performance.now() < deadline, "fixture reached the intended interleaving");
      await delay(5);
    }
  };
  const finish = (response: ServerResponse) => {
    credentialPresent = false;
    response.end(JSON.stringify({ available: false }));
  };
  try {
    await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
    const address = control.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(
      helper,
      `#!${process.execPath}\nlet body='';for await(const part of process.stdin)body+=part;
      const reply=await fetch('http://127.0.0.1:${address.port}',{method:'POST',body});process.stdout.write(await reply.text());`,
      { mode: 0o700 },
    );
    daemon = await startDaemon(
      readConfig({
        env: { BOTS_ROOT: root, BOTS_CREDENTIAL_HELPER: helper },
        argv: ["--port", "0"],
      }),
    );
    const bot = await daemon.registry.create("Cleanup fixture", "tr_cleanup_fixture");
    const headers = { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" };
    const url = `http://127.0.0.1:${daemon.port}/v1/bots/${bot.id}/remote-tools`;
    const read = async () =>
      (
        (await (await fetch(url, { headers })).json()) as {
          remoteTools: {
            revision: string;
            cleanupPending: boolean;
            targets: { enabled: boolean }[];
          };
        }
      ).remoteTools;
    const save = (revision: string, targets: unknown[]) =>
      fetch(url, { method: "PUT", headers, body: JSON.stringify({ revision, targets }) });
    const target = {
      alias: "mac",
      enabled: true,
      origin: "https://fixture.example.test",
      machineId: "machine-b",
      credentialRef: "fixture-ref",
      operations: ["file.read"],
    };
    assert.equal((await save((await read()).revision, [target])).status, 200);
    const first = save((await read()).revision, []);
    requests.push(first);
    await waitFor(() => removals.length === 1);
    const pending = await read();
    assert.equal(pending.cleanupPending, true);
    const second = save(pending.revision, []);
    requests.push(second);
    await waitFor(async () => (await read()).revision !== pending.revision);
    // The second HTTP save is admitted before the first helper is released.
    await delay(100);
    const firstRemoval = removals[0];
    assert.ok(firstRemoval);
    finish(firstRemoval);
    assert.equal((await first).status, 200);
    assert.equal((await read()).cleanupPending, false);
    credentialPresent = true;
    assert.equal((await save((await read()).revision, [target])).status, 200);
    for (const response of removals.slice(1)) finish(response);
    const secondReply = await second;
    assert.equal(
      removals.length,
      1,
      "one private helper owns the binding until cleanup is acknowledged",
    );
    assert.equal(secondReply.status, 200);
    assert.equal(credentialPresent, true, "a late retry cannot remove the new credential");
    assert.equal((await read()).targets[0]?.enabled, true);
  } finally {
    for (const response of removals)
      if (!response.writableEnded) response.end(JSON.stringify({ available: false }));
    await Promise.allSettled(requests);
    await daemon?.close();
    await new Promise<void>((resolve) => control.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
