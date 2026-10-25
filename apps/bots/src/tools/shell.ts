// The shell tool (docs/bots/RUNTIME.md, "Tools"): one command runs inside the workspace,
// with a deadline, a byte cap and a sandbox that keeps the daemon's root and every other
// bot out of reach. There is no approval gate: execution is the product. The child gets an
// allowlist environment, never the daemon's credentials.
import { execFileSync, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_TIMEOUT_MS,
} from "./limits.ts";
import { type BotWorkspace, failed, ToolError, type ToolOutcome } from "./types.ts";
import { assertWorkspaceIdentity, resolveInside } from "./workspace.ts";

export type RunCommandArgs = {
  readonly command: string;
  /** Working directory, relative to the workspace (default the workspace root). */
  readonly cwd?: string;
  readonly timeoutMs?: number;
};

/** The child's environment: what a build needs, never the daemon's secrets. */
const childEnvironment = (workspace: string): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SHELL"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.TERM = "dumb";
  environment.PWD = workspace;
  return environment;
};

/** A Seatbelt profile: read/write the workspace, never the daemon's root. */
export const sandboxProfile = (workspaceRoot: string, daemonRoot: string): string => {
  const quote = (path: string) => path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath "${quote(daemonRoot)}"))`,
    // Path resolution has to see the directories above the workspace; reading a file
    // under the daemon root is still denied.
    `(allow file-read-metadata (subpath "${quote(daemonRoot)}"))`,
    `(allow file-read* file-write* (subpath "${quote(workspaceRoot)}"))`,
  ].join("");
};

const sandboxPath = "/usr/bin/sandbox-exec";

/**
 * The argv a command runs as. On a platform without `sandbox-exec` the command runs
 * plain (documented); a machine that has it but cannot stat it is an error, never a
 * silent unsandboxed run.
 */
const commandArgv = async (
  workspace: BotWorkspace,
  command: string,
): Promise<readonly string[]> => {
  if (process.platform !== "darwin") return ["/bin/sh", "-c", command];
  const available = await stat(sandboxPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw new ToolError(`the command sandbox is unavailable: ${error.code ?? "unknown"}`);
    },
  );
  if (!available) return ["/bin/sh", "-c", command];
  return [
    sandboxPath,
    "-p",
    sandboxProfile(workspace.root, workspace.daemonRoot),
    "/bin/sh",
    "-c",
    command,
  ];
};

/**
 * Kills a command and every process it started. `process.kill(-pid)` covers the group;
 * the `ps` walk catches a descendant that left the group with `setsid`, which would
 * otherwise outlive the deadline and hold the output pipes open.
 */
const killTree = (pid: number): void => {
  const descendants: number[] = [];
  try {
    const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    const children = new Map<number, number[]>();
    for (const row of rows.split("\n")) {
      const [child, parent] = row.trim().split(/\s+/).map(Number);
      if (child === undefined || parent === undefined) continue;
      if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
      const list = children.get(parent) ?? [];
      list.push(child);
      children.set(parent, list);
    }
    const queue = [pid];
    while (queue.length > 0) {
      const current = queue.shift() as number;
      for (const child of children.get(current) ?? []) {
        descendants.push(child);
        queue.push(child);
      }
    }
  } catch {
    // The group kill below is still the primary mechanism.
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group may already be gone.
  }
  for (const child of descendants.reverse()) {
    try {
      process.kill(child, "SIGKILL");
    } catch {
      // A process that already exited needs no kill.
    }
  }
};

type Stream = "stdout" | "stderr";

export const runCommandTool = async (
  workspace: BotWorkspace,
  args: RunCommandArgs,
  signal?: AbortSignal,
): Promise<ToolOutcome> => {
  const command = args.command.trim();
  if (command.length === 0) return failed("a command is required");
  const timeoutMs = Math.min(
    Math.max(args.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, 1),
    MAX_COMMAND_TIMEOUT_MS,
  );
  let cwd: string;
  try {
    await assertWorkspaceIdentity(workspace);
    cwd = await resolveInside(workspace.root, args.cwd ?? ".");
  } catch (error) {
    return failed(error instanceof ToolError ? error.message : "the working directory is invalid");
  }
  let argv: readonly string[];
  try {
    argv = await commandArgv(workspace, command);
  } catch (error) {
    return failed(
      error instanceof ToolError ? error.message : "the command sandbox is unavailable",
    );
  }
  return new Promise<ToolOutcome>((resolve) => {
    if (signal?.aborted === true) {
      resolve(failed("the command was aborted"));
      return;
    }
    // Its own process group, so a timeout or an abort takes the descendants with it.
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: childEnvironment(workspace.root),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let text = "";
    let bytes = 0;
    let truncated = false;
    let stderrStarted = false;
    const decoders: Record<Stream, StringDecoder> = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const append = (stream: Stream) => (chunk: Buffer) => {
      if (truncated) return;
      const marker = stream === "stderr" && !stderrStarted ? "[stderr]\n" : "";
      const remaining = MAX_COMMAND_OUTPUT_BYTES - bytes - marker.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (marker.length > 0) stderrStarted = true;
      const piece = chunk.subarray(0, remaining);
      bytes += piece.length + marker.length;
      text += marker;
      const decoded = decoders[stream].write(piece);
      if (decoded.length > 0) text += decoded;
      if (bytes >= MAX_COMMAND_OUTPUT_BYTES || piece.length < chunk.length) truncated = true;
    };
    child.stdout.on("data", append("stdout"));
    child.stderr.on("data", append("stderr"));
    let settled = false;
    const settle = (outcome: ToolOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve(outcome);
    };
    let stopped: "timeout" | "abort" | undefined;
    const stop = (reason: "timeout" | "abort") => {
      stopped = reason;
      if (child.pid !== undefined) killTree(child.pid);
      // Flush whatever was decoded so the model keeps the diagnostics it already has.
      const tail = text + decoders.stdout.end() + decoders.stderr.end();
      const body = tail.replace(/\n$/, "");
      const why =
        reason === "abort"
          ? "the command was aborted"
          : `the command timed out after ${timeoutMs} ms`;
      settle(failed(`${why}${body ? `\n${body}` : ""}`));
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    timer.unref?.();
    const onAbort = () => stop("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => settle(failed(`the command could not be started: ${command}`)));
    child.once("close", (code, signalName) => {
      if (stopped !== undefined) return; // a killed command already answered
      const body = (text + decoders.stdout.end() + decoders.stderr.end()).replace(/\n$/, "");
      const parts: string[] = [];
      if (body.length > 0) parts.push(body);
      if (truncated) parts.push("[output truncated]");
      parts.push(`[exit code ${code ?? "none"}${signalName ? `, signal ${signalName}` : ""}]`);
      settle({ output: parts.join("\n") });
    });
  });
};
