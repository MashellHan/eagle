import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import {
  approvalPayload,
  canonicalDeviceJSON,
  type DeviceApproval,
  deviceDigest,
} from "../packages/contracts/src/devices.ts";

test("private helper config boots offline local tools; Bot port cannot change policy or pairing", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-port-"));
  const deviceId = randomUUID();
  const socketPath = join(root, "service.sock");
  const key = generateKeyPairSync("ed25519");
  const child = spawn(process.execPath, ["packages/agent/device-service.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const messages: Record<string, unknown>[] = [];
  const waiters = new Map<string, (value: Record<string, unknown>) => void>();
  let approvalHandler:
    | ((message: Record<string, unknown>) => Promise<void>)
    | undefined;
  const approvalErrors: unknown[] = [];
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += data.toString()));
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    messages.push(message);
    if (message.type === "ready") readyResolve();
    if (message.type === "approve")
      void approvalHandler?.(message).catch((error) =>
        approvalErrors.push(error),
      );
    if (typeof message.requestId === "string")
      waiters.get(message.requestId)?.(message);
  });
  child.once("exit", () => readyReject(new Error(`service exited: ${stderr}`)));
  child.stdin.write(
    `${JSON.stringify({ type: "configure", version: 1, baseUrl: "http://127.0.0.1:1", deviceId, publicKey: key.publicKey.export({ type: "spki", format: "der" }).toString("base64url"), name: "offline-test", platform: "darwin", arch: "arm64", stateDirectory: root, socketPath })}\n`,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`local readiness timeout ${stderr}`)),
          5000,
        );
      }),
    ]);
    clearTimeout(timer);
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    async function request(
      method: string,
      params?: unknown,
    ): Promise<Record<string, unknown>> {
      const socket = connect(socketPath);
      const reader = createInterface({ input: socket });
      return new Promise((resolve, reject) => {
        socket.on("error", reject);
        reader.once("line", (line) => {
          socket.end();
          reader.close();
          resolve(JSON.parse(line));
        });
        socket.write(
          `${JSON.stringify({ requestId: randomUUID(), method, params })}\n`,
        );
      });
    }
    async function trusted(
      method: string,
      params?: unknown,
    ): Promise<Record<string, unknown>> {
      const requestId = randomUUID();
      const response = new Promise<Record<string, unknown>>((resolve) =>
        waiters.set(requestId, resolve),
      );
      child.stdin.write(
        `${JSON.stringify({ type: "manage", requestId, method, params })}\n`,
      );
      return response;
    }
    const status = await request("status");
    assert.equal((status.result as { localReady: boolean }).localReady, true);
    for (const method of [
      "policy.set",
      "pairing.create",
      "pairing.revoke",
      "pairing.redeem",
      "member.remove",
    ]) {
      assert.equal(
        (await request(method, { mode: "all-approve", deviceId })).error,
        "management_requires_private_helper",
      );
    }
    const operation = { kind: "command", command: "printf offline" };
    const input = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: deviceId,
      action: "run",
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    assert.equal(
      ((await request("execute", input)).result as { output: string }).output,
      "offline",
    );
    const changedTarget = await request("execute", {
      ...input,
      targetDeviceId: randomUUID(),
    });
    assert.equal((changedTarget.result as { status: string }).status, "denied");
    const lost = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: randomUUID(),
    };
    assert.equal(
      ((await request("execute", lost)).result as { status: string }).status,
      "unknown",
    );
    assert.equal(
      (
        (await request("execute", { ...lost, targetDeviceId: deviceId }))
          .result as { status: string }
      ).status,
      "denied",
      "an uncertain remote operation cannot become a local retry",
    );
    const lostFile = join(root, "lost-response-count");
    const lostOperation = {
      kind: "command",
      command: `printf x >> '${lostFile}'; sleep 0.1; cat '${lostFile}'`,
    };
    const lostRequest = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
      operation: lostOperation,
      digest: await deviceDigest(canonicalDeviceJSON(lostOperation)),
    };
    const lostSocket = connect(socketPath);
    lostSocket.end(
      `${JSON.stringify({ requestId: randomUUID(), method: "execute", params: lostRequest })}\n`,
    );
    await new Promise<void>((resolveClosed) =>
      lostSocket.once("close", () => resolveClosed()),
    );
    let recoveredCommand: { status: string; output?: string } = {
      status: "running",
    };
    for (
      let attempt = 0;
      attempt < 100 && recoveredCommand.status !== "completed";
      attempt++
    ) {
      recoveredCommand = (
        await request("operation.get", { ...lostRequest, action: "get" })
      ).result as { status: string; output?: string };
      if (recoveredCommand.status !== "completed")
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(recoveredCommand.status, "completed");
    assert.equal(
      (
        (await request("execute", { ...lostRequest, requestId: randomUUID() }))
          .result as { output: string }
      ).output,
      "x",
    );
    assert.equal(readFileSync(lostFile, "utf8"), "x");
    const asking = await trusted("policy.set", { mode: "always-ask" });
    const policyVersion = (asking.result as { version: number }).version;
    const askingOperation = {
      kind: "command",
      command: "printf approved-helper",
    };
    const askingInput = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
      operation: askingOperation,
      digest: await deviceDigest(canonicalDeviceJSON(askingOperation)),
    };
    assert.equal(
      ((await request("execute", askingInput)).result as { status: string })
        .status,
      "denied",
    );
    approvalHandler = async (message) => {
      assert.equal(message.sourceDeviceId, deviceId);
      assert.equal(message.targetDeviceId, deviceId);
      assert.equal(
        message.digest,
        await deviceDigest(canonicalDeviceJSON(message.operation)),
      );
      assert.deepEqual(message.operation, askingOperation);
      const envelope = {
        operationId: message.operationId as string,
        sourceDeviceId: deviceId,
        targetDeviceId: deviceId,
        digest: message.digest as string,
        policyVersion: message.policyVersion as number,
        expiresAt: message.expiresAt as number,
      };
      const signed = {
        ...envelope,
        signature: sign(
          null,
          Buffer.from(approvalPayload(envelope)),
          key.privateKey,
        ).toString("base64url"),
      };
      child.stdin.write(
        `${JSON.stringify({ type: "approval", requestId: message.requestId, approval: signed })}\n`,
      );
    };
    const proposed = await request("approval.request", {
      request: askingInput,
      policyVersion,
      expiresAt: Date.now() + 60000,
    });
    assert.equal(proposed.error, undefined);
    const signed = (proposed.result as { approval: DeviceApproval }).approval;
    assert.equal(
      (
        (
          await request("execute", {
            ...askingInput,
            approval: { ...signed, digest: "0".repeat(64) },
          })
        ).result as { status: string }
      ).status,
      "denied",
    );
    assert.equal(
      (
        (await request("execute", { ...askingInput, approval: signed }))
          .result as { output: string }
      ).output,
      "approved-helper",
    );
    approvalHandler = async (message) => {
      child.stdin.write(
        `${JSON.stringify({ type: "approval", requestId: message.requestId, error: "user_denied" })}\n`,
      );
    };
    const rejected = await request("approval.request", {
      request: { ...askingInput, operationId: randomUUID() },
      policyVersion,
      expiresAt: Date.now() + 60000,
    });
    assert.equal(rejected.error, "helper_request_denied");
    const expired = await request("approval.request", {
      request: askingInput,
      policyVersion,
      expiresAt: Date.now() - 1,
    });
    assert.equal(expired.error, "invalid_approval_request");
    assert.deepEqual(approvalErrors, []);
    assert.equal(
      messages.filter((message) => message.type === "sign").length,
      0,
      "approvals must never use raw signing bridge",
    );
    const managementId = randomUUID();
    const managed = new Promise<Record<string, unknown>>((resolve) =>
      waiters.set(managementId, resolve),
    );
    child.stdin.write(
      `${JSON.stringify({ type: "manage", requestId: managementId, method: "policy.set", params: { mode: "paused" } })}\n`,
    );
    const response = await managed;
    assert.equal((response.result as { mode: string }).mode, "paused");
    const denied = await request("execute", {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
    });
    assert.equal((denied.result as { status: string }).status, "denied");
    assert(
      messages.some(
        (message) => message.type === "cloud" && message.status === "offline",
      ),
    );
    await trusted("policy.set", { mode: "all-approve" });
    const nativeOperation = {
      kind: "native",
      tool: "bash",
      args: { command: "sleep 20" },
    };
    const native = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
      operation: nativeOperation,
      digest: await deviceDigest(canonicalDeviceJSON(nativeOperation)),
    };
    const admission = (await request("local.begin", native)).result as {
      accepted: boolean;
      leaseId: string;
    };
    assert.equal(admission.accepted, true);
    assert.equal(typeof admission.leaseId, "string");
    let recovered = "running";
    for (let attempt = 0; attempt < 30 && recovered === "running"; attempt++) {
      recovered = (
        (await request("operation.get", { ...native, action: "get" }))
          .result as { status: string }
      ).status;
      if (recovered === "running")
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(recovered, "unknown");
    const stale = await request("local.complete", {
      operationId: native.operationId,
      leaseId: admission.leaseId,
      result: { status: "completed" },
    });
    assert.equal(stale.error, "native_lease_mismatch");
    assert.equal(
      (
        (await request("execute", { ...input, operationId: randomUUID() }))
          .result as { status: string }
      ).status,
      "busy",
    );
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    lines.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function serviceConfiguration(root: string) {
  return {
    type: "configure",
    version: 1,
    baseUrl: "http://127.0.0.1:1",
    deviceId: randomUUID(),
    publicKey: generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "der" })
      .toString("base64url"),
    name: "socket-owner",
    platform: "darwin",
    arch: "arm64",
    stateDirectory: root,
    socketPath: join(root, "service.sock"),
  };
}

