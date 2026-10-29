import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("apps/macos/Scripts/assemble-device-runtime.ts");
const npmCli = resolve(
  dirname(process.execPath),
  "../lib/node_modules/npm/bin/npm-cli.js",
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "eagle-runtime-package-"));
  const source = join(root, "source");
  const agent = join(source, "packages/agent");
  const bots = join(source, "apps/bots");
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(bots, "scripts"), { recursive: true });
  mkdirSync(join(bots, "src"));
  const manifest = {
    name: "@nocoo/eagle-agent",
    version: "9.8.7",
    type: "module",
    files: ["dist"],
    scripts: { prepack: "node build.mjs" },
  };
  writeFileSync(join(agent, "package.json"), JSON.stringify(manifest));
  writeFileSync(
    join(agent, "build.mjs"),
    `import{mkdirSync,writeFileSync}from"node:fs";mkdirSync("dist/agent",{recursive:true});writeFileSync("dist/agent/device-service.js",${JSON.stringify('process.stdout.write(JSON.stringify({version:"9.8.7",source:"installed-agent"})+"\\n");')});`,
  );
  writeFileSync(
    join(source, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "packages/agent": { name: manifest.name, version: manifest.version },
      },
    }),
  );
  writeFileSync(
    join(bots, "package.json"),
    JSON.stringify({
      name: "assembly-bots",
      version: "1.0.0",
      private: true,
      type: "module",
    }),
  );
  writeFileSync(
    join(bots, "package-lock.json"),
    JSON.stringify({
      name: "assembly-bots",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "assembly-bots", version: "1.0.0" } },
    }),
  );
  writeFileSync(
    join(bots, "src/main.ts"),
    'export const message: string = "中文 bundled Bots";',
  );
  writeFileSync(
    join(bots, "scripts/serve.ts"),
    'import{message}from"../src/main.ts";process.stdout.write(JSON.stringify({message,source:"bots"})+"\\n");',
  );
  writeFileSync(join(bots, ".env"), "SHOULD_NEVER_SHIP=fixture-secret");
  mkdirSync(join(bots, "test"));
  writeFileSync(join(bots, "test/not-production.ts"), "should never ship");
  return {
    root,
    source,
    agent,
    bots,
    destination: join(root, "DeviceRuntime"),
    cache: join(root, "cache"),
  };
}
function assemble(f: ReturnType<typeof fixture>) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--source-root",
      f.source,
      "--destination",
      f.destination,
      "--node",
      process.execPath,
      "--npm-cli",
      npmCli,
      "--agent-cache",
      f.cache,
      "--bots-cache",
      f.cache,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
}

test("runtime assembly installs a packed Agent and isolated Bots production files without runtime PATH", () => {
  const f = fixture();
  try {
    const result = assemble(f);
    assert.equal(result.status, 0, result.stderr);
    const bundledNode = join(f.destination, "node");
    assert.equal(
      createHash("sha256").update(readFileSync(bundledNode)).digest("hex"),
      createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
      "preserve the verified Node executable/signature bytes",
    );
    assert.equal(existsSync(join(f.destination, "bots/.env")), false);
    assert.equal(existsSync(join(f.destination, "bots/test")), false);
    assert.equal(existsSync(join(f.destination, "agent/packages")), false);
    renameSync(f.source, join(f.root, "unavailable-source"));
    const env = { ...process.env, PATH: "", NODE_PATH: "", NODE_OPTIONS: "" };
    const agent = execFileSync(
      bundledNode,
      [
        join(
          f.destination,
          "agent/node_modules/@nocoo/eagle-agent/dist/agent/device-service.js",
        ),
      ],
      { env, encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(agent), {
      version: "9.8.7",
      source: "installed-agent",
    });
    const bots = execFileSync(
      bundledNode,
      [join(f.destination, "bots/scripts/serve.ts")],
      { env, encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(bots), {
      message: "中文 bundled Bots",
      source: "bots",
    });
    const receipt = JSON.parse(
      readFileSync(join(f.destination, "receipt.json"), "utf8"),
    );
    assert.equal(receipt.agent.version, "9.8.7");
    assert.equal(
      receipt.bots.lockSha256,
      createHash("sha256")
        .update(
          readFileSync(
            join(f.root, "unavailable-source/apps/bots/package-lock.json"),
          ),
        )
        .digest("hex"),
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("assembly refuses an existing output and leaves source locks unchanged on a missing locked tarball", () => {
  const f = fixture();
  try {
    const lockPath = join(f.source, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages["packages/agent"].dependencies = {
      "missing-dependency": "1.0.0",
    };
    lock.packages["node_modules/missing-dependency"] = {
      version: "1.0.0",
      resolved:
        "https://registry.npmjs.org/missing-dependency/-/missing-dependency-1.0.0.tgz",
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    };
    writeFileSync(lockPath, JSON.stringify(lock));
    const manifestPath = join(f.agent, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies = { "missing-dependency": "1.0.0" };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const before = readFileSync(lockPath);
    const result = assemble(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /locked artifact unavailable/);
    assert.equal(
      existsSync(f.destination),
      false,
      "a failed assembly publishes no runtime",
    );
    assert.deepEqual(readFileSync(lockPath), before);
    assert.deepEqual(readdirSync(f.root).sort(), ["source"]);
    const corrupt = join(
      f.cache,
      "_cacache/content-v2/sha512",
      "00",
      "00",
      "00".repeat(62),
    );
    mkdirSync(dirname(corrupt), { recursive: true });
    writeFileSync(corrupt, "corrupted cached package bytes");
    const corrupted = assemble(f);
    assert.notEqual(corrupted.status, 0);
    assert.match(corrupted.stderr, /locked artifact integrity mismatch/);
    assert.equal(existsSync(f.destination), false);
    assert.deepEqual(readFileSync(lockPath), before);
    mkdirSync(f.destination);
    writeFileSync(join(f.destination, "keep"), "preserve");
    const again = assemble(f);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /destination already exists/);
    assert.equal(readFileSync(join(f.destination, "keep"), "utf8"), "preserve");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
