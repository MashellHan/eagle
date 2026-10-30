import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type DeviceInstallerSystem,
  type InstalledDeviceJob,
  installDeviceCandidate,
} from "../apps/macos/Scripts/install-device-app.ts";

function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "eagle-device-install-")),
  );
  const source = join(root, "source", "Eagle Device Candidate.app");
  const destination = join(root, "Applications", "Eagle Device Candidate.app");
  for (const [path, value] of [
    [source, "new"],
    [destination, "old"],
  ]) {
    mkdirSync(path as string, { recursive: true });
    writeFileSync(join(path as string, "payload"), value as string);
  }
  const payload = (path: string) => readFileSync(join(path, "payload"), "utf8");
  let job: InstalledDeviceJob | undefined = {
    pid: 42,
    program: join(
      destination,
      "Contents/Library/LaunchServices/EagleDeviceHelper",
    ),
  };
  let alive = true;
  const events: string[] = [];
  const system: DeviceInstallerSystem = {
    helperPath: (bundle) =>
      join(bundle, "Contents/Library/LaunchServices/EagleDeviceHelper"),
    verify(bundle) {
      assert(["old", "new"].includes(payload(bundle)));
      events.push(`verify:${payload(bundle)}`);
    },
    supportsMaintenance: () => true,
    copy: (from, to) => cpSync(from, to, { recursive: true }),
    quit(bundle) {
      assert.equal(bundle, destination);
      assert.equal(payload(destination), "old");
      events.push("quit");
    },
    job: () => job,
    prepare(bundle) {
      assert.equal(payload(destination), "old");
      events.push(`prepare:${payload(bundle)}`);
      job = undefined;
      alive = false;
    },
    processExists: () => alive,
    open(bundle) {
      assert.equal(bundle, destination);
      events.push(`open:${payload(bundle)}`);
    },
  };
  return {
    root,
    source,
    destination,
    system,
    events,
    payload,
    setJob: (value: InstalledDeviceJob | undefined) => {
      job = value;
    },
    setAlive: (value: boolean) => {
      alive = value;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("candidate upgrade unregisters through the old bundle before replacing it", () => {
  const f = fixture();
  try {
    const result = installDeviceCandidate(f.source, f.destination, f.system);
    assert.equal(f.payload(f.destination), "new");
    assert(result.backup);
    assert.equal(f.payload(result.backup), "old");
    assert(f.events.includes("prepare:old"));
    assert(f.events.indexOf("quit") < f.events.indexOf("prepare:old"));
    assert.equal(f.events.at(-1), "open:new");
  } finally {
    f.cleanup();
  }
});

test("upgrade checks the old bundle's job before and after unregistering", () => {
  const f = fixture();
  const job = f.system.job;
  const inspected: (string | undefined)[] = [];
  f.system.job = (bundle?: string) => {
    inspected.push(bundle);
    return job(f.destination);
  };
  try {
    installDeviceCandidate(f.source, f.destination, f.system);
    assert.deepEqual(inspected, [f.destination, f.destination]);
  } finally {
    f.cleanup();
  }
});

test("legacy migration uses the new signed bundle and confirms the old job is gone", () => {
  const f = fixture();
  f.system.supportsMaintenance = (bundle) => bundle !== f.destination;
  try {
    installDeviceCandidate(f.source, f.destination, f.system);
    assert(f.events.includes("prepare:new"));
    assert.equal(f.payload(f.destination), "new");
  } finally {
    f.cleanup();
  }
});

test("installer checks the current versioned helper path from the installed bundle", () => {
  const f = fixture();
  f.system.helperPath = (bundle) =>
    join(
      bundle,
      "Contents/Library/LaunchServices/EagleDeviceHelper.1793336081495",
    );
  f.setJob({ pid: 42, program: f.system.helperPath(f.destination) });
  try {
    installDeviceCandidate(f.source, f.destination, f.system);
    assert.equal(f.payload(f.destination), "new");
  } finally {
    f.cleanup();
  }
});

for (const failure of ["callback", "job", "process"] as const) {
  test(`failed ${failure} preparation leaves the old bundle intact`, () => {
    const f = fixture();
    f.system.prepare = () => {
      if (failure === "callback") throw new Error("unregister failed");
      if (failure !== "job") f.setJob(undefined);
      if (failure !== "process") f.setAlive(false);
    };
    try {
      assert.throws(() =>
        installDeviceCandidate(f.source, f.destination, f.system),
      );
      assert.equal(f.payload(f.destination), "old");
      assert.equal(f.payload(f.source), "new");
      assert(!f.events.includes("open:new"));
    } finally {
      f.cleanup();
    }
  });
}

test("an invalid replacement is rejected before quitting the installed app", () => {
  const f = fixture();
  f.system.verify = () => {
    throw new Error("invalid signature");
  };
  try {
    assert.throws(
      () => installDeviceCandidate(f.source, f.destination, f.system),
      /invalid signature/,
    );
    assert.equal(f.payload(f.destination), "old");
    assert(!f.events.includes("quit"));
  } finally {
    f.cleanup();
  }
});

test("a service from another candidate path is left untouched", () => {
  const f = fixture();
  f.setJob({
    pid: 42,
    program: join(
      f.source,
      "Contents/Library/LaunchServices/EagleDeviceHelper",
    ),
  });
  try {
    assert.throws(
      () => installDeviceCandidate(f.source, f.destination, f.system),
      /different App path/,
    );
    assert(!f.events.includes("quit"));
    assert.equal(f.payload(f.destination), "old");
  } finally {
    f.cleanup();
  }
});

test("a job with an unknown executable path cannot authorize replacement", () => {
  const f = fixture();
  f.setJob({});
  try {
    assert.throws(
      () => installDeviceCandidate(f.source, f.destination, f.system),
      /path could not be verified/,
    );
    assert(!f.events.includes("quit"));
    assert.equal(f.payload(f.destination), "old");
  } finally {
    f.cleanup();
  }
});

test("first install does not run an unregister command", () => {
  const f = fixture();
  rmSync(f.destination, { recursive: true });
  f.setJob(undefined);
  f.setAlive(false);
  try {
    const result = installDeviceCandidate(f.source, f.destination, f.system);
    assert.equal(result.backup, undefined);
    assert.equal(f.payload(f.destination), "new");
    assert(!f.events.some((event) => event.startsWith("prepare:")));
    assert(existsSync(f.source));
  } finally {
    f.cleanup();
  }
});

test("failed installed signature verification restores the old complete bundle", () => {
  const f = fixture();
  const verify = f.system.verify;
  f.system.verify = (bundle) => {
    if (bundle === f.destination && f.payload(bundle) === "new")
      throw new Error("installed verification failed");
    verify(bundle);
  };
  try {
    assert.throws(
      () => installDeviceCandidate(f.source, f.destination, f.system),
      /installed verification failed/,
    );
    assert.equal(f.payload(f.destination), "old");
    assert.equal(f.payload(f.source), "new");
    assert(!f.events.includes("open:new"));
  } finally {
    f.cleanup();
  }
});

test("a rollback failure preserves the previous signed bundle for recovery", () => {
  const f = fixture();
  let staged = "";
  const copy = f.system.copy;
  f.system.copy = (from, to) => {
    staged = to;
    copy(from, to);
  };
  const verify = f.system.verify;
  f.system.verify = (bundle) => {
    if (bundle === f.destination && f.payload(bundle) === "new") {
      mkdirSync(staged);
      writeFileSync(join(staged, "block-rollback"), "owned fixture");
      throw new Error("installed verification failed");
    }
    verify(bundle);
  };
  try {
    assert.throws(() =>
      installDeviceCandidate(f.source, f.destination, f.system),
    );
    assert.equal(
      f.payload(join(staged, "..", "previous", "Eagle Device Candidate.app")),
      "old",
    );
    assert.equal(f.payload(f.source), "new");
    assert(!f.events.includes("open:new"));
  } finally {
    f.cleanup();
  }
});
