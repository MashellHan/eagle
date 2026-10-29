import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { heldCommand, stopHeldCommand } from "./held-command.ts";

// Retained integration proof: local model SSE is the only model-network fixture.
// The daemon, durable Harness, private helper, relay/DO and Agent are production code.
const repo = fileURLToPath(new URL("../../", import.meta.url));
const source = repo;
const root = realpathSync(process.argv[2]);
const helper = process.argv[3];
const variant = process.argv[4];
assert(["preserved-journal", "missing-journal"].includes(variant));
assert(helper && existsSync(helper));
const helperVariable = "BOTS_CREDENTIAL_HELPER";
process.env.XDG_CONFIG_HOME = join(root, "owned-provider-config");
mkdirSync(process.env.XDG_CONFIG_HOME, { mode: 0o700 });
process.env.BOTS_COMPACTION = "off";

const require = createRequire(join(source, "package.json"));
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { executionWatch } = await import(
  pathToFileURL(join(source, "packages/agent/execution-service.ts"))
);
const { RemoteMachineClient } = await import(
  pathToFileURL(join(source, "apps/bots/src/tools/remote/client.ts"))
);
const { writeGateway } = await import(
  pathToFileURL(join(source, "apps/bots/src/server/gateway.ts"))
);
const worker = join(root, "worker.mjs");

const machine = "retained-daemon-machine";
const owner = "retained-fixture-owner-" + randomUUID();
const agentToken = "retained-fixture-agent-" + randomUUID();
const modelKey = "retained-fixture-model-" + randomUUID();
const state = join(root, "agent-state");
mkdirSync(state, { mode: 0o700 });
const work = join(root, "machine-b-resources");
mkdirSync(work, { mode: 0o700 });
writeFileSync(join(work, "message.txt"), "resource read on machine B");
const botRoot = join(root, "bot-state");
mkdirSync(botRoot, { mode: 0o700 });
let abort = new AbortController();
let mf, agent, daemon, binding;
let assertions = 0;
let modelCalls = 0;
let steps = [];
let modelFailure;
const callNames = new Map();
const pass = (condition, label) => {
  assert(condition, label);
  assertions++;
  console.log("PASS: " + label);
};
const until = async (predicate, label, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    assert(Date.now() < deadline, label);
    await delay(10);
  }
};
const textOf = (output) =>
  typeof output === "string"
    ? output
    : (output ?? []).map((value) => value.text ?? "").join("\n");
