// The shell tool (docs/bots/RUNTIME.md, "Tools"): one command runs inside the workspace,
// with a deadline, a byte cap and a sandbox that keeps the daemon's root and every other
// bot out of reach. There is no approval gate: execution is the product. The child gets an
// allowlist environment, never the daemon's credentials.
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_TIMEOUT_MS,
} from "./limits.ts";
import { type BotWorkspace, failed, ToolError, type ToolOutcome } from "./types.ts";
import { canonicalWorkspace, resolveInside } from "./workspace.ts";

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

/** The argv a command runs as: sandboxed on macOS, plain elsewhere (documented). */
const commandArgv = async (
  workspace: BotWorkspace,
  command: string,
): Promise<readonly string[]> => {
  try {
    await stat(sandboxPath);
  } catch {
    return ["/bin/sh", "-c", command];
  }
  return [
    sandboxPath,
    "-p",
    sandboxProfile(workspace.root, workspace.daemonRoot),
    "/bin/sh",
    "-c",
    command,
  ];
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
    const root = await canonicalWorkspace(workspace.root);
    cwd = await resolveInside(root, args.cwd ?? ".");
  } catch (error) {
    return failed(error instanceof ToolError ? error.message : "the working directory is invalid");
  }
  // Both roots are canonical: a sandbox rule compares real paths, so `/var` versus
  // `/private/var` would silently disable the deny.
  const canonical: BotWorkspace = {
    root: await canonicalWorkspace(workspace.root),
    daemonRoot: await canonicalWorkspace(workspace.daemonRoot),
  };
  const argv = await commandArgv(canonical, command);
  return new Promise<ToolOutcome>((resolve) => {
    if (signal?.aborted === true) {
      resolve(failed("the command was aborted"));
      return;
    }
    // Its own process group, so a timeout or an abort takes the descendants with it.
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: childEnvironment(canonical.root),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let text = "";
    let bytes = 0;
    let truncated = false;
    const decoders: Record<Stream, StringDecoder> = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const append = (stream: Stream) => (chunk: Buffer) => {
      if (truncated) return;
      const remaining = MAX_COMMAND_OUTPUT_BYTES - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const piece = chunk.subarray(0, remaining);
      bytes += piece.length;
      const decoded = decoders[stream].write(piece);
      if (decoded.length > 0) {
        text +=
          stream === "stderr" && !text.endsWith("[stderr]\n") ? `[stderr]\n${decoded}` : decoded;
      }
      if (bytes >= MAX_COMMAND_OUTPUT_BYTES) truncated = true;
    };
    child.stdout.on("data", append("stdout"));
    child.stderr.on("data", append("stderr"));
    let stopped: "timeout" | "abort" | undefined;
    const stop = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      stopped = "timeout";
      stop();
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      stopped = "abort";
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", () => {
      finish();
      resolve(failed(`the command could not be started: ${command}`));
    });
    child.once("close", (code, signalName) => {
      finish();
      const body = text.replace(/\n$/, "");
      if (stopped === "abort") {
        resolve(failed(`the command was aborted${body ? `\n${body}` : ""}`));
        return;
      }
      if (stopped === "timeout") {
        resolve(failed(`the command timed out after ${timeoutMs} ms${body ? `\n${body}` : ""}`));
        return;
      }
      const parts: string[] = [];
      if (body.length > 0) parts.push(body);
      if (truncated) parts.push("[output truncated]");
      parts.push(`[exit code ${code ?? "none"}${signalName ? `, signal ${signalName}` : ""}]`);
      resolve({ output: parts.join("\n") });
    });
  });
};
