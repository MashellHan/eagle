// The herdr CLI is the only door to a terminal session (docs/bots/RUNTIME.md, "Herdr
// tools"): one argv, no shell, a deadline and a bounded answer. Everything the tools know
// about spaces, panes and agents comes from these JSON responses, never from guessing.
import { spawn } from "node:child_process";

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export class HerdrCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrCommandError";
    this.code = code;
  }
}

export type HerdrWorkspaceInfo = {
  readonly id: string;
  readonly label: string;
};

export type HerdrAgentInfo = {
  /** The live agent name, when herdr assigned one. */
  readonly name: string | undefined;
  readonly kind: string;
  readonly status: string;
  readonly paneId: string;
  readonly workspaceId: string;
};

export type HerdrPaneInfo = {
  readonly paneId: string;
  readonly workspaceId: string;
};

export type HerdrCreation = {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly rootPaneId: string;
};

export type HerdrReadSource = "visible" | "recent" | "recent-unwrapped" | "detection";

export type RunOptions = {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal | undefined;
};

export type HerdrClient = {
  listWorkspaces(options?: RunOptions): Promise<readonly HerdrWorkspaceInfo[]>;
  createWorkspace(
    input: { readonly label: string; readonly cwd: string },
    options?: RunOptions,
  ): Promise<HerdrCreation>;
  closeWorkspace(id: string, options?: RunOptions): Promise<void>;
  getWorkspace(id: string, options?: RunOptions): Promise<HerdrWorkspaceInfo | undefined>;
  listAgents(options?: RunOptions): Promise<readonly HerdrAgentInfo[]>;
  listPanes(workspaceId: string, options?: RunOptions): Promise<readonly HerdrPaneInfo[]>;
  startAgent(
    input: {
      readonly name: string;
      readonly kind: string;
      readonly paneId: string;
      readonly args?: readonly string[];
    },
    options?: RunOptions,
  ): Promise<void>;
  prompt(
    input: {
      readonly target: string;
      readonly text: string;
      readonly wait?: boolean;
      readonly until?: readonly string[] | undefined;
    },
    options?: RunOptions,
  ): Promise<string>;
  wait(
    input: { readonly target: string; readonly until?: readonly string[] | undefined },
    options?: RunOptions,
  ): Promise<string>;
  read(
    input: {
      readonly target: string;
      readonly lines?: number;
      readonly source?: HerdrReadSource;
    },
    options?: RunOptions,
  ): Promise<string>;
  sendKeys(
    input: { readonly target: string; readonly keys: readonly string[] },
    options?: RunOptions,
  ): Promise<void>;
};