const latestResult = (payload, name) => {
  const output = [...payload.input]
    .reverse()
    .find(
      (item) =>
        item.type === "function_call_output" &&
        callNames.get(item.call_id) === name,
    );
  assert(
    output,
    "the real model input contains the previous " + name + " result",
  );
  return JSON.parse(textOf(output.output));
};
const tool = (name, args) => ({ name, args });
const event = (type, fields) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const model = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/responses");
    assert.equal(
      request.headers.authorization === "Bearer " + modelKey,
      true,
      "the isolated model key authenticates locally",
    );
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    assert(
      !raw.includes(owner) && !raw.includes(agentToken),
      "machine credentials must not enter model input",
    );
    const payload = JSON.parse(raw);
    modelCalls++;
    assert(steps.length > 0, "the model fixture received an unexpected turn");
    const planned = steps.shift();
    const step = typeof planned === "function" ? planned(payload) : planned;
    const responseId = "resp_fixture_" + modelCalls;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (typeof step === "string") {
      const item = {
        type: "message",
        id: "msg_fixture_" + modelCalls,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: step, annotations: [] }],
      };
      response.end(
        event("response.created", {
          response: { id: responseId, status: "in_progress" },
        }) +
          event("response.output_item.added", {
            output_index: 0,
            item: { ...item, content: [] },
          }) +
          event("response.output_text.delta", {
            output_index: 0,
            content_index: 0,
            delta: step,
          }) +
          event("response.output_item.done", { output_index: 0, item }) +
          event("response.completed", {
            response: {
              id: responseId,
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          }),
      );
    } else {
      assert(
        payload.tools?.some((value) => value.name === step.name),
        "the composed runtime exposes " + step.name,
      );
      const callId = "call_fixture_" + modelCalls;
      callNames.set(callId, step.name);
      const item = {
        type: "function_call",
        id: "fc_fixture_" + modelCalls,
        call_id: callId,
        name: step.name,
        arguments: JSON.stringify(step.args),
        status: "completed",
      };
      response.end(
        event("response.created", {
          response: { id: responseId, status: "in_progress" },
        }) +
          event("response.output_item.added", {
            output_index: 0,
            item: { ...item, arguments: "" },
          }) +
          event("response.function_call_arguments.delta", {
            output_index: 0,
            delta: item.arguments,
          }) +
          event("response.function_call_arguments.done", {
            output_index: 0,
            arguments: item.arguments,
          }) +
          event("response.output_item.done", { output_index: 0, item }) +
          event("response.completed", {
            response: {
              id: responseId,
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          }),
      );
    }
  } catch (error) {
    modelFailure ??= error;
    if (!response.headersSent)
      response.writeHead(500, { "content-type": "application/json" });
    response.end('{"error":{"message":"isolated fixture assertion failed"}}');
  }
});
const forkedChildren = [];
const childEntry = fileURLToPath(
  new URL("./bot-daemon-child.mjs", import.meta.url),
);
const boot = async () => {
  const child = fork(childEntry, [], {
    execPath: process.execPath,
    execArgv: [],
    env: {
      PATH: dirname(process.execPath) + ":/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      BOTS_ROOT: botRoot,
      BOTS_COMPACTION: "off",
      [helperVariable]: helper,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const pending = new Map();
  let sequence = 0;
  const done = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  forkedChildren.push({ child, done });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimer = setTimeout(
    () => readyReject(new Error("fixture daemon startup deadline")),
    15_000,
  );
  child.on("message", (message) => {
    if (message.ready) {
      clearTimeout(readyTimer);
      readyResolve(message);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error)
      entry.reject(new Error("fixture daemon RPC " + message.error));
    else entry.resolve(message.result);
  });
  const fail = () => {
    clearTimeout(readyTimer);
    readyReject(new Error("fixture daemon exited before ready"));
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("fixture daemon process exited"));
    }
    pending.clear();
  };
  child.once("error", fail);
  child.once("exit", fail);
  const rpc = (action, fields = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("fixture daemon RPC deadline"));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, action, ...fields }, (error) => {
        if (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error("fixture daemon IPC closed"));
        }
      });
    });
  const started = await ready;
  return {
    port: started.port,
    token: readFileSync(join(botRoot, "token"), "utf8").trim(),
    registry: {
      create: (title, trace) => rpc("create", { title, trace }),
      open: async (bot, trace) => {
        await rpc("open", { bot, trace });
        return {
          submit: (request) => rpc("submit", { bot, request }),
          submission: (request) => rpc("submission", { bot, request }),
        };
      },
    },
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await rpc("close");
      await done;
    },
    kill: async () => {
      child.kill("SIGKILL");
      assert.deepEqual(await done, { code: null, signal: "SIGKILL" });
    },
  };
};
const invokeHelper = (action, values = {}) =>
  execFileSync(helper, [], {
    input: JSON.stringify({ action, binding, ...values }),
    encoding: "utf8",
    timeout: 15_000,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdio: ["pipe", "pipe", "pipe"],
  });
