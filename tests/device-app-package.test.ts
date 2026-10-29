import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("apps/macos/Scripts/assemble-device-app.ts");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "eagle-app-package-"));
  const binary = join(root, "EagleApp");
  const helper = join(root, "EagleDeviceHelper");
  for (const path of [binary, helper]) {
    writeFileSync(path, "fixture executable");
    chmodSync(path, 0o755);
  }
  mkdirSync(join(root, "EagleFeatures.bundle"));
  writeFileSync(join(root, "EagleFeatures.bundle/resource"), "Swift resource");
  return {
    root,
    binary,
    helper,
    app: join(root, "Eagle Device Candidate.app"),
  };
}
function prepare(f: ReturnType<typeof fixture>, args: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--app",
      f.app,
      "--binary",
      f.binary,
      "--helper",
      f.helper,
      ...args,
    ],
    { encoding: "utf8" },
  );
}

test("candidate bundle fixes isolated host configuration and SMAppService helper paths", () => {
  const f = fixture();
  try {
    const result = prepare(f);
    assert.equal(result.status, 0, result.stderr);
    const contents = join(f.app, "Contents");
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(contents, "Resources/DeviceHost.json"), "utf8"),
      ),
      {
        version: 1,
        profile: "device-candidate",
        baseUrl: "http://127.0.0.1:17053",
        machServiceName: "ai.hexly.eagle.devices.candidate",
        launchAgentPlist: "ai.hexly.eagle.devices.candidate.plist",
      },
    );
    const plist = readFileSync(
      join(
        contents,
        "Library/LaunchAgents/ai.hexly.eagle.devices.candidate.plist",
      ),
      "utf8",
    );
    assert.match(
      plist,
      /<key>BundleProgram<\/key>\s*<string>Contents\/Library\/LaunchServices\/EagleDeviceHelper<\/string>/,
    );
    assert.match(
      plist,
      /<key>MachServices<\/key>\s*<dict>\s*<key>ai.hexly.eagle.devices.candidate<\/key>\s*<true\/>/,
    );
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.equal(
      existsSync(join(contents, "Library/LaunchServices/EagleDeviceHelper")),
      true,
    );
    assert.equal(
      readFileSync(
        join(contents, "Resources/EagleFeatures.bundle/resource"),
        "utf8",
      ),
      "Swift resource",
    );
    assert.match(
      readFileSync(join(contents, "Info.plist"), "utf8"),
      /<string>ai.hexly.eagle.macos.device-candidate<\/string>/,
    );
    assert.equal(existsSync(join(f.root, "Eagle.app")), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("release assembly requires a build-time HTTPS origin and fails before publishing an invalid bundle", () => {
  const f = fixture();
  try {
    for (const url of [
      undefined,
      "http://127.0.0.1:17053",
      "https://devices.test/path",
    ]) {
      const result = prepare(f, [
        "--profile",
        "device-release",
        ...(url ? ["--service-url", url] : []),
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /release requires a build-time HTTPS origin/);
      assert.equal(existsSync(f.app), false);
    }
    const valid = prepare(f, [
      "--profile",
      "device-release",
      "--service-url",
      "https://devices.test",
    ]);
    assert.equal(valid.status, 0, valid.stderr);
    const config = JSON.parse(
      readFileSync(join(f.app, "Contents/Resources/DeviceHost.json"), "utf8"),
    );
    assert.equal(config.baseUrl, "https://devices.test");
    assert.equal(config.profile, "device-release");
    assert.equal(config.machServiceName, "ai.hexly.eagle.devices");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("nested signing preserves Node, signs helper before App, and propagates verification failures", async () => {
  const { signDeviceBundle } = await import(
    "../apps/macos/Scripts/assemble-device-app.ts"
  );
  const f = fixture();
  try {
    const result = prepare(f);
    assert.equal(result.status, 0, result.stderr);
    const node = join(f.app, "Contents/Resources/DeviceRuntime/node");
    mkdirSync(join(f.app, "Contents/Resources/DeviceRuntime"), {
      recursive: true,
    });
    writeFileSync(node, "original signed Node fixture bytes");
    const addon = join(
      f.app,
      "Contents/Resources/DeviceRuntime/bots/node_modules/native-fixture/binding.node",
    );
    mkdirSync(join(addon, ".."), { recursive: true });
    writeFileSync(addon, Buffer.from("cffaedfe00000000", "hex"));
    const calls: string[][] = [];
    signDeviceBundle(f.app, "-", (_program, args) => {
      calls.push(args);
      return "";
    });
    assert.equal(
      calls.some((args) => args.includes("--force") && args.at(-1) === node),
      false,
    );
    const signed = calls
      .filter((args) => args.includes("--sign"))
      .map((args) => args.at(-1));
    assert.deepEqual(signed, [
      addon,
      join(f.app, "Contents/Library/LaunchServices/EagleDeviceHelper"),
      f.app,
    ]);
    assert.equal(calls.at(-1)?.includes("--verify"), true);
    assert(
      calls.some(
        (args) => args.includes("--deep") && args.includes("--strict"),
      ),
    );
    const receipt = JSON.parse(
      readFileSync(
        join(f.app, "Contents/Resources/DeviceSigning.json"),
        "utf8",
      ),
    );
    assert.equal(receipt.mode, "ad-hoc-candidate");
    assert.throws(
      () =>
        signDeviceBundle(f.app, "-", () => {
          throw new Error("codesign rejected fixture");
        }),
      /codesign rejected fixture/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("runtime copy preserves relocatable internal bin links and the original Node bytes", async () => {
  const { copyDeviceRuntime } = await import(
    "../apps/macos/Scripts/assemble-device-app.ts"
  );
  const f = fixture();
  try {
    const source = join(f.root, "runtime-source");
    mkdirSync(join(source, "bots/node_modules/.bin"), { recursive: true });
    mkdirSync(join(source, "bots/node_modules/pi-ai"));
    writeFileSync(
      join(source, "bots/node_modules/pi-ai/cli.js"),
      "fixture installed CLI",
    );
    symlinkSync(
      "../pi-ai/cli.js",
      join(source, "bots/node_modules/.bin/pi-ai"),
    );
    writeFileSync(join(source, "node"), "preserve original signed Node bytes");
    const target = join(f.root, "copied-runtime");
    copyDeviceRuntime(source, target);
    renameSync(source, join(f.root, "unavailable-original"));
    assert.equal(
      readlinkSync(join(target, "bots/node_modules/.bin/pi-ai")),
      "../pi-ai/cli.js",
    );
    assert.equal(
      readFileSync(join(target, "bots/node_modules/.bin/pi-ai"), "utf8"),
      "fixture installed CLI",
    );
    assert.equal(
      readFileSync(join(target, "node"), "utf8"),
      "preserve original signed Node bytes",
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
