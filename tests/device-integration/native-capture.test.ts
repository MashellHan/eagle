import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { NativeDeviceLeases } from "../../packages/agent/device-native-leases.ts";
import { deviceOutcome } from "../../packages/agent/device-output.ts";
import { DeviceRuntime } from "../../packages/agent/device-runtime.ts";
import {
  canonicalDeviceJSON,
  deviceDigest,
  type OperationRequest,
} from "../../packages/contracts/src/devices.ts";

// Bots stays independent: its capture implementation and SDK load only in a
// separate Node process. Override the source for immutable red/green snapshots.
test("independent Bots capture never sends incomplete known-secret fragments into Agent completion", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "eagle-native-capture-"));
  const secret = "k8Q2n7R4v6W1x9Y3z5A0b2C7d4E8f6G1";
  assert.equal(secret.length, 32);
  const source =
    process.env.EAGLE_BOTS_CAPTURE_SOURCE ??
    resolve("apps/bots/src/tools/devices/output.ts");
  const dependencies =
    process.env.EAGLE_BOTS_CAPTURE_DEPENDENCIES ??
    resolve("apps/bots/node_modules");
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    copyFileSync(source, join(root, "capture.ts"));
    symlinkSync(dependencies, join(root, "node_modules"), "dir");
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: "",
      NODE_PATH: "",
      NODE_OPTIONS: "",
    };
    for (const name of Object.keys(childEnvironment))
      if (!["PATH", "NODE_PATH", "NODE_OPTIONS"].includes(name))
        delete childEnvironment[name];
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import {readFileSync} from "node:fs";
      const {captureNativeOutput}=await import(process.argv[1]);
      const {secret}=JSON.parse(readFileSync(0,"utf8"));
      const cases=[];
      const streaming=captureNativeOutput({});
      streaming.api.output("A".repeat(59969)+secret+"tail");
      cases.push({name:"stream boundary at 60000",...streaming.finish()});
      const explicit=captureNativeOutput({});
      cases.push({name:"explicit result boundary at 60000",...explicit.finish({output:[{type:"text",text:"A".repeat(59969)+secret+"tail"}]})});
      const metadata=captureNativeOutput({});
      metadata.api.diagnostic({severity:"info",message:"B".repeat(3961)+secret+"tail"});
      cases.push({name:"metadata boundary at 4000",...metadata.finish()});
      for(const sdk of ["structure","diagnostic"]){
        const capture=captureNativeOutput({});
        capture.api.output("SDK "+secret.slice(0,31));
        const result=sdk==="structure"?{structuredOutput:{truncated:true,exitCode:0}}:{diagnostics:[{severity:"warn",code:"truncated",message:"SDK output was truncated"}]};
        cases.push({name:"SDK "+sdk+" truncation",...capture.finish(result)});
      }
      process.stdout.write(JSON.stringify(cases));
    `,
        pathToFileURL(join(root, "capture.ts")).href,
      ],
      {
        input: JSON.stringify({ secret }),
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1048576,
        env: childEnvironment,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const captures = JSON.parse(child.stdout) as {
      name: string;
      output: string;
      exitCode?: number;
    }[];
    for (const captured of captures)
      await t.test(captured.name, async () => {
        const directory = mkdtempSync(join(tmpdir(), "eagle-capture-journal-"));
        const device = {
          deviceId: randomUUID(),
          publicKey: generateKeyPairSync("ed25519")
            .publicKey.export({ type: "spki", format: "der" })
            .toString("base64url"),
          name: "capture",
          platform: "darwin",
          arch: "arm64",
          groupId: null,
          membershipEpoch: 0,
          credentialVersion: 1,
        };
        const runtime = new DeviceRuntime(
          device,
          join(directory, "journal.sqlite"),
          () => [secret],
        );
        const leases = new NativeDeviceLeases(runtime);
        try {
          const operation = {
            kind: "native" as const,
            tool: "bash",
            args: { case: captured.name },
          };
          const request: OperationRequest = {
            requestId: randomUUID(),
            operationId: randomUUID(),
            targetDeviceId: device.deviceId,
            action: "run",
            operation,
            digest: await deviceDigest(canonicalDeviceJSON(operation)),
          };
          const session = { id: randomUUID(), closed: false };
          const admission = await leases.begin(request, session);
          assert.equal(admission.accepted, true);
          assert(admission.leaseId);
          // This is the actual Agent handler behind local.complete, with real
          // SQLite persistence and the same configured-secret callback.
          const result = leases.complete(
            request.operationId,
            admission.leaseId,
            session.id,
            {
              status: "completed",
              output: captured.output,
              exitCode: captured.exitCode ?? 0,
            },
          );
          const outcome = deviceOutcome(
            {
              state: "succeeded",
              stdout: captured.output,
              stderr: "",
              exitCode: 0,
            },
            [secret],
          );
          const journal = runtime.journal.get(request.operationId);
          const queried = await runtime.handle(
            { ...request, action: "get" },
            device,
          );
          assert.equal(result.status, "completed");
          for (const value of [outcome, result, journal, queried]) {
            const text = JSON.stringify(value);
            assert.equal(
              text.includes(secret.slice(0, 8)),
              false,
              "pre-sanitizer truncation must not expose any identifiable known-secret prefix",
            );
            assert.equal(text.includes(secret.slice(0, 31)), false);
            assert.equal(text.includes(secret), false);
          }
        } finally {
          leases.close();
          await runtime.close();
          rmSync(directory, { recursive: true, force: true });
        }
      });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
