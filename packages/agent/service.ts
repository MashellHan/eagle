import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { z } from "zod";
import { checkUrl, stripRetiredConfig } from "./collector.ts";
import { ConfigSchema } from "./config.ts";
import { withIdleJournal } from "./operation-journal.ts";

export type ServiceState = {
  label: string;
  installed: boolean;
  loaded: boolean;
  disabled: boolean | null;
  running: boolean | null;
  pid: number | null;
  lastExit: number | null;
};

export function servicePaths(configPath: string) {
  let directory = resolve(dirname(configPath));
  try {
    directory = realpathSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Cannot resolve Agent configuration directory");
  }
  const config = join(directory, basename(configPath));
  const label = `ai.hexly.eagle.agent.${createHash("sha256").update(config).digest("hex").slice(0, 24)}`;
  return {
    config,
    directory,
    label,
    plist: join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
    receipt: join(directory, "service.json"),
    lock: join(directory, "service-control.sqlite"),
  };
}

type Paths = ReturnType<typeof servicePaths>;
type Receipt = {
  version: 1;
  config: string;
  node: string;
  cli: string;
  label: string;
};
const localLocks = new Set<string>();

export function privateDirectory(path: string) {
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error(
      "Agent service needs an owned 0700 configuration directory",
    );
}

export function ensurePrivateConfiguration(configPath: string) {
  const directory = dirname(configPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") privateDirectory(realpathSync(directory));
}

function reservedIdentity(paths: Paths): string | null {
  const file = join(paths.directory, "machine-identity.json");
  if (!lstatSync(file, { throwIfNoEntry: false })) return null;
  let value: { config: string; machineId: string };
  try {
    value = JSON.parse(privateFile(file).toString());
  } catch {
    throw new Error("Cannot read reserved machine identity");
  }
  if (
    value.config !== paths.config ||
    typeof value.machineId !== "string" ||
    !/^mac-[0-9a-f-]{36}$/.test(value.machineId)
  )
    throw new Error("Reserved machine identity conflict");
  return value.machineId;
}

export function assertReservedIdentity(configPath: string, machineId: string) {
  const previous = reservedIdentity(servicePaths(configPath));
  if (previous && previous !== machineId)
    throw new Error("Configuration contradicts the reserved machine identity");
}

export function prepareIdentity(configPath: string): {
  machineId: string;
  configured: boolean;
  ownerOrigin?: string;
  url?: string;
  commands?: boolean;
  workingDirectory?: string;
} {
  ensurePrivateConfiguration(configPath);
  const paths = servicePaths(configPath);
  if (lstatSync(paths.config, { throwIfNoEntry: false })) {
    const config = readConfiguration(paths);
    assertReservedIdentity(paths.config, config.machineId);
    return {
      machineId: config.machineId,
      configured: true,
      ownerOrigin: config.ownerOrigin
        ? checkUrl(config.ownerOrigin)
        : undefined,
      url: checkUrl(config.url),
      commands: config.execution?.commands ?? false,
      workingDirectory: config.execution?.workingDirectory ?? homedir(),
    };
  }
  const previous = reservedIdentity(paths);
  if (previous) return { machineId: previous, configured: false };
  const machineId = `mac-${randomUUID()}`;
  try {
    exclusiveFile(
      join(paths.directory, "machine-identity.json"),
      JSON.stringify({ config: paths.config, machineId }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = reservedIdentity(paths);
    if (!winner) throw new Error("Machine identity was not persisted");
    return { machineId: winner, configured: false };
  }
  return { machineId, configured: false };
}

export function updateConfiguration(configPath: string, input: unknown): void {
  const patch = z
    .strictObject({
      machineId: z.string(),
      ownerOrigin: z.string(),
      url: z.string(),
      token: z.string().min(32).max(4096).optional(),
      execution: z.strictObject({
        commands: z.boolean(),
        workingDirectory: z.string(),
      }),
    })
    .parse(input);
  const paths = servicePaths(configPath);
  withControlLock(paths, () => {
    const previous = readConfiguration(paths);
    if (
      previous.machineId !== patch.machineId ||
      checkUrl(previous.url) !== checkUrl(patch.url) ||
      (previous.ownerOrigin
        ? checkUrl(previous.ownerOrigin) !== checkUrl(patch.ownerOrigin)
        : !patch.token)
    )
      throw new Error(
        "Configuration repair must preserve the machine and deployment; unbound configuration requires explicit rotation",
      );
    assertReservedIdentity(paths.config, patch.machineId);
    const config = validateConfiguration({
      ...previous,
      ...patch,
      ownerOrigin: checkUrl(patch.ownerOrigin),
      token: patch.token ?? previous.token,
    });
    if (process.platform === "darwin") {
      const state = observe(paths, `gui/${process.getuid?.()}`).state;
      if (state.loaded || (state.installed && state.disabled !== true))
        throw new Error(
          "Stop the owned Agent service before configuration repair",
        );
    }
    const contents = JSON.stringify(config, null, 2);
    if (Buffer.byteLength(contents) > 65_536)
      throw new Error("Configuration exceeds 64 KiB");
    withIdleJournal(
      join(paths.directory, "execution", "operations.sqlite"),
      () => {
        const temporary = join(
          paths.directory,
          `.agent-config-${randomUUID()}.tmp`,
        );
        try {
          const file = openSync(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            0o600,
          );
          try {
            writeFileSync(file, contents);
            fsyncSync(file);
          } finally {
            closeSync(file);
          }
          privateFile(paths.config);
          renameSync(temporary, paths.config);
        } finally {
          rmSync(temporary, { force: true });
        }
      },
    );
  });
}

export function privateFile(path: string, create = false, read = true): Buffer {
  const fd = openSync(
    path,
    constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      (create ? constants.O_CREAT | constants.O_RDWR : constants.O_RDONLY),
    0o600,
  );
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      (read && info.size > 65_536)
    )
      throw new Error("Agent service requires an owned 0600 regular file");
    return read ? readFileSync(fd) : Buffer.alloc(0);
  } finally {
    closeSync(fd);
  }
}

function exclusiveFile(path: string, value: string) {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, value);
  } finally {
    closeSync(fd);
  }
}