function serviceProcess() {
  const child = spawn(process.execPath, ["packages/agent/device-service.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const messages: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  lines.on("line", (line) => {
    messages.push(JSON.parse(line));
    for (const listener of listeners) listener();
  });
  child.on("exit", () => {
    for (const listener of listeners) listener();
  });
  return {
    child,
    message(type: string): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`service ${type} timeout: ${stderr}`));
        }, 5000);
        const check = () => {
          const message = messages.find((value) => value.type === type);
          if (message || child.exitCode !== null) {
            clearTimeout(timer);
            listeners.delete(check);
            if (message) resolve(message);
            else reject(new Error(`service exited: ${stderr}`));
          }
        };
        listeners.add(check);
        check();
      });
    },
    async stop() {
      child.stdin.end();
      if (child.exitCode === null)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("service shutdown timeout"));
          }, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      lines.close();
    },
  };
}

async function portCall(socketPath: string, method: string, params?: unknown) {
  const socket = connect(socketPath);
  const lines = createInterface({ input: socket });
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("port timeout")), 3000);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      lines.once("line", (line) => {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
      socket.write(
        `${JSON.stringify({ requestId: randomUUID(), method, params })}\n`,
      );
    });
  } finally {
    lines.close();
    socket.destroy();
  }
}

test("failed second service never unlinks the first process's live socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-owner-"));
  const configuration = serviceConfiguration(root);
  const first = serviceProcess();
  const second = serviceProcess();
  try {
    first.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    await first.message("ready");
    const owner = statSync(configuration.socketPath);
    second.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    assert.equal(
      (await second.message("failed")).error,
      "device_initialization_failed",
    );
    await second.stop();
    assert.equal(
      existsSync(configuration.socketPath),
      true,
      "failed initialization must preserve the live owner's path",
    );
    assert.equal(statSync(configuration.socketPath).ino, owner.ino);
    assert.equal(
      (
        (await portCall(configuration.socketPath, "status")).result as {
          localReady: boolean;
        }
      ).localReady,
      true,
    );
  } finally {
    await Promise.all([first.stop(), second.stop()]);
    rmSync(root, { recursive: true, force: true });
  }
});
