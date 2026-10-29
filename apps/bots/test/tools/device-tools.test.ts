import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Log, type LogRecord } from "../../src/log/log.ts";
import {
  canonicalJSON,
  type DeviceDirectory,
  type DeviceRequest,
  type DeviceResult,
  operationDigest,
  type SharedDevicePort,
} from "../../src/tools/devices/port.ts";
import { deviceExtension, guardNativeTool } from "../../src/tools/devices/tools.ts";

const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const directory = (): DeviceDirectory => ({
  localDeviceId: required(ids[0]),
  groupId: "group-test",
  revision: 1,
  devices: ids.map((deviceId, index) => ({
    deviceId,
    name: `Mac ${index}`,
    platform: "darwin",
    arch: "arm64",
    online: true,
    lastSeenAt: 1000,
    capabilities: ["command", "file.read", "file.write", "file.list"],
    policy: { mode: "all-approve", version: 1 },
  })),
});
const memoApi = () => {
  const memos = new Map<string, unknown>();
  const api = {
    callId: randomUUID(),
    conversationId: 1,
    agent: async () => ({ cwd: "/tmp" }),
    memo: async (name: string, candidate: unknown, context?: unknown) => {
      if (context === undefined) return memos.get(name);
      if (!memos.has(name)) memos.set(name, structuredClone(candidate));
      return memos.get(name);
    },
  } as unknown as ToolExecutionApi;
  return { api, memos };
};
const fixture = () => {
  const view = directory();
  const calls: DeviceRequest[] = [];
  const approvals: DeviceRequest[] = [];
  const finishes: DeviceResult[] = [];
  const port: SharedDevicePort = {
    version: 1,
    directory: async () => view,
    request: async (request) => {
      calls.push(structuredClone(request));
      return { status: "completed", output: "from target" };
    },
    approve: async (request, policyVersion) => {
      approvals.push(request);
      return {
        operationId: request.operationId,
        sourceDeviceId: view.localDeviceId,
        targetDeviceId: request.targetDeviceId,
        digest: required(request.digest),
        policyVersion,
        expiresAt: Date.now() + 60000,
        signature: "signed-by-test-helper",
      };
    },
    begin: async (request) => {
      calls.push(request);
      return {
        accepted: true,
        result: { status: "running" },
        signal: new AbortController().signal,
        complete: async (result) => {
          finishes.push(result);
          return result;
        },
        close: () => {},
      };
    },
  };
  const tools = deviceExtension({ botId: "bot-existing", port }).tools ?? [];
  const invoke = (name: string, args: object, api = memoApi().api) =>
    (required(tools.find((tool) => tool.name === name)) as ToolRegistration).execute(
      args,
      api,
      BACKGROUND_CONTEXT,
    );
  return { port, view, calls, approvals, finishes, invoke };
};
const body = (value: ToolExecutionResult) =>
  JSON.parse(value.output?.find((part) => part.type === "text")?.text ?? "null");

test("existing and new Bot adapters read the same changing four-member directory", async () => {
  const bench = fixture();
  assert.equal(body(await bench.invoke("remote_status", {})).devices.length, 4);
  required(bench.view.devices[1]).name = "Renamed B";
  bench.view.revision++;
  const tools = required(deviceExtension({ botId: "new-bot", port: bench.port }).tools);
  const status = required(tools.find((tool) => tool.name === "remote_status"));
  assert.equal(
    body(await status.execute({}, memoApi().api, BACKGROUND_CONTEXT)).devices[1].name,
    "Renamed B",
  );
  bench.port.directory = async () => {
    throw new Error("cloud_unavailable");
  };
  assert.equal(body(await bench.invoke("remote_status", {})).error, "cloud_unavailable");
});

