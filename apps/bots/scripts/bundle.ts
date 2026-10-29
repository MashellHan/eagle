import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Assemble the independent daemon for a host application, using the installed lock. */
export function bundleDaemon(destination: string): { entry: string; version: string } {
  const target = resolve(destination);
  mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
  try {
    mkdirSync(target, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Daemon bundle destination already exists");
    throw error;
  }
  const owner = lstatSync(target);
  try {
    for (const name of ["package.json", "package-lock.json"])
      copyFileSync(join(project, name), join(target, name));
    cpSync(join(project, "src"), join(target, "src"), { recursive: true });
    mkdirSync(join(target, "scripts"));
    copyFileSync(join(project, "scripts/serve.ts"), join(target, "scripts/serve.ts"));
    // npm ci has already populated the approved cache. No alternate registry or
    // install scripts run while packaging; the lock still verifies every artifact.
    execFileSync(
      "npm",
      ["ci", "--offline", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: target,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      },
    );
    const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
      version: string;
    };
    return { entry: join(target, "scripts/serve.ts"), version: manifest.version };
  } catch (error) {
    const current = lstatSync(target, { throwIfNoEntry: false });
    if (current?.dev === owner.dev && current.ino === owner.ino)
      rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: bundle.ts <App Resources/Bots destination>");
  console.log(JSON.stringify(bundleDaemon(process.argv[2])));
}