const grantsApi = (bot, method = "GET", body) =>
  fetch(`http://127.0.0.1:${daemon.port}/v1/bots/${bot}/remote-tools`, {
    method,
    headers: {
      authorization: "Bearer " + daemon.token,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

try {
  await build({
    stdin: {
      contents: `import {executionRoute} from ${JSON.stringify(join(source, "apps/web/src/worker/execution-route.ts"))};
export {MachineState} from ${JSON.stringify(join(source, "apps/web/src/worker/machine.ts"))};
export default {async fetch(request, env) {return await executionRoute(request, env) ?? new Response(null, {status:404});}};`,
      resolveDir: source,
      sourcefile: "retained-daemon-relay.ts",
      loader: "ts",
    },
    outfile: worker,
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const modelAddress = model.address();
  await writeGateway(botRoot, {
    provider: "retained-fixture",
    model: "retained-model",
    baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
    apiKey: modelKey,
    thinkingLevel: "off",
    toolGroups: ["remote"],
  });
  mf = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [
        {
          name: "full-bot-relay",
          modules: true,
          script: readFileSync(worker, "utf8"),
          compatibilityDate: "2026-09-19",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            MACHINES: { className: "MachineState", useSQLite: true },
          },
          bindings: {
            OWNER_TOKEN: owner,
            AGENT_TOKENS: JSON.stringify({ [machine]: agentToken }),
            LOCAL_DEV: "false",
          },
        },
      ],
    }),
    resourcePersistencePath: join(root, "cloud"),
    isolatedResourcePersistencePath: join(root, "cloud"),
  });
  const base = await mf.ready;
  agent = executionWatch(
    {
      url: base.origin,
      machineId: machine,
      machineName: "Retained daemon fixture",
      token: agentToken,
    },
    {
      journalPath: join(state, "operations.sqlite"),
      commands: true,
      workingDirectory: work,
      files: {
        privateRoot: state,
        grants: () => [
          { id: "fixture-files", generation: "fixture-generation", root: work },
        ],
      },
      herdr: { configPath: join(state, "config.json"), binaryCandidates: [] },
    },
    abort.signal,
  );
  agent.catch(() => {});
  await until(async () => {
    const reply = await fetch(
      new URL("/api/v1/execution/status?machine=" + machine, base),
      { headers: { Authorization: "Bearer " + owner } },
    );
    assert.equal(reply.status, 200);
    return (await reply.json()).online;
  }, "the real Agent becomes online");
  daemon = await boot();
  const bot = (
    await daemon.registry.create(
      "Retained remote acceptance",
      "tr_retained_create",
    )
  ).id;
  const first = await grantsApi(bot);
  pass(
    first.status === 200,
    "the actual daemon composition exposes authenticated per-Bot remote settings",
  );
  const initial = (await first.json()).remoteTools;
  pass(
    initial.helperAvailable === true &&
      initial.namespace ===
        createHash("sha256").update(realpathSync(botRoot)).digest("hex"),
    "the main entry binds the actual native helper and canonical daemon namespace",
  );
  const unauthenticated = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/bots/${bot}/remote-tools`,
  );
  pass(
    unauthenticated.status === 401,
    "remote settings require the daemon credential",
  );
  binding = {
    namespace: initial.namespace,
    botId: bot,
    credentialRef: randomUUID(),
    origin: base.origin,
  };
  // Non-secret cleanup receipt lets the wrapper clean this exact item even after a fixture crash.
  writeFileSync(join(root, "binding.json"), JSON.stringify(binding), {
    mode: 0o600,
  });
  pass(
    JSON.parse(invokeHelper("put", { ownerToken: owner })).available === true,
    "the native helper stores the exact isolated per-Bot credential",
  );
  const target = {
    alias: "machine-b",
    enabled: true,
    origin: base.origin,
    machineId: machine,
    credentialRef: binding.credentialRef,
    operations: ["command.exec", "file.read", "herdr.setup"],
  };
  const saved = await grantsApi(bot, "PUT", {
    revision: initial.revision,
    targets: [target],
  });
  pass(
    saved.status === 200,
    "the daemon verifies the real Keychain binding before granting machine access",
  );
  const authority = (await saved.json()).remoteTools;
  const stale = await grantsApi(bot, "PUT", {
    revision: initial.revision,
    targets: [],
  });
  pass(
    stale.status === 409,
    "a stale settings revision cannot revoke or replace newer grants",
  );
  let recoveredResult;
  steps = [
    tool("tool_search", { query: "remote" }),
    tool("remote_execute", {
      target: "machine-b",
      operation: heldCommand(work),
    }),
    (payload) => {
      recoveredResult = latestResult(payload, "remote_execute");
      return "Crash recovery finished.";
    },
  ];
  const handle = await daemon.registry.open(bot, "tr_retained_crash_open");
  const interruptedSubmission = await handle.submit({
    requestId: "r_retained_interrupted",
    text: "Execute once through the target machine.",
    whenBusy: "followUp",
    trace: "tr_retained_crash",
  });
  await until(
    () => existsSync(join(work, "attempts")),
    "the target applied its side effect",
  );
  pass(
    readFileSync(join(work, "attempts"), "utf8") === "once\n",
    "the actual target applied its one side effect and is held before completion",
  );
  await daemon.kill();
  daemon = undefined;
  pass(
    steps.length === 1,
    "SIGKILL interrupts the real daemon before its tool result reaches the model",
  );
  const memoIds = new Set();
  const scanMemo = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scanMemo(path);
      else if (entry.isFile())
        for (const id of readFileSync(path)
          .toString("latin1")
          .match(/br_[a-f0-9]{64}/g) ?? [])
          memoIds.add(id);
    }
  };
  scanMemo(join(botRoot, "bots", bot));
  assert.equal(
    memoIds.size,
    1,
    "the killed Bot persisted exactly one remote operation identity",
  );
  const admitted = { id: [...memoIds][0] };
  const control = new RemoteMachineClient({
    read: async (value) => ({ binding: value, ownerToken: owner }),
    status: async () => true,
    remove: async () => {},
  });
  const destination = {
    namespace: binding.namespace,
    botId: bot,
    revision: authority.revision,
    target,
  };
  const record = async () => {
    try {
      const value = await control.request(
        destination,
        { type: "get", operationId: admitted.id },
        () => {},
      );
      assert.equal(value.type, "result");
      return value.operation;
    } catch (error) {
      if (error.code === "not_found") return undefined;
      throw error;
    }
  };
  pass(
    (await record())?.state === "running",
    "the real Agent keeps the operation running after Bot SIGKILL",
  );
  writeFileSync(join(work, "release"), "finish");
  await until(
    async () => (await record())?.state === "succeeded",
    "the independent Agent finishes with the Bot process gone",
  );
  const status = async () => {
    const reply = await fetch(
      new URL("/api/v1/execution/status?machine=" + machine, base),
      { headers: { Authorization: "Bearer " + owner } },
    );
    assert.equal(reply.status, 200);
    return reply.json();
  };
  if (variant === "missing-journal") {
    abort.abort();
    await agent;
    agent = undefined;
    await until(
      async () => !(await status()).online,
      "the fixture Agent disconnects before replacing only its owned journal",
    );
    rmSync(state, { recursive: true, force: true });
    mkdirSync(state, { mode: 0o700 });
    abort = new AbortController();
    agent = executionWatch(
      {
        url: base.origin,
        machineId: machine,
        machineName: "Retained daemon fixture",
        token: agentToken,
      },
      {
        journalPath: join(state, "operations.sqlite"),
        commands: true,
        workingDirectory: work,
      },
      abort.signal,
    );
    agent.catch(() => {});
    await until(
      async () => (await status()).online,
      "the same fixture identity reconnects with an empty journal",
    );
    pass(
      (await record()) === undefined,
      "the target journal is genuinely absent before Bot recovery",
    );
  }
  daemon = await boot();
  const resumed = await daemon.registry.open(bot, "tr_retained_crash_reopen");
  await until(
    async () => {
      const value = await resumed.submission({
        submissionId: interruptedSubmission.id,
      });
      return value?.status === "done" || value?.status === "unanswered";
    },
    "the actual Harness resumes the interrupted tool",
    30_000,
  );
  if (modelFailure) throw modelFailure;
  pass(
    (await resumed.submission({ submissionId: interruptedSubmission.id }))
      ?.status === "done" && steps.length === 0,
    "the restarted real Harness recovers the interrupted submission through its persisted SDK state",
  );
  pass(
    recoveredResult?.operationId === admitted.id &&
      typeof recoveredResult.receipt === "string",
    "SDK memo recovery retains the original remote operation identity and receipt",
  );
  if (variant === "preserved-journal") {
    pass(
      recoveredResult.result?.operation?.state === "succeeded" &&
        recoveredResult.result.operation.stdout === realpathSync(work),
      "crash recovery queries the original result from the preserved machine journal",
    );
  } else {
    pass(
      recoveredResult.error === "not_found" &&
        recoveredResult.result === undefined,
      "a missing target journal returns not_found instead of silently repeating the command",
    );
    pass(
      (await record()) === undefined,
      "recovery did not admit another run into the replacement target journal",
    );
  }
  pass(
    readFileSync(join(work, "attempts"), "utf8") === "once\n",
    "the interrupted command side effect occurs exactly once across SIGKILL and recovery",
  );
  pass(
    (await status()).online && modelCalls === 3,
    "the Agent stays online and recovery adds only the final model turn",
  );
} catch (error) {
  const secrets = [owner, agentToken, modelKey];
  const message = secrets
    .reduce(
      (value, secret) => value.split(secret).join("[REDACTED]"),
      String(error.message ?? error.name),
    )
    .slice(0, 1000);
  console.log(
    JSON.stringify({
      failure: "recovery-assertion",
      message,
      assertions,
      modelCalls,
    }),
  );
  process.exitCode = 1;
} finally {
  const failures = [];
  const cleanup = async (name, action) => {
    try {
      await action();
    } catch {
      failures.push(name);
    }
  };
  await cleanup("daemon-close", async () => {
    await daemon?.close();
  });
  for (const { child, done } of forkedChildren) {
    await cleanup("daemon-process", async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await done;
      }
    });
  }
  abort.abort();
  await cleanup("agent-stop", async () => {
    if (agent) await agent;
  });
  const commandStopped = await stopHeldCommand(work);
  if (!commandStopped) failures.push("held-command");
  await cleanup("relay-dispose", async () => {
    await mf?.dispose();
  });
  await cleanup(
    "model-close",
    () =>
      new Promise((resolve) => {
        model.close(resolve);
        model.closeAllConnections();
      }),
  );
  let fixtureKeychainItemRemoved = binding === undefined;
  await cleanup("keychain-binding", () => {
    if (binding !== undefined) {
      invokeHelper("remove");
      fixtureKeychainItemRemoved =
        JSON.parse(invokeHelper("status")).available === false;
      assert(fixtureKeychainItemRemoved);
    }
  });
  const fixtureProcessesStopped =
    commandStopped &&
    forkedChildren.every(
      ({ child }) => child.exitCode !== null || child.signalCode !== null,
    );
  if (
    failures.length ||
    !fixtureProcessesStopped ||
    !fixtureKeychainItemRemoved
  )
    process.exitCode = 1;
  console.log(
    JSON.stringify({
      check: variant,
      passed: process.exitCode !== 1,
      assertions,
      modelCalls,
      fixtureProcessesStopped,
      fixtureKeychainItemRemoved,
      cleanupFailures: failures,
    }),
  );
}