test("transmission is memoed first; lost replies and replay query the original target and ID", async () => {
  const bench = fixture();
  const { api, memos } = memoApi();
  bench.port.request = async (request) => {
    assert.equal(memos.get("device.transmitted.v1"), true);
    bench.calls.push(structuredClone(request));
    if (request.action === "run") throw new Error("device_disconnected");
    return { status: "completed", output: "original result" };
  };
  const args = { deviceId: ids[1], operation: { kind: "command", command: "pwd" } };
  const first = body(await bench.invoke("remote_execute", args, api));
  assert.equal(first.status, "unknown");
  required(bench.view.devices[1]).online = false;
  const replay = body(await bench.invoke("remote_execute", args, api));
  assert.equal(replay.operationId, first.operationId);
  assert.equal(replay.targetDeviceId, ids[1]);
  assert.deepEqual(
    bench.calls.map((call) => call.action),
    ["run", "get"],
  );
  assert.equal(
    bench.calls.every((call) => call.sourceBotId === "bot-existing"),
    true,
  );
  assert.equal(
    body(await bench.invoke("remote_execute", { ...args, deviceId: ids[2] }, api)).error,
    "operation_binding_changed",
  );
  assert.equal(bench.calls.length, 2);
});

test("offline, unknown, unsupported, paused and refused approval never execute or choose another device", async () => {
  for (const state of ["offline", "unknown", "unsupported", "paused", "ask", "missing", "policy"]) {
    const bench = fixture();
    const target = required(bench.view.devices[1]);
    if (state === "offline") target.online = false;
    if (state === "unknown") target.online = null;
    if (state === "unsupported") target.capabilities = null;
    if (state === "paused") required(target.policy).mode = "paused";
    if (state === "policy") target.policy = null;
    if (state === "missing") bench.view.devices.splice(1, 1);
    if (state === "ask") {
      required(target.policy).mode = "always-ask";
      bench.port.approve = async () => {
        throw new Error("approval_denied");
      };
    }
    const result = await bench.invoke("remote_execute", {
      deviceId: ids[1],
      operation: { kind: "command", command: "pwd" },
    });
    assert.equal(result.isError, true, state);
    assert.equal(bench.calls.length, 0, state);
  }
});

test("approval receives full immutable parameters and get/cancel never requests a new approval", async () => {
  const bench = fixture();
  required(bench.view.devices[2]).policy = { mode: "always-ask", version: 12 };
  const operation = { kind: "file.write", path: "/tmp/a", content: "hello" };
  const first = body(await bench.invoke("remote_execute", { deviceId: ids[2], operation }));
  assert.equal(first.status, "completed");
  assert.deepEqual(required(bench.approvals[0]).operation, operation);
  assert.equal(required(required(bench.calls[0]).approval).policyVersion, 12);
  assert.equal(required(bench.calls[0]).digest, operationDigest(operation));
  for (const action of ["get", "cancel"])
    await bench.invoke("remote_operation", {
      deviceId: ids[2],
      operationId: first.operationId,
      action,
    });
  assert.equal(bench.approvals.length, 1);
  assert.equal(
    bench.calls.every((call) => call.targetDeviceId === ids[2]),
    true,
  );
  bench.port.request = async () => {
    throw new Error("not a safe message with secret");
  };
  assert.equal(
    body(
      await bench.invoke("remote_operation", {
        deviceId: ids[2],
        operationId: first.operationId,
        action: "get",
      }),
    ).error,
    "device_request_failed",
  );
});