export type HerdrCliOptions = {
  readonly binary?: string;
  readonly env?: NodeJS.ProcessEnv;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

const result = (value: unknown): Record<string, unknown> => asRecord(asRecord(value)?.result) ?? {};

/** The state herdr reports after a prompt or a wait; herdr names it differently per call. */
const stateOf = (value: unknown): string => {
  const payload = result(value);
  return (
    asString(payload.state) ||
    asString(payload.status) ||
    asString(asRecord(payload.agent)?.agent_status) ||
    "accepted"
  );
};

const messageOf = (error: unknown): { code: string; message: string } => {
  const record = asRecord(asRecord(error)?.error) ?? asRecord(error);
  const code = asString(record?.code, "herdr_failed");
  const message = asString(record?.message, "herdr failed");
  return { code, message };
};

export const createHerdrClient = (options: HerdrCliOptions = {}): HerdrClient => {
  const binary = options.binary ?? "herdr";

  const run = (
    args: readonly string[],
    runOptions: RunOptions,
  ): Promise<{ readonly text: string; readonly json: unknown }> =>
    new Promise((resolve, reject) => {
      const timeoutMs = runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const child = spawn(binary, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...options.env },
        detached: true,
      });
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failed: HerdrCommandError | undefined;
      const stop = () => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        failed = new HerdrCommandError(
          "timeout",
          `herdr ${args[0]} timed out after ${timeoutMs} ms`,
        );
        stop();
      }, timeoutMs);
      timer.unref?.();
      const onAbort = () => {
        failed = new HerdrCommandError("aborted", "the herdr command was aborted");
        stop();
      };
      runOptions.signal?.addEventListener("abort", onAbort, { once: true });
      const finish = () => {
        clearTimeout(timer);
        runOptions.signal?.removeEventListener("abort", onAbort);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutBytes >= MAX_STDOUT_BYTES) return;
        const piece = chunk.subarray(0, MAX_STDOUT_BYTES - stdoutBytes);
        stdoutBytes += piece.length;
        stdout += piece.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= MAX_STDERR_BYTES) return;
        const piece = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
        stderrBytes += piece.length;
        stderr += piece.toString("utf8");
      });
      child.once("error", () => {
        finish();
        reject(new HerdrCommandError("spawn_failed", `herdr could not start: ${binary}`));
      });
      child.once("close", (code) => {
        finish();
        if (failed !== undefined) {
          reject(failed);
          return;
        }
        const trimmed = stdout.trim();
        let json: unknown;
        if (trimmed.startsWith("{")) {
          try {
            json = JSON.parse(trimmed);
          } catch {
            json = undefined;
          }
        }
        if (code === 0) {
          resolve({ text: trimmed, json });
          return;
        }
        const parsed = asRecord(json);
        if (parsed?.error !== undefined) {
          const { code: errorCode, message } = messageOf(parsed);
          reject(new HerdrCommandError(errorCode, message));
          return;
        }
        // A CLI server error is JSON on stderr; read its code and message before the text.
        const errorBody = stderr.trim();
        if (errorBody.startsWith("{")) {
          try {
            const parsedError = JSON.parse(errorBody) as unknown;
            const { code: errorCode, message } = messageOf(parsedError);
            reject(new HerdrCommandError(errorCode, message));
            return;
          } catch {
            // Fall through to the textual report.
          }
        }
        const detail = errorBody || trimmed;
        reject(
          new HerdrCommandError(
            "herdr_failed",
            `herdr ${args.slice(0, 2).join(" ")} failed (exit ${code ?? "none"}): ${detail.slice(0, 2_000) || "no detail"}`,
          ),
        );
      });
    });

  return {
    async listWorkspaces(runOptions = {}) {
      const output = result((await run(["workspace", "list"], runOptions)).json);
      const workspaces = Array.isArray(output.workspaces) ? output.workspaces : [];
      return workspaces.flatMap((entry) => {
        const record = asRecord(entry);
        const id = asString(record?.workspace_id);
        return id.length === 0 ? [] : [{ id, label: asString(record?.label) }];
      });
    },
    async createWorkspace(input, runOptions = {}) {
      const output = result(
        (
          await run(
            ["workspace", "create", "--cwd", input.cwd, "--label", input.label, "--no-focus"],
            runOptions,
          )
        ).json,
      );
      const workspace = asRecord(output.workspace);
      const tab = asRecord(output.tab);
      const pane = asRecord(output.root_pane);
      const workspaceId = asString(workspace?.workspace_id);
      const tabId = asString(tab?.tab_id);
      const rootPaneId = asString(pane?.pane_id);
      if (workspaceId.length === 0 || rootPaneId.length === 0) {
        throw new HerdrCommandError("invalid_response", "herdr did not return the new workspace");
      }
      return { workspaceId, tabId, rootPaneId };
    },
    async closeWorkspace(id, runOptions = {}) {
      await run(["workspace", "close", id], runOptions);
    },
    async getWorkspace(id, runOptions = {}) {
      const output = result((await run(["workspace", "get", id], runOptions)).json);
      const workspace = asRecord(output.workspace);
      const workspaceId = asString(workspace?.workspace_id);
      return workspaceId.length === 0
        ? undefined
        : { id: workspaceId, label: asString(workspace?.label) };
    },
    async listAgents(runOptions = {}) {
      const output = result((await run(["agent", "list"], runOptions)).json);
      const agents = Array.isArray(output.agents) ? output.agents : [];
      return agents.flatMap((entry) => {
        const record = asRecord(entry);
        const paneId = asString(record?.pane_id);
        if (paneId.length === 0) return [];
        const name = asString(record?.name);
        return [
          {
            name: name.length === 0 ? undefined : name,
            kind: asString(record?.agent),
            status: asString(record?.agent_status, "unknown"),
            paneId,
            workspaceId: asString(record?.workspace_id),
          },
        ];
      });
    },
    async listPanes(workspaceId, runOptions = {}) {
      const output = result(
        (await run(["pane", "list", "--workspace", workspaceId], runOptions)).json,
      );
      const panes = Array.isArray(output.panes) ? output.panes : [];
      return panes.flatMap((entry) => {
        const record = asRecord(entry);
        const paneId = asString(record?.pane_id);
        return paneId.length === 0
          ? []
          : [{ paneId, workspaceId: asString(record?.workspace_id, workspaceId) }];
      });
    },
    async startAgent(input, runOptions = {}) {
      const args = ["agent", "start", input.name, "--kind", input.kind, "--pane", input.paneId];
      if (input.args !== undefined && input.args.length > 0) args.push("--", ...input.args);
      await run(args, runOptions);
    },
    async prompt(input, runOptions = {}) {
      const args = ["agent", "prompt", input.target, input.text];
      if (input.wait === true) args.push("--wait");
      for (const until of input.until ?? []) args.push("--until", until);
      const output = await run(args, runOptions);
      return stateOf(output.json);
    },
    async wait(input, runOptions = {}) {
      const args = ["agent", "wait", input.target];
      for (const until of input.until ?? []) args.push("--until", until);
      const output = await run(args, runOptions);
      return stateOf(output.json);
    },
    async read(input, runOptions = {}) {
      const args = [
        "agent",
        "read",
        input.target,
        "--format",
        "text",
        "--source",
        input.source ?? "recent-unwrapped",
      ];
      if (input.lines !== undefined) args.push("--lines", String(input.lines));
      const output = await run(args, runOptions);
      return output.text;
    },
    async sendKeys(input, runOptions = {}) {
      await run(["agent", "send-keys", input.target, ...input.keys], runOptions);
    },
  };
};
