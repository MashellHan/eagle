// The shell tool (docs/bots/RUNTIME.md, "Tools"): one command runs inside the workspace,
// with a deadline and a byte cap, and receives only the variables a build needs — never
// the daemon's credentials. There is no approval gate: execution is the product.
import { spawn } from "node:child_process";
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

type Collected = { text: string; truncated: boolean };

export const runCommandTool = async (
  workspace: BotWorkspace,
  args: RunCommandArgs,
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
  return new Promise<ToolOutcome>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: childEnvironment(workspace.root),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Collected = { text: "", truncated: false };
    const err: Collected = { text: "", truncated: false };
    const collect = (target: Collected) => (chunk: Buffer) => {
      if (target.truncated) return;
      const remaining = MAX_COMMAND_OUTPUT_BYTES - Buffer.byteLength(target.text);
      if (remaining <= 0) {
        target.truncated = true;
        return;
      }
      const piece = chunk.subarray(0, remaining).toString("utf8");
      target.text += piece;
      if (Buffer.byteLength(target.text) >= MAX_COMMAND_OUTPUT_BYTES) target.truncated = true;
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.once("error", () => {
      clearTimeout(timer);
      resolve(failed(`the command could not be started: ${command}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve(
          failed(`the command timed out after ${timeoutMs} ms${out.text ? `\n${out.text}` : ""}`),
        );
        return;
      }
      const parts: string[] = [];
      if (out.text) parts.push(out.text.replace(/\n$/, ""));
      if (err.text) parts.push(`[stderr]\n${err.text.replace(/\n$/, "")}`);
      if (out.truncated || err.truncated) parts.push("[output truncated]");
      parts.push(`[exit code ${code ?? "none"}${signal ? `, signal ${signal}` : ""}]`);
      resolve({ output: parts.join("\n") });
    });
  });
};