function launch(args: string[], allowMissing = false): string | null {
  const result = spawnSync("/bin/launchctl", args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 256 * 1024,
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!result.error && result.status === 0) return result.stdout;
  // A missing exact service is different from a missing GUI domain or denied access.
  if (
    allowMissing &&
    !result.error &&
    result.status === 113 &&
    /Could not find service/.test(result.stderr)
  )
    return null;
  throw new Error(`Agent service launchctl ${args[0]} failed`);
}

function definition(receipt: Receipt, paths: Paths): string {
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-convert", "xml1", "-o", "-", "--", "-"],
    {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65_536,
      input: JSON.stringify({
        Label: receipt.label,
        ProgramArguments: [receipt.node, receipt.cli, "serve"],
        EnvironmentVariables: { EAGLE_CONFIG: receipt.config },
        WorkingDirectory: paths.directory,
        Disabled: true,
        RunAtLoad: true,
        KeepAlive: { Crashed: true },
        Umask: 63,
        ExitTimeOut: 10,
        StandardOutPath: join(paths.directory, "agent.stdout.log"),
        StandardErrorPath: join(paths.directory, "agent.stderr.log"),
      }),
      env: { PATH: "/usr/bin:/bin" },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error("Cannot encode Agent service definition");
  return result.stdout;
}

function readReceipt(paths: Paths): Receipt | null {
  if (!lstatSync(paths.receipt, { throwIfNoEntry: false })) return null;
  let value: Receipt;
  try {
    value = JSON.parse(privateFile(paths.receipt).toString());
  } catch {
    throw new Error("Invalid Agent service receipt");
  }
  if (
    value.version !== 1 ||
    value.config !== paths.config ||
    value.label !== paths.label ||
    typeof value.node !== "string" ||
    !value.node.startsWith("/") ||
    typeof value.cli !== "string" ||
    !value.cli.startsWith("/")
  )
    throw new Error(
      "Agent service identity conflict; use one configuration per private directory",
    );
  return value;
}

function observe(
  paths: Paths,
  domain: string,
): { state: ServiceState; receipt: Receipt | null } {
  const receipt = readReceipt(paths);
  const installed = !!lstatSync(paths.plist, { throwIfNoEntry: false });
  if (
    installed &&
    (!receipt ||
      privateFile(paths.plist).toString() !== definition(receipt, paths))
  )
    throw new Error(
      "Agent service definition does not match its private receipt",
    );
  const output = launch(["print", `${domain}/${paths.label}`], true);
  const loadedArguments = output
    ?.match(/^\s*arguments = \{\n([\s\S]*?)^\s*\}/m)?.[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    output !== null &&
    (!installed ||
      !receipt ||
      !output
        .split("\n")
        .some((line) => line.trim() === `path = ${paths.plist}`) ||
      !output
        .split("\n")
        .some((line) => line.trim() === `program = ${receipt.node}`) ||
      !output
        .split("\n")
        .some((line) => line.trim() === `EAGLE_CONFIG => ${receipt.config}`) ||
      JSON.stringify(loadedArguments) !==
        JSON.stringify([receipt.node, receipt.cli, "serve"]))
  )
    throw new Error("Loaded Agent service ownership could not be verified");
  const disabledOutput = launch(["print-disabled", domain]) ?? "";
  const escapedLabel = paths.label.replaceAll(".", "\\.");
  const disabledMatch = disabledOutput.match(
    new RegExp(`"${escapedLabel}"\\s*=>\\s*(disabled|enabled|true|false)`),
  );
  const disabled = disabledMatch
    ? ["disabled", "true"].includes(disabledMatch[1])
    : installed
      ? true
      : null;
  const status = output?.match(/^\s*state = (.+)$/m)?.[1];
  const pid = output?.match(/^\s*pid = ([0-9]+)$/m)?.[1];
  const lastExit = output?.match(/^\s*last exit code = (-?[0-9]+)$/m)?.[1];
  return {
    receipt,
    state: {
      label: paths.label,
      installed,
      loaded: output !== null,
      disabled,
      running: output === null ? false : status ? status === "running" : null,
      pid: pid ? Number(pid) : null,
      lastExit: lastExit ? Number(lastExit) : null,
    },
  };
}

function readConfiguration(paths: Paths) {
  let value: unknown;
  try {
    value = JSON.parse(privateFile(paths.config).toString());
  } catch {
    throw new Error("Cannot read private Agent configuration");
  }
  const config = ConfigSchema.parse(stripRetiredConfig(value).value);
  checkUrl(config.url);
  if (config.ownerOrigin) checkUrl(config.ownerOrigin);
  return config;
}

export function validateConfiguration(value: unknown) {
  const config = ConfigSchema.parse(value);
  checkUrl(config.url);
  if (config.ownerOrigin) checkUrl(config.ownerOrigin);
  if (
    config.execution?.commands &&
    config.execution.workingDirectory &&
    (!isAbsolute(config.execution.workingDirectory) ||
      !statSync(config.execution.workingDirectory).isDirectory())
  )
    throw new Error("Agent working directory is unavailable");
  return config;
}

function validConfiguration(paths: Paths) {
  return validateConfiguration(readConfiguration(paths));
}

function withControlLock<T>(paths: Paths, action: () => T): T {
  privateDirectory(paths.directory);
  if (!isMainThread || localLocks.has(paths.lock))
    throw new Error("Agent service control is busy");
  localLocks.add(paths.lock);
  let lock: DatabaseSync | undefined;
  try {
    privateFile(paths.lock, true, false);
    lock = new DatabaseSync(paths.lock);
    lock.exec("PRAGMA busy_timeout = 100; BEGIN EXCLUSIVE;");
    return action();
  } finally {
    lock?.close();
    localLocks.delete(paths.lock);
  }
}
export function withConfigurationControl<T>(
  configPath: string,
  action: () => T,
): T {
  return withControlLock(servicePaths(configPath), action);
}

/** Synchronous CLI control: mutations hold a separate real SQLite process lock. */
export function serviceCommand(
  action: string,
  configPath: string,
  cliPath: string,
): ServiceState {
  if (process.platform !== "darwin" || !process.getuid?.() || !isMainThread)
    throw new Error("Agent services require a non-root macOS user GUI session");
  if (!["install", "start", "stop", "status"].includes(action))
    throw new Error("Unknown Agent service action");
  const paths = servicePaths(configPath);
  const domain = `gui/${process.getuid()}`;
  if (action === "status") return observe(paths, domain).state;
  return withControlLock(paths, () => {
    const before = observe(paths, domain);
    const target = `${domain}/${paths.label}`;
    if (action === "install") {
      validConfiguration(paths);
      const node = realpathSync(process.execPath);
      const cli = realpathSync(cliPath);
      const manifest = JSON.parse(
        readFileSync(join(dirname(cli), "../../package.json"), "utf8"),
      );
      if (
        basename(cli) !== "cli.js" ||
        manifest.name !== "@nocoo/eagle-agent" ||
        manifest.bin?.["eagle-agent"] !== "dist/agent/cli.js"
      )
        throw new Error(
          "Install the packed Agent before configuring its service",
        );
      if ([node, cli, paths.config].some((value) => /[\r\n\0]/.test(value)))
        throw new Error("Invalid Agent service path");
      const receipt: Receipt = {
        version: 1,
        config: paths.config,
        node,
        cli,
        label: paths.label,
      };
      if (
        before.receipt &&
        JSON.stringify(before.receipt) !== JSON.stringify(receipt)
      )
        throw new Error(
          "Agent service already belongs to another installed runtime",
        );
      if (before.state.installed) return before.state;
      mkdirSync(dirname(paths.plist), { recursive: true, mode: 0o700 });
      if (!before.receipt)
        exclusiveFile(paths.receipt, JSON.stringify(receipt));
      for (const file of ["agent.stdout.log", "agent.stderr.log"])
        privateFile(join(paths.directory, file), true, false);
      launch(["disable", target]);
      exclusiveFile(paths.plist, definition(receipt, paths));
    } else if (action === "start") {
      if (!before.state.installed || !before.receipt)
        throw new Error("Install this Agent service first");
      validConfiguration(paths);
      for (const file of ["agent.stdout.log", "agent.stderr.log"])
        privateFile(join(paths.directory, file), true, false);
      launch(["enable", target]);
      if (before.state.running) return observe(paths, domain).state;
      if (!before.state.loaded) launch(["bootstrap", domain, paths.plist]);
      launch(["kickstart", "-p", target]);
    } else {
      if (!before.receipt || !before.state.installed)
        throw new Error("No owned Agent service to stop");
      launch(["disable", target]);
      if (before.state.loaded) launch(["bootout", target]);
    }
    let after = observe(paths, domain).state;
    const deadline = Date.now() + 5000;
    while (action === "stop" && after.loaded && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      after = observe(paths, domain).state;
    }
    if (action === "stop" && (after.loaded || after.disabled !== true))
      throw new Error("Agent service stop has not been confirmed");
    return after;
  });
}
