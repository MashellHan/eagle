import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  ExecutionOperationSchema,
  executionTimeoutMs,
} from "../contracts/src/execution.ts";
import { redact } from "./collector.ts";
import type { FileProvider, FileRequest } from "./file-provider.ts";
import type { HerdrProvider, HerdrRequest } from "./herdr-provider.ts";
import {
  OperationAdmissionError,
  type OperationJournal,
  type OperationOutcome,
  type OperationRecord,
  type OperationScope,
} from "./operation-journal.ts";

export type CommandRequest = {
  id: string;
  machineId: string;
  program: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
};
export type CommandSettings = {
  machineId: string;
  enabled: boolean;
  workingDirectory: string;
  secrets?: string[];
  files?: FileProvider;
  herdr?: HerdrProvider;
};

function prefix(text: string, budget: number) {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, Math.max(0, budget));
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
export function runProcess(
  request: Pick<
    Required<CommandRequest>,
    "program" | "args" | "cwd" | "timeoutMs"
  >,
  signal: AbortSignal,
  secrets: string[],
  environment: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
  },
  internalStructuredOutput = false,
): Promise<OperationOutcome> {
  const empty = { stdout: "", stderr: "", exitCode: null };
  if (signal.aborted) return Promise.resolve({ ...empty, state: "cancelled" });
  return new Promise((resolve) => {
    const child = spawn(request.program, request.args, {
      cwd: request.cwd,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    const decoder = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const output = { stdout: "", stderr: "" };
    let remaining = 63 * 1024;
    let truncated = false;
    let settled = false;
    let started = false;
    let reason: "cancel" | "timeout" | "output pipe did not close" | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const capture = (stream: "stdout" | "stderr", text: string) => {
      const part = prefix(text, remaining);
      remaining -= Buffer.byteLength(part);
      output[stream] += part;
      truncated ||= part.length !== text.length;
    };
    const safe = (text: string, incomplete: boolean) => {
      // Only a fixed provider may parse raw bounded output, then sanitize fields.
      // This option is never part of a remotely supplied command request.
      if (internalStructuredOutput) return text;
      let clean = redact(text, secrets);
      // Capture starts at the first byte but may end inside a known credential.
      if (incomplete)
        for (const secret of secrets) {
          for (let n = Math.min(secret.length - 1, clean.length); n > 0; n--) {
            if (clean.endsWith(secret.slice(0, n))) {
              clean = `${clean.slice(0, -n)}[REDACTED]`;
              break;
            }
          }
        }
      return clean;
    };
    const finish = (
      state: OperationOutcome["state"],
      exitCode: number | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      clearTimeout(drainTimer);
      signal.removeEventListener("abort", abort);
      capture("stdout", decoder.stdout.end());
      capture("stderr", decoder.stderr.end());
      const incomplete = truncated || state === "unknown";
      const stdout = prefix(safe(output.stdout, incomplete), 63 * 1024);
      let stderr = prefix(
        safe(output.stderr, incomplete),
        63 * 1024 - Buffer.byteLength(stdout),
      );
      if (truncated) stderr += "\n[output truncated]";
      if (reason) stderr += `\n[${reason}; result unknown]`;
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ state, stdout, stderr, exitCode });
    };
    const killGroup = (name: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch {
        /* A missing group is not proof of an operation's outcome. */
      }
    };
    const stop = (why: NonNullable<typeof reason>) => {
      if (settled || reason) return;
      reason = why;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 200);
      settleTimer = setTimeout(() => finish("unknown", null), 1500);
    };
    const abort = () => stop("cancel");
    const deadline = setTimeout(() => stop("timeout"), request.timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.once("spawn", () => {
      started = true;
      if (signal.aborted) abort();
    });
    child.stdout.on("data", (chunk: Buffer) =>
      capture("stdout", decoder.stdout.write(chunk)),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      capture("stderr", decoder.stderr.write(chunk)),
    );
    child.once("error", () => finish(started ? "unknown" : "failed", null));
    child.once("exit", () => {
      if (!settled)
        drainTimer = setTimeout(() => stop("output pipe did not close"), 300);
    });
    child.once("close", (code) => {
      if (reason) {
        // Best-effort group cleanup; escaped descendants cannot be certified dead.
        killGroup("SIGKILL");
        finish("unknown", null);
      } else
        finish(
          code === 0 ? "succeeded" : code === null ? "unknown" : "failed",
          code,
        );
    });
  });
}

