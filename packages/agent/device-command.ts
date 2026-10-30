import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { redact } from "./collector.ts";
import type { OperationOutcome } from "./device-journal.ts";

function prefix(text: string, budget: number) {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, Math.max(0, budget));
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
export function runProcess(
  request: Pick<
    { program: string; args: string[]; cwd: string; timeoutMs: number },
    "program" | "args" | "cwd" | "timeoutMs"
  >,
  signal: AbortSignal,
  secrets: string[],
  environment: Record<string, string | undefined> = {
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
      env: environment as NodeJS.ProcessEnv,
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
