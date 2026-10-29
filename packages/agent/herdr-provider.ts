import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  type HerdrRequest,
  HerdrRequestSchema,
  type HerdrStatus,
} from "../contracts/src/execution.ts";
import { redact } from "./collector.ts";
import { runProcess } from "./command-runner.ts";
import type { OperationOutcome } from "./operation-journal.ts";
import {
  privateDirectory,
  privateFile,
  servicePaths,
  withConfigurationControl,
} from "./service.ts";

export type { HerdrRequest, HerdrStatus } from "../contracts/src/execution.ts";
export type HerdrProviderSettings = {
  configPath: string;
  binaryCandidates?: string[];
  secrets?: string[];
  installer?: (signal: AbortSignal) => Promise<string>;
  herdrConfigPath?: string;
};
const sessionSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const configurationSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  session: sessionSchema.nullable(),
  revision: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
});
const emptyStatus = (): HerdrStatus => ({
  state: "unknown",
  installed: null,
  version: null,
  enabled: false,
  session: null,
  revision: "unconfigured",
  sessions: [],
  checks: { cli: null, server: null, session: null, tools: null },
  observedAt: null,
});

async function officialInstaller(signal: AbortSignal): Promise<string> {
  const response = await fetch("https://herdr.dev/install.sh", {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok || !response.body)
    throw new Error("Official Herdr installer unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 128 * 1024) throw new Error("Installer limit exceeded");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const script = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
  if (!script.startsWith("#!/bin/sh\n"))
    throw new Error("Invalid official installer");
  return script;
}

export class HerdrProvider {
  private settings: HerdrProviderSettings;
  private directory: string;
  private configurationPath: string;
  private installDirectory: string;
  private latest = emptyStatus();
  private observation = 0;
  constructor(settings: HerdrProviderSettings) {
    this.settings = settings;
    this.directory = servicePaths(settings.configPath).directory;
    privateDirectory(this.directory);
    this.configurationPath = join(this.directory, "herdr-plugin.json");
    this.installDirectory = join(this.directory, "herdr-bin");
  }
  capabilities(): HerdrStatus {
    try {
      const current = this.configuration();
      if (current.revision !== this.latest.revision)
        return { ...emptyStatus(), ...this.selection(current) };
      if (
        this.latest.observedAt &&
        Date.now() - Date.parse(this.latest.observedAt) > 45_000
      )
        return { ...this.latest, state: "unknown" };
      return structuredClone(this.latest);
    } catch {
      return { ...emptyStatus(), state: "unavailable" };
    }
  }
  private selection(value: z.infer<typeof configurationSchema>) {
    return {
      enabled: value.enabled,
      session: value.session,
      revision: value.revision,
    };
  }
  validate(request: HerdrRequest): void {
    if (
      !HerdrRequestSchema.safeParse(request).success ||
      Object.values(request).some(
        (value) =>
          typeof value === "string" &&
          redact(value, this.settings.secrets ?? []) !== value,
      )
    )
      throw new Error("Invalid Herdr request");
  }
  private configuration() {
    privateDirectory(this.directory);
    return lstatSync(this.configurationPath, { throwIfNoEntry: false })
      ? configurationSchema.parse(
          JSON.parse(privateFile(this.configurationPath).toString()),
        )
      : {
          version: 1 as const,
          enabled: false,
          session: null,
          revision: "unconfigured",
        };
  }
  private save(
    value: { enabled: boolean; session: string | null },
    expectedRevision: string,
    signal: AbortSignal,
  ) {
    withConfigurationControl(this.settings.configPath, () => {
      signal.throwIfAborted();
      if (this.configuration().revision !== expectedRevision)
        throw new Error(
          "Herdr configuration changed; probe before applying a new selection",
        );
      const data = JSON.stringify(
        configurationSchema.parse({
          ...value,
          version: 1,
          revision: randomUUID(),
        }),
      );
      const temporary = join(this.directory, `.herdr-${randomUUID()}.tmp`);
      try {
        const file = openSync(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeFileSync(file, data);
          fsyncSync(file);
        } finally {
          closeSync(file);
        }
        if (lstatSync(this.configurationPath, { throwIfNoEntry: false }))
          privateFile(this.configurationPath);
        renameSync(temporary, this.configurationPath);
        const directory = openSync(
          this.directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      } finally {
        rmSync(temporary, { force: true });
      }
    });
  }
  private binary(): string | null {
    if (lstatSync(this.installDirectory, { throwIfNoEntry: false }))
      privateDirectory(this.installDirectory);
    const candidates = [
      join(this.installDirectory, "herdr"),
      ...(this.settings.binaryCandidates ?? [
        join(homedir(), ".local/bin/herdr"),
        "/opt/homebrew/bin/herdr",
        "/usr/local/bin/herdr",
      ]),
    ];
    for (const path of candidates) {
      if (!lstatSync(path, { throwIfNoEntry: false })) continue;
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    }
    return null;
  }
  private environment(binary: string): NodeJS.ProcessEnv {
    return {
      PATH: `${dirname(binary)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: homedir(),
      LANG: "en_US.UTF-8",
      ...(this.settings.herdrConfigPath
        ? { HERDR_CONFIG_PATH: this.settings.herdrConfigPath }
        : {}),
    };
  }
  private async invoke(binary: string, args: string[], signal: AbortSignal) {
    const result = await runProcess(
      { program: binary, args, cwd: this.directory, timeoutMs: 3000 },
      signal,
      this.settings.secrets ?? [],
      this.environment(binary),
      true,
    );
    signal.throwIfAborted();
    if (
      result.state !== "succeeded" ||
      result.exitCode !== 0 ||
      Buffer.byteLength(result.stdout + result.stderr) > 32_768 ||
      result.stderr.includes("[output truncated]") ||
      result.stdout.includes("\uFFFD")
    )
      throw new Error("Herdr CLI call unavailable");
    return result.stdout;
  }
  private async sessions(binary: string, signal: AbortSignal) {
    const inventory = JSON.parse(
      await this.invoke(binary, ["session", "list", "--json"], signal),
    );
    return z
      .array(z.object({ name: sessionSchema, running: z.boolean() }))
      .max(64)
      .parse(inventory.sessions);
  }
  async probe(signal: AbortSignal): Promise<HerdrStatus> {
    signal.throwIfAborted();
    const sequence = ++this.observation;
    const status = emptyStatus();
    status.observedAt = new Date().toISOString();
    const finish = () => {
      try {
        if (this.configuration().revision !== status.revision)
          status.state = "unknown";
      } catch {
        status.state = "unavailable";
      }
      if (sequence === this.observation) this.latest = status;
      return status;
    };
    try {
      const configuration = this.configuration();
      Object.assign(status, this.selection(configuration));
      const binary = this.binary();
      status.installed = binary !== null;
      if (!binary) {
        status.checks.cli = false;
        status.state = "not_installed";
        return finish();
      }
      status.state = "unavailable";
      status.checks.cli = false;
      const version = (await this.invoke(binary, ["--version"], signal))
        .trim()
        .match(/^herdr\s+([a-zA-Z0-9.+-]+)$/m)?.[1];
      if (
        !version ||
        version.length > 80 ||
        redact(version, this.settings.secrets ?? []) !== version
      )
        return finish();
      status.version = version;
      status.checks.cli = true;
      const sessions = await this.sessions(binary, signal);
      status.sessions = sessions.filter(
        (session) =>
          redact(session.name, this.settings.secrets ?? []) === session.name,
      );
      const selected = sessions.find(
        (session) => session.name === configuration.session,
      );
      if (!configuration.session) {
        status.state = sessions.some((session) => session.running)
          ? "disabled"
          : "needs_local_setup";
        return finish();
      }
      status.checks.session = selected?.running === true;
      if (!status.checks.session) {
        status.state = "needs_local_setup";
        return finish();
      }
      status.checks.server = false;
      const server = await this.invoke(
        binary,
        ["--session", configuration.session, "status"],
        signal,
      );
      status.checks.server =
        /^\s*status: running\s*$/m.test(server) &&
        /^\s*endpoint_compatible: yes\s*$/m.test(server) &&
        /^\s*private_protocol_compatible: yes\s*$/m.test(server);
      if (!status.checks.server) return finish();
      status.checks.tools = false;
      const tools = JSON.parse(
        await this.invoke(
          binary,
          ["--session", configuration.session, "agent", "list"],
          signal,
        ),
      );
      status.checks.tools =
        tools.result?.type === "agent_list" &&
        Array.isArray(tools.result.agents);
      status.state = status.checks.tools
        ? configuration.enabled
          ? "ready"
          : "disabled"
        : "unavailable";
    } catch {
      signal.throwIfAborted();
      status.state = "unavailable";
    }
    return finish();
  }
  private async install(signal: AbortSignal): Promise<OperationOutcome | null> {
    const script = await (this.settings.installer ?? officialInstaller)(signal);
    signal.throwIfAborted();
    privateDirectory(this.directory);
    const candidate = mkdtempSync(join(this.directory, ".herdr-install-"));
    const bin = join(candidate, "bin");
    const temporary = join(candidate, "tmp");
    mkdirSync(bin, { mode: 0o700 });
    mkdirSync(temporary, { mode: 0o700 });
    const path = join(candidate, "installer.sh");
    writeFileSync(path, script, { flag: "wx", mode: 0o600 });
    const result = await runProcess(
      { program: "/bin/sh", args: [path], cwd: candidate, timeoutMs: 120_000 },
      signal,
      this.settings.secrets ?? [],
      {
        HOME: homedir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "en_US.UTF-8",
        HERDR_INSTALL_DIR: bin,
        TMPDIR: temporary,
      },
    );
    if (result.state !== "succeeded")
      return {
        ...result,
        stdout: "",
        stderr:
          "Herdr installation did not complete; inspect local setup before retrying",
      };
    signal.throwIfAborted();
    const installed = join(bin, "herdr");
    const stat = lstatSync(installed);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0 ||
      !(stat.mode & 0o100)
    )
      throw new Error("Herdr installer did not produce a valid executable");
    withConfigurationControl(this.settings.configPath, () => {
      signal.throwIfAborted();
      if (this.binary() !== null) return;
      if (!lstatSync(this.installDirectory, { throwIfNoEntry: false }))
        mkdirSync(this.installDirectory, { mode: 0o700 });
      privateDirectory(this.installDirectory);
      // Exclusive linking cannot replace a binary installed by another actor.
      linkSync(installed, join(this.installDirectory, "herdr"));
      unlinkSync(installed);
      const descriptor = openSync(
        this.installDirectory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    });
    return null;
  }
  private async createSession(
    binary: string,
    session: string,
    signal: AbortSignal,
  ) {
    if (
      (await this.sessions(binary, signal)).some(
        (value) => value.name === session,
      )
    )
      throw new Error(
        "Herdr session already exists; explicitly select it instead",
      );
    signal.throwIfAborted();
    const child = spawn(binary, ["--session", session, "server"], {
      cwd: this.directory,
      env: this.environment(binary),
      detached: true,
      stdio: "ignore",
    });
    let exited = false;
    child.on("error", () => {
      exited = true;
    });
    child.on("exit", () => {
      exited = true;
    });
    child.unref();
    // A newly created Herdr server is independent of the Agent. Cancellation
    // cannot certify creation failed, so retain it for explicit reconciliation.
    try {
      for (;;) {
        signal.throwIfAborted();
        const sessions = await this.sessions(binary, signal);
        if (exited) throw new Error("Herdr session creation result unknown");
        if (sessions.some((value) => value.name === session && value.running))
          return;
        await delay(100, undefined, { signal });
      }
    } catch {
      throw new Error(
        "Herdr session creation result unknown; probe the explicit session before a new attempt",
      );
    }
  }
  async run(
    request: HerdrRequest,
    signal: AbortSignal,
  ): Promise<OperationOutcome> {
    this.validate(request);
    signal.throwIfAborted();
    if (request.tool === "herdr.inspect") {
      const status = await this.probe(signal);
      if (!status.enabled) throw new Error("Herdr capability disabled");
      if (status.state !== "ready" || !status.session)
        throw new Error("Herdr session unavailable");
      if (
        status.revision !== request.expectedRevision ||
        status.session !== request.session
      )
        throw new Error("Herdr configuration changed; probe before inspecting");
      const resource = {
        agents: "agent",
        workspaces: "workspace",
        panes: "pane",
      }[request.action as "agents" | "workspaces" | "panes"];
      const binary = this.binary();
      if (!binary) throw new Error("Herdr CLI unavailable");
      const value = JSON.parse(
        await this.invoke(
          binary,
          ["--session", status.session, resource, "list"],
          signal,
        ),
      );
      const sanitize = (value: unknown): unknown => {
        if (typeof value === "string") {
          const clean = redact(value, this.settings.secrets ?? []);
          // A marker next to JSON punctuation may not be text-redaction idempotent.
          // Keep the JSON valid and safe for the final whole-message credential check.
          const encoded = JSON.stringify(clean);
          return redact(encoded, this.settings.secrets ?? []) === encoded
            ? clean
            : "[REDACTED]";
        }
        if (Array.isArray(value)) return value.map(sanitize);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value)
              .filter(
                ([key]) =>
                  redact(key, this.settings.secrets ?? []) === key &&
                  redact(JSON.stringify(key), this.settings.secrets ?? []) ===
                    JSON.stringify(key),
              )
              .map(([key, child]) => [key, sanitize(child)]),
          );
        return value;
      };
      const stdout = JSON.stringify(sanitize(value));
      if (Buffer.byteLength(stdout) > 32_768)
        throw new Error("Herdr result limit exceeded");
      const current = this.configuration();
      if (!current.enabled || current.revision !== status.revision)
        throw new Error("Herdr configuration changed");
      return { state: "succeeded", stdout, stderr: "", exitCode: null };
    }
    if (request.action === "configure")
      this.save(
        { enabled: request.enabled, session: request.session },
        request.expectedRevision,
        signal,
      );
    if (request.action === "disable")
      this.save(
        { ...this.configuration(), enabled: false },
        request.expectedRevision,
        signal,
      );
    if (request.action === "create_session") {
      if (this.configuration().revision !== request.expectedRevision)
        throw new Error("Herdr configuration changed");
      const binary = this.binary();
      if (!binary) throw new Error("Herdr CLI unavailable");
      await this.createSession(binary, request.session, signal);
      this.save(
        { enabled: request.enabled, session: request.session },
        request.expectedRevision,
        signal,
      );
    }
    if (request.action === "install" && this.binary() === null) {
      const failed = await this.install(signal);
      if (failed) return failed;
    }
    const status = await this.probe(signal);
    return {
      state: "succeeded",
      stdout: JSON.stringify(status),
      stderr: "",
      exitCode: null,
    };
  }
}