export class CommandRunner {
  private journal: OperationJournal;
  private settings: CommandSettings;
  private active = new Map<
    string,
    { controller: AbortController; result: Promise<OperationRecord> }
  >();
  private closed = false;
  private unhealthy = false;
  constructor(journal: OperationJournal, settings: CommandSettings) {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(settings.machineId) ||
      typeof settings.enabled !== "boolean" ||
      typeof settings.workingDirectory !== "string" ||
      (settings.enabled &&
        (!isAbsolute(settings.workingDirectory) ||
          !statSync(settings.workingDirectory).isDirectory())) ||
      (settings.secrets ?? []).some(
        (secret) =>
          typeof secret !== "string" ||
          secret.length < 8 ||
          secret.length > 4096,
      )
    )
      throw new Error("Invalid command configuration");
    this.journal = journal;
    this.settings = {
      ...settings,
      workingDirectory: settings.enabled
        ? realpathSync(settings.workingDirectory)
        : settings.workingDirectory,
      secrets: [...(settings.secrets ?? [])],
    };
  }
  async runFile(
    input: FileRequest & { id: string; machineId: string; timeoutMs?: number },
  ): Promise<OperationRecord> {
    if (this.closed || this.unhealthy)
      throw new Error("Execution service unavailable");
    const files = this.settings.files;
    if (!files) throw new Error("File capability disabled");
    if (
      !input ||
      input.machineId !== this.settings.machineId ||
      typeof input.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,120}$/.test(input.id) ||
      redact(input.id, this.settings.secrets ?? []) !== input.id ||
      Object.keys(input).some(
        (key) =>
          ![
            "id",
            "machineId",
            "tool",
            "grantId",
            "generation",
            "path",
            "timeoutMs",
          ].includes(key),
      )
    )
      throw new Error("Invalid file operation");
    const request = {
      id: input.id,
      machineId: input.machineId,
      tool: input.tool,
      grantId: input.grantId,
      generation: input.generation,
      path: input.path,
      timeoutMs: input.timeoutMs ?? 5000,
    };
    if (
      !Number.isInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > 5000 ||
      Buffer.byteLength(JSON.stringify(request)) > 16_384
    )
      throw new Error("Invalid file operation budget");
    const scope = files.authorize(request);
    const digest = createHash("sha256")
      .update(JSON.stringify([request, scope]))
      .digest("hex");
    return this.admit(
      request.id,
      digest,
      async (signal) => {
        const timeout = AbortSignal.timeout(request.timeoutMs);
        try {
          return await files.run(request, AbortSignal.any([signal, timeout]));
        } catch {
          return {
            state: signal.aborted
              ? "cancelled"
              : timeout.aborted
                ? "unknown"
                : "failed",
            stdout: "",
            stderr: "File operation cancelled, denied or unavailable",
            exitCode: null,
          };
        }
      },
      scope,
    );
  }
  getVisible(id: string): OperationRecord | null {
    const operation = this.journal.get(id);
    const scope = this.journal.getScope(id);
    if (scope) {
      if (!this.settings.files) throw new Error("File grant unavailable");
      this.settings.files.authorizeScope(scope);
    }
    return operation;
  }
  async runHerdr(
    input: HerdrRequest & { id: string; machineId: string; timeoutMs?: number },
  ): Promise<OperationRecord> {
    if (this.closed || this.unhealthy)
      throw new Error("Execution service unavailable");
    const herdr = this.settings.herdr;
    if (!herdr) throw new Error("Herdr capability disabled");
    const parsed = ExecutionOperationSchema.safeParse(input);
    if (
      !parsed.success ||
      !["herdr.setup", "herdr.inspect"].includes(parsed.data.tool) ||
      input.machineId !== this.settings.machineId ||
      Object.values(input).some(
        (value) =>
          typeof value === "string" &&
          redact(value, this.settings.secrets ?? []) !== value,
      )
    )
      throw new Error("Invalid Herdr operation or machine identity");
    const { id, machineId: _machine, timeoutMs: _timeout, ...request } = input;
    herdr.validate(request);
    const timeoutMs = executionTimeoutMs(parsed.data);
    const digest = createHash("sha256")
      .update(JSON.stringify({ ...parsed.data, timeoutMs }))
      .digest("hex");
    return this.admit(id, digest, async (signal) => {
      const empty = { stdout: "", stderr: "", exitCode: null };
      if (signal.aborted) return { ...empty, state: "cancelled" };
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        return await herdr.run(request, AbortSignal.any([signal, timeout]));
      } catch (error) {
        const unknown =
          signal.aborted ||
          timeout.aborted ||
          (error instanceof Error && /unknown/.test(error.message));
        return {
          ...empty,
          state: unknown ? "unknown" : "failed",
          stderr: unknown
            ? "Herdr operation result unknown; query this ID and probe before new work"
            : "Herdr operation refused or unavailable; refresh setup state",
        };
      }
    });
  }
  async run(input: CommandRequest): Promise<OperationRecord> {
    if (this.closed || this.unhealthy)
      throw new Error("Command service unavailable");
    if (!this.settings.enabled) throw new Error("Command capability disabled");
    if (!input || input.machineId !== this.settings.machineId)
      throw new Error("Machine identity mismatch");
    if (
      typeof input.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,120}$/.test(input.id) ||
      typeof input.program !== "string" ||
      !isAbsolute(input.program) ||
      !Array.isArray(input.args) ||
      input.args.length > 128 ||
      !input.args.every(
        (arg) => typeof arg === "string" && !arg.includes("\0"),
      ) ||
      (input.cwd !== undefined &&
        (typeof input.cwd !== "string" || !isAbsolute(input.cwd))) ||
      Object.keys(input).some(
        (key) =>
          !["id", "machineId", "program", "args", "cwd", "timeoutMs"].includes(
            key,
          ),
      )
    )
      throw new Error("Invalid command request");
    const request = {
      id: input.id,
      machineId: input.machineId,
      program: input.program,
      args: [...input.args],
      cwd: input.cwd ?? this.settings.workingDirectory,
      timeoutMs: input.timeoutMs ?? 30_000,
    };
    const text = JSON.stringify(request);
    if (
      !Number.isInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > 120_000 ||
      request.program.includes("\0") ||
      request.cwd.includes("\0") ||
      Buffer.byteLength(text) > 16_384
    )
      throw new Error("Invalid or over-budget command request");
    const secrets = this.settings.secrets ?? [];
    if (
      [
        request.id,
        request.machineId,
        request.program,
        request.cwd,
        ...request.args,
      ].some((value) => redact(value, secrets) !== value)
    )
      throw new Error("Credential in command request");
    const digest = createHash("sha256").update(text).digest("hex");
    return this.admit(request.id, digest, (signal) =>
      runProcess(request, signal, secrets),
    );
  }
  private admit(
    id: string,
    digest: string,
    execute: (signal: AbortSignal) => Promise<OperationOutcome>,
    scope?: OperationScope,
  ): Promise<OperationRecord> {
    let admission: ReturnType<OperationJournal["begin"]>;
    try {
      if (this.active.size && !this.journal.get(id))
        throw new OperationAdmissionError("Command service busy");
      admission = this.journal.begin(id, digest, scope);
    } catch (error) {
      if (error instanceof OperationAdmissionError) throw error;
      this.unhealthy = true;
      throw new Error("Operation storage unavailable");
    }
    if (!admission.created) {
      const active = this.active.get(id);
      if (active) return active.result;
      const visible = this.getVisible(id);
      if (!visible) throw new Error("Operation storage unavailable");
      return Promise.resolve(visible);
    }
    const controller = new AbortController();
    const result = new Promise<OperationRecord>((resolve, reject) => {
      queueMicrotask(async () => {
        let outcome: OperationOutcome;
        try {
          outcome = await execute(controller.signal);
        } catch {
          outcome = {
            state: "unknown",
            stdout: "",
            stderr: "Execution result unavailable",
            exitCode: null,
          };
        }
        if (scope) {
          try {
            this.settings.files?.authorizeScope(scope);
          } catch {
            outcome = {
              state: "failed",
              stdout: "",
              stderr: "File grant revoked",
              exitCode: null,
            };
          }
        }
        let stored: OperationRecord;
        try {
          stored = this.journal.finish(id, outcome);
        } catch {
          this.unhealthy = true;
          reject(new Error("Operation storage unavailable"));
          return;
        } finally {
          this.active.delete(id);
        }
        try {
          if (scope) this.getVisible(id);
          resolve(stored);
        } catch (error) {
          reject(error);
        }
      });
    });
    this.active.set(id, { controller, result });
    return result;
  }
  cancel(id: string): boolean {
    const active = this.active.get(id);
    if (!active) return false;
    active.controller.abort();
    return true;
  }
  async close(): Promise<void> {
    this.closed = true;
    const work = [...this.active.values()];
    for (const active of work) active.controller.abort();
    await Promise.all(work.map((active) => active.result));
  }
}
