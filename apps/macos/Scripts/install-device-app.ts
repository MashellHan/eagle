export type InstalledDeviceJob = { pid?: number; program?: string };

export interface DeviceInstallerSystem {
  verify(bundle: string): void;
  helperPath(bundle: string): string;
  supportsMaintenance(bundle: string): boolean;
  copy(source: string, destination: string): void;
  quit(bundle: string): void;
  job(bundle: string): InstalledDeviceJob | undefined;
  prepare(bundle: string): void;
  processExists(pid: number): boolean;
  open(bundle: string): void;
}

export function installDeviceCandidate(
  source: string,
  destination: string,
  system: DeviceInstallerSystem = macOSSystem(),
): { destination: string; backup?: string; launchTimeUnix: number } {
  source = realpathSync(source);
  destination = resolve(destination);
  if (!source.endsWith(".app") || !destination.endsWith(".app"))
    throw new Error("source and destination must be App bundles");
  if (existsSync(destination) && lstatSync(destination).isSymbolicLink())
    throw new Error("the installed App must not be a symbolic link");
  mkdirSync(dirname(destination), { recursive: true });
  destination = join(
    realpathSync(dirname(destination)),
    destination.split(sep).at(-1) as string,
  );
  if (
    source === destination ||
    source.startsWith(destination + sep) ||
    destination.startsWith(source + sep)
  )
    throw new Error("source and destination must be separate bundles");
  system.verify(source);
  if (!system.supportsMaintenance(source))
    throw new Error("the new App does not support device update preparation");
  const installed = existsSync(destination);
  if (installed) system.verify(destination);
  const previousJob = system.job(installed ? destination : source);
  if (!installed && previousJob)
    throw new Error("a device service already belongs to another installation");
  if (
    previousJob?.program !== undefined &&
    previousJob.program !== system.helperPath(destination)
  )
    throw new Error("the device service belongs to a different App path");
  if (previousJob && !previousJob.program)
    throw new Error(
      "the old device service path could not be verified; open the installed App and retry it first",
    );
  const transaction = mkdtempSync(
    join(dirname(destination), ".eagle-device-install-"),
  );
  const staged = join(transaction, "Eagle Device Candidate.app");
  const backup = join(transaction, "previous", "Eagle Device Candidate.app");
  let moved = false;
  let published = false;
  try {
    system.copy(source, staged);
    system.verify(staged);
    if (installed) {
      system.quit(destination);
      // Legacy migration may call the new bundle, but its return code alone is not proof.
      system.prepare(
        system.supportsMaintenance(destination) ? destination : staged,
      );
      if (
        system.job(destination) ||
        (previousJob?.pid && system.processExists(previousJob.pid))
      )
        throw new Error(
          "the previous device service has not finished stopping",
        );
      mkdirSync(dirname(backup));
      renameSync(destination, backup);
      moved = true;
    }
    renameSync(staged, destination);
    published = true;
    system.verify(destination);
  } catch (error) {
    if (published) renameSync(destination, staged);
    if (moved) renameSync(backup, destination);
    throw error;
  } finally {
    // Keep the old signed bundle after success, and the source in every case.
    if (!existsSync(backup))
      rmSync(transaction, { recursive: true, force: true });
  }
  const launchTimeUnix = Date.now() / 1000;
  system.open(destination);
  return { destination, ...(installed ? { backup } : {}), launchTimeUnix };
}

// Prepare the old service before replacing its signed bundle. No state directory is copied.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  deviceCandidateServiceLabel,
  deviceHelperRelativePath,
} from "./assemble-device-app.ts";

function macOSSystem(): DeviceInstallerSystem {
  const identifier = "ai.hexly.eagle.macos.device-candidate";
  const run = (program: string, args: string[], timeout = 15_000) =>
    spawnSync(program, args, {
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
    });
  const checked = (program: string, args: string[], timeout?: number) => {
    const result = run(program, args, timeout);
    if (result.error || result.status !== 0)
      throw new Error(
        `device installer step failed: ${program.split("/").at(-1)}`,
      );
    return result.stdout;
  };
  const info = (bundle: string, key: string) =>
    run("/usr/bin/plutil", [
      "-extract",
      key,
      "raw",
      "-o",
      "-",
      join(bundle, "Contents/Info.plist"),
    ]);
  return {
    helperPath: (bundle) => join(bundle, deviceHelperRelativePath(bundle)),
    verify(bundle) {
      checked(
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", bundle],
        30_000,
      );
      const bundleID = info(bundle, "CFBundleIdentifier");
      deviceCandidateServiceLabel(bundle);
      if (bundleID.status !== 0 || bundleID.stdout.trim() !== identifier)
        throw new Error("the bundle is not an Eagle device candidate");
    },
    supportsMaintenance(bundle) {
      const result = info(bundle, "EagleDeviceMaintenanceVersion");
      return result.status === 0 && result.stdout.trim() === "1";
    },
    copy(source, destination) {
      checked("/usr/bin/ditto", [source, destination], 60_000);
    },
    quit(bundle) {
      checked(
        "/usr/bin/xcrun",
        [
          "swift",
          fileURLToPath(new URL("./quit-device-app.swift", import.meta.url)),
          bundle,
        ],
        30_000,
      );
    },
    job(bundle) {
      const label = deviceCandidateServiceLabel(bundle);
      const result = run("/bin/launchctl", [
        "print",
        `gui/${process.getuid?.()}/${label}`,
      ]);
      if (result.error)
        throw new Error("unable to inspect the existing device service");
      if (result.status !== 0) {
        if (/Could not find service/.test(result.stderr)) return undefined;
        throw new Error("unable to inspect the existing device service");
      }
      if (!result.stdout.includes(`parent bundle identifier = ${identifier}`))
        throw new Error("the existing device service has an unexpected owner");
      const match = result.stdout.match(/^\s*pid = (\d+)\s*$/m);
      if (!match) return {};
      const pid = Number(match[1]);
      // SMAppService supplies a relative argv[0]; only the kernel's path identifies the bundle.
      const path = checked(
        "/usr/bin/xcrun",
        [
          "swift",
          fileURLToPath(
            new URL("./device-process-path.swift", import.meta.url),
          ),
          String(pid),
        ],
        30_000,
      ).trim();
      return {
        pid,
        program: path.startsWith("/") ? realpathSync(path) : undefined,
      };
    },
    prepare(bundle) {
      checked(join(bundle, "Contents/MacOS/EagleApp"), [
        "--prepare-device-update",
      ]);
    },
    processExists(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    },
    open(bundle) {
      checked("/usr/bin/open", [bundle]);
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.platform !== "darwin")
      throw new Error("candidate installation requires macOS");
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { destination: { type: "string" } },
    });
    if (positionals.length !== 1)
      throw new Error(
        "usage: node install-device-app.ts <candidate.app> [--destination <path>]",
      );
    const result = installDeviceCandidate(
      positionals[0] as string,
      values.destination ??
        join(homedir(), "Applications/Eagle Device Candidate.app"),
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "device candidate installation failed",
    );
    process.exitCode = 1;
  }
}
