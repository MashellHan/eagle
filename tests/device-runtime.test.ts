import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DeviceRuntime } from "../packages/agent/device-runtime.ts";
import {
  approvalPayload,
  canonicalDeviceJSON,
  type Device,
  deviceDigest,
  type OperationRequest,
} from "../packages/contracts/src/devices.ts";

function local() {
  const keys = generateKeyPairSync("ed25519");
  const device: Device = {
    deviceId: randomUUID(),
    publicKey: keys.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
    name: "test",
    platform: "darwin",
    arch: "arm64",
    groupId: null,
    membershipEpoch: 0,
    credentialVersion: 1,
  };
  return { device, keys };
}
async function request(
  deviceId: string,
  operation: OperationRequest["operation"],
): Promise<OperationRequest> {
  return {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: deviceId,
    action: "run",
    operation,
    digest: await deviceDigest(canonicalDeviceJSON(operation)),
  };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "device-runtime-"));
  const { device, keys } = local();
  const runtime = new DeviceRuntime(device, join(directory, "journal.sqlite"));
  return {
    directory,
    device,
    keys,
    runtime,
    close: async () => {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("journal admits before command side effects and original ID never reruns", async () => {
  const f = fixture();
  try {
    const file = join(f.directory, "count");
    const input = await request(f.device.deviceId, {
      kind: "command",
      command: `printf x >> '${file}'; cat '${file}'`,
    });
    const first = await f.runtime.handle(input, f.device);
    assert.equal(first.status, "completed");
    assert.equal(first.output, "x");
    assert.deepEqual(
      await f.runtime.handle({ ...input, requestId: randomUUID() }, f.device),
      first,
    );
    assert.equal(readFileSync(file, "utf8"), "x");
    assert.equal(
      (
        await f.runtime.handle(
          { ...input, operation: { kind: "command", command: "echo changed" } },
          f.device,
        )
      ).status,
      "denied",
    );
  } finally {
    await f.close();
  }
});
test("one target is busy while get/cancel remain available and an unknown ID cannot execute", async () => {
  const f = fixture();
  try {
    const input = await request(f.device.deviceId, {
      kind: "command",
      command: "sleep 20",
      timeoutMs: 30000,
    });
    const pending = f.runtime.handle(input, f.device);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      (await f.runtime.handle({ ...input, action: "get" }, f.device)).status,
      "running",
    );
    const second = await request(f.device.deviceId, {
      kind: "command",
      command: "echo second",
    });
    assert.equal((await f.runtime.handle(second, f.device)).status, "busy");
    await f.runtime.handle({ ...input, action: "cancel" }, f.device);
    assert.equal((await pending).status, "unknown");
    assert.equal(
      (await f.runtime.handle({ ...second, action: "get" }, f.device)).status,
      "unknown",
    );
  } finally {
    await f.close();
  }
});
test("native tools share policy/journal admission and duplicate begin cannot invoke tool again", async () => {
  const f = fixture();
  try {
    const input = await request(f.device.deviceId, {
      kind: "native",
      tool: "bash",
      args: { command: "echo native" },
    });
    assert.equal((await f.runtime.beginNative(input, f.device)).accepted, true);
    assert.equal(
      (await f.runtime.beginNative(input, f.device)).accepted,
      false,
    );
    const command = await request(f.device.deviceId, {
      kind: "command",
      command: "echo overlap",
    });
    assert.equal((await f.runtime.handle(command, f.device)).status, "busy");
    assert.equal(
      f.runtime.completeNative(input.operationId, {
        status: "completed",
        output: "native",
      }).status,
      "completed",
    );
    assert.equal(
      (await f.runtime.beginNative(input, f.device)).accepted,
      false,
    );
    assert.equal((await f.runtime.handle(input, f.device)).status, "denied");
  } finally {
    await f.close();
  }
});
test("persisted native running operations recover unknown and another journal owner is rejected", async () => {
  const f = fixture();
  const input = await request(f.device.deviceId, {
    kind: "native",
    tool: "write",
    args: { path: "example" },
  });
  try {
    await f.runtime.beginNative(input, f.device);
    assert.throws(
      () => new DeviceRuntime(f.device, join(f.directory, "journal.sqlite")),
    );
    await f.runtime.close();
    const recovered = new DeviceRuntime(
      f.device,
      join(f.directory, "journal.sqlite"),
    );
    try {
      assert.equal(
        (await recovered.handle({ ...input, action: "get" }, f.device)).status,
        "unknown",
      );
      assert.equal(
        (await recovered.beginNative(input, f.device)).accepted,
        false,
      );
    } finally {
      await recovered.close();
    }
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test("always ask verifies operation-bound signature and paused blocks new operations", async () => {
  const f = fixture();
  try {
    const input = await request(f.device.deviceId, {
      kind: "command",
      command: "printf approved",
    });
    f.runtime.setPolicy("always-ask");
    assert.equal((await f.runtime.handle(input, f.device)).status, "denied");
    const envelope = {
      operationId: input.operationId,
      sourceDeviceId: f.device.deviceId,
      targetDeviceId: f.device.deviceId,
      digest: input.digest as string,
      policyVersion: f.runtime.policy.version,
      expiresAt: Date.now() + 60000,
    };
    const approved = {
      ...input,
      approval: {
        ...envelope,
        signature: sign(
          null,
          Buffer.from(approvalPayload(envelope)),
          f.keys.privateKey,
        ).toString("base64url"),
      },
    };
    assert.equal(
      (
        await f.runtime.handle(
          {
            ...approved,
            approval: { ...approved.approval, digest: "0".repeat(64) },
          },
          f.device,
        )
      ).status,
      "denied",
    );
    assert.equal(
      (await f.runtime.handle(approved, f.device)).output,
      "approved",
    );
    f.runtime.setPolicy("paused");
    const next = await request(f.device.deviceId, {
      kind: "command",
      command: "echo forbidden",
    });
    assert.equal((await f.runtime.handle(next, f.device)).status, "denied");
    assert.equal(
      (await f.runtime.handle({ ...input, action: "get" }, f.device)).status,
      "completed",
    );
  } finally {
    await f.close();
  }
});

test("lost native ownership remains blocked across timeout/restart until original completion evidence", async () => {
  const { NativeDeviceLeases } = await import(
    "../packages/agent/device-native-leases.ts"
  );
  const f = fixture();
  try {
    const leases = new NativeDeviceLeases(f.runtime, 30);
    const session = { id: randomUUID(), closed: false };
    const input = await request(f.device.deviceId, {
      kind: "native",
      tool: "bash",
      args: { command: "sleep 20" },
    });
    const first = await leases.begin(input, session);
    assert.equal(first.accepted, true);
    assert(first.leaseId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      (await f.runtime.handle({ ...input, action: "get" }, f.device)).status,
      "unknown",
    );
    const other = await request(f.device.deviceId, {
      kind: "command",
      command: "printf overlap",
    });
    assert.equal((await f.runtime.handle(other, f.device)).status, "busy");
    assert.throws(() =>
      leases.complete(input.operationId, randomUUID(), session.id, {
        status: "completed",
      }),
    );
    assert.throws(() =>
      leases.complete(
        input.operationId,
        first.leaseId as string,
        randomUUID(),
        { status: "completed" },
      ),
    );
    assert.equal(
      leases.complete(input.operationId, first.leaseId as string, session.id, {
        status: "completed",
        output: "owner finished",
      }).status,
      "completed",
    );
    assert.equal((await f.runtime.handle(other, f.device)).output, "overlap");
    const second = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
    };
    const accepted = await leases.begin(second, session);
    assert.equal(accepted.accepted, true);
    session.closed = true;
    leases.disconnect(session.id);
    assert.equal(
      (
        await f.runtime.handle(
          { ...other, operationId: randomUUID() },
          f.device,
        )
      ).status,
      "busy",
    );
    leases.close();
    await f.runtime.close();
    const recovered = new DeviceRuntime(
      f.device,
      join(f.directory, "journal.sqlite"),
    );
    try {
      assert.equal(
        (await recovered.handle({ ...second, action: "get" }, f.device)).status,
        "unknown",
      );
      assert.equal(
        (
          await recovered.handle(
            { ...other, operationId: randomUUID() },
            f.device,
          )
        ).status,
        "busy",
      );
    } finally {
      await recovered.close();
    }
  } finally {
    await f.close();
  }
});

test("policy changed while a real approval signature verifies cannot admit side effects", async () => {
  const f = fixture();
  const original = crypto.subtle.verify.bind(crypto.subtle);
  let enter: () => void;
  let release: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.runtime.setPolicy("always-ask");
    const input = await request(f.device.deviceId, {
      kind: "command",
      command: "printf must-not-run",
    });
    const envelope = {
      operationId: input.operationId,
      sourceDeviceId: f.device.deviceId,
      targetDeviceId: f.device.deviceId,
      digest: input.digest as string,
      policyVersion: f.runtime.policy.version,
      expiresAt: Date.now() + 60000,
    };
    input.approval = {
      ...envelope,
      signature: sign(
        null,
        Buffer.from(approvalPayload(envelope)),
        f.keys.privateKey,
      ).toString("base64url"),
    };
    crypto.subtle.verify = async (
      ...args: Parameters<SubtleCrypto["verify"]>
    ) => {
      const verified = await original(...args);
      enter();
      await blocked;
      return verified;
    };
    const running = f.runtime.handle(input, f.device);
    await entered;
    f.runtime.setPolicy("paused");
    release?.();
    assert.equal((await running).status, "denied");
    assert.equal(
      (await f.runtime.handle({ ...input, action: "get" }, f.device)).status,
      "unknown",
    );
  } finally {
    crypto.subtle.verify = original;
    release?.();
    await f.close();
  }
});
