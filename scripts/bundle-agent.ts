import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Materialize the locally packed candidate; never request an unpublished version from npm. */
export function bundleAgent(destination: string): {
  cli: string;
  version: string;
} {
  const target = resolve(destination);
  mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
  try {
    mkdirSync(target, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Agent bundle destination already exists");
    throw error;
  }
  const owner = lstatSync(target);
  let temporary: string | undefined;
  try {
    temporary = mkdtempSync(join(tmpdir(), "eagle-agent-bundle-"));
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "./packages/agent", "--pack-destination", temporary, "--json"],
        {
          cwd: repository,
          encoding: "utf8",
          timeout: 120_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    ) as { filename: string; version: string; integrity: string }[];
    const artifact = packed[0];
    if (packed.length !== 1 || !artifact || artifact.filename.includes("/"))
      throw new Error("Unexpected Agent pack result");
    const tarball = join(temporary, artifact.filename);
    const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    if (integrity !== artifact.integrity)
      throw new Error("Agent tarball integrity mismatch");
    const rootLockBytes = readFileSync(
      join(repository, "package-lock.json"),
      "utf8",
    );
    type Locked = { version?: string; integrity?: string; link?: boolean };
    const rootLock = JSON.parse(rootLockBytes) as {
      packages: Record<string, Locked>;
    };
    const sourceManifest = JSON.parse(
      readFileSync(join(repository, "packages/agent/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const overrides: Record<string, string> = {};
    for (const name of Object.keys(sourceManifest.dependencies)) {
      const locked = rootLock.packages[`node_modules/${name}`];
      if (!locked?.version || !locked.integrity || locked.link)
        throw new Error("Agent bundle is missing a locked dependency");
      overrides[name] = locked.version;
    }
    copyFileSync(tarball, join(target, "agent.tgz"));
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({
        name: "eagle-agent-app-bundle",
        version: "0.0.0",
        private: true,
        dependencies: { "@nocoo/eagle-agent": "file:./agent.tgz" },
        overrides,
      }),
    );
    const install = (args: string[]) =>
      execFileSync(
        "npm",
        [...args, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: target, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
      );
    install(["install", "--package-lock-only"]);
    const packageLock = JSON.parse(
      readFileSync(join(target, "package-lock.json"), "utf8"),
    ) as { packages: Record<string, Locked> };
    for (const [path, actual] of Object.entries(packageLock.packages)) {
      if (path === "") continue;
      const expected =
        path === "node_modules/@nocoo/eagle-agent"
          ? { version: artifact.version, integrity }
          : rootLock.packages[path];
      if (
        !expected?.integrity ||
        actual.link ||
        actual.version !== expected.version ||
        actual.integrity !== expected.integrity
      )
        throw new Error("Agent bundle locked dependency mismatch");
    }
    for (const name of Object.keys(overrides)) {
      if (!packageLock.packages[`node_modules/${name}`])
        throw new Error("Agent bundle is missing a locked dependency");
    }
    install(["ci", "--omit=dev"]);
    const cli = join(
      target,
      "node_modules/@nocoo/eagle-agent/dist/agent/cli.js",
    );
    const installedRequire = createRequire(cli);
    for (const [name, version] of Object.entries(overrides)) {
      const path = realpathSync(
        installedRequire.resolve(`${name}/package.json`),
      );
      if (
        !path.startsWith(`${realpathSync(target)}/`) ||
        JSON.parse(readFileSync(path, "utf8")).version !== version
      )
        throw new Error("Agent bundle locked dependency mismatch");
    }
    if (
      readFileSync(join(repository, "package-lock.json"), "utf8") !==
      rootLockBytes
    )
      throw new Error("Repository lock changed during Agent assembly");
    const manifest = JSON.parse(
      readFileSync(
        join(target, "node_modules/@nocoo/eagle-agent/package.json"),
        "utf8",
      ),
    );
    if (
      manifest.version !== artifact.version ||
      execFileSync(process.execPath, [cli, "--version"], {
        cwd: temporary,
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: "/usr/bin:/bin" },
      }).trim() !== artifact.version
    )
      throw new Error("Agent bundle version mismatch");
    return { cli, version: artifact.version };
  } catch (error) {
    const current = lstatSync(target, { throwIfNoEntry: false });
    if (current?.dev === owner.dev && current.ino === owner.ino)
      rmSync(target, { recursive: true, force: true });
    throw error;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv[2])
    throw new Error("Usage: bundle-agent.ts <App Resources/Agent destination>");
  console.log(JSON.stringify(bundleAgent(process.argv[2])));
}
