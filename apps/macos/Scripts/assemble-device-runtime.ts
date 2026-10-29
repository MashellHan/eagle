// Build-time only: install two independent, locked products beside a verified
// Node executable. Nothing here is loaded by the shipped Agent or Bots daemon.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

type Entry = {
  name?: string;
  version: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  dev?: boolean;
  devOptional?: boolean;
  link?: boolean;
  optional?: boolean;
  os?: string[];
  cpu?: string[];
  [key: string]: unknown;
};
type Lock = { lockfileVersion: number; packages: Record<string, Entry> };
type Manifest = Entry & { name: string; version: string };
type Options = {
  sourceRoot: string;
  destination: string;
  nodeBinary: string;
  npmCli: string;
  agentCache: string;
  botsCache: string;
};
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
const digest = (path: string, algorithm = "sha256") =>
  createHash(algorithm).update(readFileSync(path)).digest("hex");
const save = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
function equalDependencies(manifest: Entry, locked?: Entry) {
  if (
    !locked ||
    manifest.version !== locked.version ||
    JSON.stringify(manifest.dependencies ?? {}) !==
      JSON.stringify(locked.dependencies ?? {}) ||
    JSON.stringify(manifest.optionalDependencies ?? {}) !==
      JSON.stringify(locked.optionalDependencies ?? {})
  )
    throw new Error("manifest and authoritative lock differ");
}
function compatible(list: string[] | undefined, value: string) {
  return (
    !list ||
    (!list.includes(`!${value}`) &&
      (!list.some((item) => !item.startsWith("!")) || list.includes(value)))
  );
}
function production(entry: Entry) {
  return (
    !entry.dev &&
    compatible(entry.os, process.platform) &&
    compatible(entry.cpu, process.arch)
  );
}
function packageName(path: string) {
  return path.split("node_modules/").at(-1) ?? "";
}
function dependencyPath(lock: Lock, from: string, name: string) {
  let directory = from;
  for (;;) {
    const candidate = `${directory ? `${directory}/` : ""}node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (!directory)
      throw new Error(`dependency absent from authoritative lock: ${name}`);
    const parent = dirname(directory);
    directory = parent === "." ? "" : parent;
  }
}
export function agentDependencies(
  lock: Lock,
  manifest: Manifest,
): Record<string, Entry> {
  equalDependencies(manifest, lock.packages["packages/agent"]);
  const result: Record<string, Entry> = {};
  const visit = (path: string) => {
    const entry = lock.packages[path];
    if (path !== "packages/agent") {
      const target = path.replace(
        /^packages\/agent\/node_modules\//,
        "node_modules/@nocoo/eagle-agent/node_modules/",
      );
      if (result[target]) return;
      if (entry.link)
        throw new Error("runtime dependencies must be packed packages");
      const {
        dev: _dev,
        devOptional: _devOptional,
        ...productionEntry
      } = entry;
      result[target] = productionEntry;
    }
    for (const name of Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
    }))
      visit(dependencyPath(lock, path, name));
    for (const name of Object.keys(entry.peerDependencies ?? {}))
      if (!entry.peerDependenciesMeta?.[name]?.optional)
        visit(dependencyPath(lock, path, name));
  };
  visit("packages/agent");
  return result;
}
export function verifyLockedCache(
  packages: Record<string, Entry>,
  cache: string,
): number {
  let count = 0;
  for (const [path, entry] of Object.entries(packages)) {
    if (!path || !production(entry)) continue;
    if (
      entry.link ||
      !entry.resolved?.startsWith("https://") ||
      !entry.integrity
    )
      throw new Error(`unlocked production dependency: ${path}`);
    const sri = entry.integrity
      .split(/\s+/)
      .map((value) => value.split("-"))
      .find(([algorithm]) => algorithm === "sha512");
    if (!sri) throw new Error(`SHA512 lock integrity required: ${path}`);
    const expected = Buffer.from(sri[1], "base64");
    const hex = expected.toString("hex");
    const body = join(
      cache,
      "_cacache/content-v2/sha512",
      hex.slice(0, 2),
      hex.slice(2, 4),
      hex.slice(4),
    );
    if (!existsSync(body))
      throw new Error(`locked artifact unavailable: ${path}@${entry.version}`);
    if (
      !createHash("sha512").update(readFileSync(body)).digest().equals(expected)
    )
      throw new Error(`locked artifact integrity mismatch: ${path}`);
    const members = execFileSync("/usr/bin/tar", ["-tzf", body], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((member) => /^[^/]+\/package\.json$/.test(member));
    if (members.length !== 1)
      throw new Error(`ambiguous package manifest: ${path}`);
    const manifest = JSON.parse(
      execFileSync("/usr/bin/tar", ["-xOzf", body, members[0]], {
        encoding: "utf8",
      }),
    ) as Manifest;
    if (
      manifest.name !== (entry.name ?? packageName(path)) ||
      manifest.version !== entry.version
    )
      throw new Error(`locked artifact identity mismatch: ${path}`);
    count++;
  }
  return count;
}
function verifyInstalled(directory: string, lock: Lock) {
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || !production(entry)) continue;
    const manifest = json<Manifest>(join(directory, path, "package.json"));
    if (
      manifest.version !== entry.version ||
      manifest.name !== (entry.name ?? packageName(path))
    )
      throw new Error(`installed package differs from lock: ${path}`);
  }
}
function internalLinks(root: string, directory = root): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(path);
      const resolved = relative(root, realpathSync(path));
      if (
        isAbsolute(target) ||
        resolved === ".." ||
        resolved.startsWith(`..${sep}`)
      )
        throw new Error(`runtime symlink escapes bundle: ${path}`);
    } else if (entry.isDirectory()) internalLinks(root, path);
  }
}
function verifyNode(path: string) {
  const node = JSON.parse(
    execFileSync(
      path,
      [
        "-p",
        "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})",
      ],
      { encoding: "utf8" },
    ),
  ) as { version: string; platform: string; arch: string };
  if (
    Number(node.version.split(".")[0]) < 24 ||
    node.platform !== process.platform ||
    node.arch !== process.arch
  )
    throw new Error("bundled Node must match the build host and be Node 24+");
  if (process.platform === "darwin") {
    const libraries = execFileSync("/usr/bin/otool", ["-L", path], {
      encoding: "utf8",
    })
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" ")[0])
      .filter(Boolean);
    if (
      libraries.some(
        (library) =>
          !library.startsWith("/usr/lib/") &&
          !library.startsWith("/System/Library/"),
      )
    )
      throw new Error("bundled Node depends on a non-system library");
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", path], {
      stdio: "pipe",
    });
  }
  return node;
}
export function assembleRuntime(options: Options): void {
  const { sourceRoot, destination, agentCache, botsCache } = options;
  if (
    !isAbsolute(destination) ||
    lstatSync(destination, { throwIfNoEntry: false })
  )
    throw new Error("destination already exists or is not absolute");
  const nodeBinary = realpathSync(options.nodeBinary);
  const node = verifyNode(nodeBinary);
  const rootLockPath = join(sourceRoot, "package-lock.json");
  const rootLock = json<Lock>(rootLockPath);
  const agentManifest = json<Manifest>(
    join(sourceRoot, "packages/agent/package.json"),
  );
  const dependencies = agentDependencies(rootLock, agentManifest);
  const botsSource = join(sourceRoot, "apps/bots");
  const botsManifest = json<Manifest>(join(botsSource, "package.json"));
  const botsLockPath = join(botsSource, "package-lock.json");
  const botsLock = json<Lock>(botsLockPath);
  equalDependencies(botsManifest, botsLock.packages[""]);
  const verified = {
    agent: verifyLockedCache(dependencies, agentCache),
    bots: verifyLockedCache(botsLock.packages, botsCache),
  };
  const originalLocks = [digest(rootLockPath), digest(botsLockPath)];
  mkdirSync(dirname(destination), { recursive: true });
  const stage = mkdtempSync(join(dirname(destination), ".device-runtime-"));
  const npm = (cache: string, cwd: string, args: string[]) =>
    execFileSync(nodeBinary, [options.npmCli, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${dirname(nodeBinary)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        npm_config_cache: cache,
        npm_config_offline: "true",
      },
    });
  try {
    copyFileSync(nodeBinary, join(stage, "node"));
    chmodSync(join(stage, "node"), 0o755);
    verifyNode(join(stage, "node"));
    const agent = join(stage, "agent");
    mkdirSync(agent);
    const [packed] = JSON.parse(
      npm(agentCache, sourceRoot, [
        "pack",
        join(sourceRoot, "packages/agent"),
        "--pack-destination",
        agent,
        "--json",
      ]),
    ) as { filename: string; version: string }[];
    if (packed.version !== agentManifest.version)
      throw new Error("packed Agent version mismatch");
    renameSync(join(agent, packed.filename), join(agent, "agent.tgz"));
    const wrapper = {
      name: "eagle-device-agent-runtime",
      version: "1.0.0",
      private: true,
      dependencies: { "@nocoo/eagle-agent": "file:agent.tgz" },
    };
    save(join(agent, "package.json"), wrapper);
    const agentLock = {
      name: wrapper.name,
      version: wrapper.version,
      lockfileVersion: 3,
      packages: {
        "": wrapper,
        "node_modules/@nocoo/eagle-agent": {
          ...agentManifest,
          scripts: undefined,
          files: undefined,
          resolved: "file:agent.tgz",
          integrity: `sha512-${createHash("sha512")
            .update(readFileSync(join(agent, "agent.tgz")))
            .digest("base64")}`,
        },
        ...dependencies,
      },
    };
    save(join(agent, "package-lock.json"), agentLock);
    npm(agentCache, agent, ["ci", "--omit=dev", "--no-audit", "--no-fund"]);
    verifyInstalled(agent, agentLock);
    if (
      !existsSync(
        join(
          agent,
          "node_modules/@nocoo/eagle-agent/dist/agent/device-service.js",
        ),
      )
    )
      throw new Error("packed Agent lacks the device service entry point");
    const bots = join(stage, "bots");
    mkdirSync(join(bots, "scripts"), { recursive: true });
    for (const name of ["package.json", "package-lock.json"])
      copyFileSync(join(botsSource, name), join(bots, name));
    cpSync(join(botsSource, "src"), join(bots, "src"), { recursive: true });
    copyFileSync(
      join(botsSource, "scripts/serve.ts"),
      join(bots, "scripts/serve.ts"),
    );
    npm(botsCache, bots, ["ci", "--omit=dev", "--no-audit", "--no-fund"]);
    verifyInstalled(bots, botsLock);
    internalLinks(stage);
    if (
      originalLocks[0] !== digest(rootLockPath) ||
      originalLocks[1] !== digest(botsLockPath)
    )
      throw new Error("source locks changed during runtime assembly");
    save(join(stage, "receipt.json"), {
      version: 1,
      node: {
        ...node,
        sha256: digest(join(stage, "node")),
        signature:
          process.platform === "darwin"
            ? "preserved-and-verified"
            : "not-macos",
      },
      agent: {
        version: agentManifest.version,
        lockSha256: originalLocks[0],
        tarSha256: digest(join(agent, "agent.tgz")),
      },
      bots: { version: botsManifest.version, lockSha256: originalLocks[1] },
      verified,
    });
    renameSync(stage, destination);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        "source-root": {
          type: "string",
          default: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
        },
        destination: { type: "string" },
        node: { type: "string", default: process.execPath },
        "npm-cli": {
          type: "string",
          default: resolve(
            dirname(process.execPath),
            "../lib/node_modules/npm/bin/npm-cli.js",
          ),
        },
        "agent-cache": { type: "string" },
        "bots-cache": { type: "string" },
      },
    });
    if (!values.destination || !values["agent-cache"] || !values["bots-cache"])
      throw new Error(
        "--destination, --agent-cache and --bots-cache are required build inputs",
      );
    assembleRuntime({
      sourceRoot: resolve(values["source-root"]),
      destination: resolve(values.destination),
      nodeBinary: resolve(values.node),
      npmCli: resolve(values["npm-cli"]),
      agentCache: resolve(values["agent-cache"]),
      botsCache: resolve(values["bots-cache"]),
    });
    process.stdout.write(`${values.destination}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "runtime assembly failed"}\n`,
    );
    process.exitCode = 1;
  }
}