test("native tools require admission before touching real files and replay never invokes them twice", async () => {
  const bench = fixture();
  const root = await mkdtemp(join(tmpdir(), "native-policy-"));
  let runs = 0;
  const native = defineTool({
    name: "write",
    parameters: Type.Object({ content: Type.String() }),
    description: "test native implementation",
    async execute(args) {
      runs++;
      await writeFile(join(root, "out"), args.content);
      return { output: [{ type: "text" as const, text: "native result" }] };
    },
  });
  const guarded = guardNativeTool(native, { botId: "native-bot", port: bench.port });
  try {
    const realBegin = bench.port.begin;
    bench.port.begin = async () => ({ accepted: false, result: { status: "busy" } });
    assert.equal(
      body(await guarded.execute({ content: "denied" }, memoApi().api, BACKGROUND_CONTEXT)).status,
      "busy",
    );
    await assert.rejects(readFile(join(root, "out")), { code: "ENOENT" });
    bench.port.begin = realBegin;
    const { api } = memoApi();
    await guarded.execute({ content: "accepted" }, api, BACKGROUND_CONTEXT);
    await guarded.execute({ content: "accepted" }, api, BACKGROUND_CONTEXT);
    assert.equal(runs, 1);
    assert.equal(await readFile(join(root, "out"), "utf8"), "accepted");
    assert.equal(required(bench.finishes[0]).status, "completed");
    assert.equal(required(bench.calls[0]).targetDeviceId, bench.view.localDeviceId);
    assert.equal(required(required(bench.calls[0]).operation).kind, "native");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native completion returns host-sanitized output and storage failure is unknown without a second settlement", async () => {
  const bench = fixture();
  let finishes = 0;
  let fail = false;
  bench.port.begin = async () => ({
    accepted: true,
    result: { status: "running" },
    signal: new AbortController().signal,
    complete: async () => {
      finishes++;
      if (fail) throw new Error("storage_failed");
      return { status: "completed", output: "[redacted]" };
    },
    close: () => {},
  });
  const original = defineTool({
    name: "read",
    description: "fixture",
    parameters: Type.Object({}),
    async execute() {
      return { output: [{ type: "text" as const, text: "private synthetic value" }] };
    },
  });
  const tool = guardNativeTool(original, { botId: "bot", port: bench.port });
  assert.deepEqual((await tool.execute({}, memoApi().api, BACKGROUND_CONTEXT)).output, [
    { type: "text", text: "[redacted]" },
  ]);
  assert.equal(finishes, 1);
  fail = true;
  const result = body(await tool.execute({}, memoApi().api, BACKGROUND_CONTEXT));
  assert.equal(result.status, "unknown");
  assert.equal(finishes, 2);
  original.execute = async () => {
    throw new Error("native_failed");
  };
  fail = false;
  await guardNativeTool(original, { botId: "bot", port: bench.port }).execute(
    {},
    memoApi().api,
    BACKGROUND_CONTEXT,
  );
  assert.equal(finishes, 3);
});

test("v1 canonical parameters use ordered keys and preserve Unicode/slashes/control characters", () => {
  assert.equal(
    canonicalJSON({ z: "书/房\n", a: [1, true, null] }),
    '{"a":[1,true,null],"z":"书/房\\n"}',
  );
  assert.equal(
    operationDigest({ kind: "command", command: "pwd" }),
    operationDigest({ command: "pwd", kind: "command" }),
  );
});

test("the independent adapter uses the same canonical wire vectors as the App helper", async () => {
  const vector = JSON.parse(
    await readFile(
      new URL(
        "../../../../fixtures/bots-protocol/device-access-v1/canonical.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(canonicalJSON(vector.operation), vector.canonical);
  assert.equal(operationDigest(vector.operation), vector.digest);
});

test("device crossings record one trace and origin without arguments, receipts or secrets", async () => {
  const bench = fixture();
  const records: LogRecord[] = [];
  const tools = required(
    deviceExtension({
      botId: "bot",
      port: bench.port,
      log: new Log((record) => records.push(record)),
    }).tools,
  );
  const status = required(tools.find((tool) => tool.name === "remote_status"));
  await status.execute({}, memoApi().api, BACKGROUND_CONTEXT);
  bench.port.directory = async () => {
    throw new Error("secret command and credentials");
  };
  await status.execute({}, memoApi().api, BACKGROUND_CONTEXT);
  assert.deepEqual(
    records.map((record) => record.evt),
    ["runtime.device.start", "runtime.device.ok", "runtime.device.start", "runtime.device.fail"],
  );
  assert.equal(required(records[0]).trace, required(records[1]).trace);
  assert.equal(required(records[2]).trace, required(records[3]).trace);
  assert.equal(required(required(records[3]).err).origin, true);
  assert.equal(records.filter((record) => record.level === "error").length, 1);
  assert.equal(JSON.stringify(records).includes("secret"), false);
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Required fixture value is absent");
  return value;
}
