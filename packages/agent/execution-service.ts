import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import {
  EXECUTION_MESSAGE_BYTES,
  ExecutionBridgeMessageSchema,
  ExecutionHelloSchema,
  type ExecutionResponse,
  ExecutionResponseSchema,
} from "../contracts/src/execution.ts";
import { type AgentConfig, checkUrl, redact } from "./collector.ts";
import { CommandRunner } from "./command-runner.ts";
import { FileProvider, type FileProviderSettings } from "./file-provider.ts";
import { HerdrProvider, type HerdrProviderSettings } from "./herdr-provider.ts";
import {
  OperationAdmissionError,
  OperationJournal,
} from "./operation-journal.ts";
import { AGENT_VERSION } from "./version.ts";

export type ExecutionServiceOptions = {
  journalPath: string;
  commands: boolean;
  workingDirectory: string;
  files?: FileProviderSettings;
  herdr?: HerdrProviderSettings;
};

function containsSecret(value: unknown, secrets: string[]): boolean {
  if (typeof value === "string") return redact(value, secrets) !== value;
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([key, child]) =>
        containsSecret(key, secrets) || containsSecret(child, secrets),
    );
  return false;
}

/** One durable owner for the entire reconnecting service lifetime, independent of Herdr. */
export async function executionWatch(
  config: AgentConfig,
  options: ExecutionServiceOptions,
  signal: AbortSignal,
) {
  const url = new URL("/api/v1/execution-agent", checkUrl(config.url));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const journal = new OperationJournal(options.journalPath);
  try {
    const secrets = [
      config.token,
      ...(options.files?.secrets ?? []),
      ...(options.herdr?.secrets ?? []),
    ];
    const files = options.files
      ? new FileProvider({ ...options.files, secrets })
      : undefined;
    const herdr = options.herdr
      ? new HerdrProvider({ ...options.herdr, secrets })
      : undefined;
    const runner = new CommandRunner(journal, {
      machineId: config.machineId,
      enabled: options.commands,
      workingDirectory: options.workingDirectory,
      secrets,
      files,
      herdr,
    });
    const instanceId = randomUUID();
    let retry = 1000;
    const probeStop = new AbortController();
    let probe: Promise<void> | undefined;
    const refreshHerdr = () => {
      if (!herdr || probe || signal.aborted || probeStop.signal.aborted) return;
      probe = herdr
        .probe(
          AbortSignal.any([
            signal,
            probeStop.signal,
            AbortSignal.timeout(15_000),
          ]),
        )
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          probe = undefined;
        });
    };
    refreshHerdr();
    const probeTimer = setInterval(refreshHerdr, 30_000);
    try {
      while (!signal.aborted) {
        let rejected = false;
        await new Promise<void>((resolve) => {
          const socket = new WebSocket(url, {
            headers: {
              Authorization: `Bearer ${config.token}`,
              "X-Eagle-Machine": config.machineId,
            },
            followRedirects: false,
            handshakeTimeout: 10_000,
            maxPayload: EXECUTION_MESSAGE_BYTES,
          });
          let seen = Date.now();
          let lastCapabilities = "";
          const announce = (force = false) => {
            if (socket.readyState !== WebSocket.OPEN) return;
            const capabilities = {
              commands: options.commands,
              ...(files ? { files: files.capabilities() } : {}),
              ...(herdr ? { herdr: herdr.capabilities() } : {}),
            };
            const current = JSON.stringify(capabilities);
            if (!force && current === lastCapabilities) return;
            const hello = ExecutionHelloSchema.safeParse({
              type: "hello",
              protocolVersion: 1,
              machineId: config.machineId,
              instanceId,
              agentVersion: AGENT_VERSION,
              capabilities,
            });
            if (!hello.success || containsSecret(hello.data, secrets)) {
              rejected = true;
              socket.close(1008, "Invalid capabilities");
              return;
            }
            lastCapabilities = current;
            socket.send(JSON.stringify(hello.data));
          };
          const capabilityPoll = setInterval(announce, 5000);
          const send = (value: ExecutionResponse) => {
            const parsed = ExecutionResponseSchema.safeParse(value);
            if (!parsed.success || containsSecret(value, secrets)) {
              socket.close(1008, "Invalid result");
              return;
            }
            if (socket.readyState !== WebSocket.OPEN) return;
            if (socket.bufferedAmount > EXECUTION_MESSAGE_BYTES) {
              socket.terminate();
              return;
            }
            socket.send(JSON.stringify(parsed.data));
          };
          const heartbeat = setInterval(() => {
            if (Date.now() - seen > 30_000) socket.terminate();
            else if (socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ type: "ping" }));
          }, 10_000);
          const stop = () => socket.terminate();
          signal.addEventListener("abort", stop, { once: true });
          socket.on("open", () => {
            if (signal.aborted) {
              stop();
              return;
            }
            retry = 1000;
            announce(true);
            socket.send(JSON.stringify({ type: "ping" }));
            console.log(JSON.stringify({ event: "execution_connected" }));
          });
          socket.on("message", (bytes) => {
            let value: unknown;
            try {
              value = JSON.parse(String(bytes));
            } catch {
              rejected = true;
              socket.close(1008, "Invalid JSON");
              return;
            }
            const parsed = ExecutionBridgeMessageSchema.safeParse(value);
            if (!parsed.success || containsSecret(value, secrets)) {
              rejected = true;
              socket.close(1008, "Invalid message");
              return;
            }
            seen = Date.now();
            const message = parsed.data;
            if (message.type === "pong") return;
            const id =
              message.type === "run"
                ? message.operation.id
                : message.operationId;
            const context = {
              clientId: message.clientId,
              requestId: message.requestId,
            };
            void (async () => {
              try {
                if (message.type === "run") {
                  if (message.operation.tool === "command.exec") {
                    const { tool: _tool, ...request } = message.operation;
                    await runner.run(request);
                  } else if (
                    message.operation.tool === "file.read" ||
                    message.operation.tool === "file.list"
                  ) {
                    await runner.runFile(message.operation);
                  } else if (
                    message.operation.tool === "herdr.setup" ||
                    message.operation.tool === "herdr.inspect"
                  ) {
                    await runner.runHerdr(message.operation);
                  } else throw new Error("Invalid execution tool");
                  const operation = runner.getVisible(id);
                  if (!operation)
                    throw new Error("Operation storage unavailable");
                  announce();
                  send({ type: "result", ...context, operation });
                } else if (message.type === "cancel") {
                  send({
                    type: "cancel-ack",
                    ...context,
                    operationId: id,
                    requested: runner.cancel(id),
                  });
                } else {
                  const operation = runner.getVisible(id);
                  if (operation)
                    send({ type: "result", ...context, operation });
                  else
                    send({
                      type: "error",
                      ...context,
                      operationId: id,
                      code: "not_found",
                    });
                }
              } catch (error) {
                const text = error instanceof Error ? error.message : "";
                const code =
                  error instanceof OperationAdmissionError &&
                  /conflict/i.test(text)
                    ? "conflict"
                    : /disabled/i.test(text)
                      ? "disabled"
                      : /grant|revoked|authorized|private/i.test(text)
                        ? "denied"
                        : /busy|capacity/i.test(text)
                          ? "busy"
                          : /storage|unavailable/i.test(text)
                            ? "unavailable"
                            : "invalid";
                send({ type: "error", ...context, operationId: id, code });
              }
            })();
          });
          socket.on("unexpected-response", (_request, response) => {
            // The preceding socket may still own the cloud lease after network loss.
            // A temporary 409 retries with the same journal and running processes.
            rejected = [401, 403].includes(response.statusCode ?? 0);
            response.destroy();
            socket.terminate();
          });
          socket.on("error", () => {});
          socket.on("close", (code) => {
            rejected ||= code === 4001 || code === 1008;
            clearInterval(heartbeat);
            clearInterval(capabilityPoll);
            signal.removeEventListener("abort", stop);
            resolve();
          });
          if (signal.aborted) stop();
        });
        if (rejected && !signal.aborted)
          throw new Error(
            "Execution authorization or protocol rejected; check secure configuration",
          );
        if (!signal.aborted) {
          await delay(retry, undefined, { signal }).catch(() => {});
          retry = Math.min(retry * 2, 30_000);
        }
      }
    } finally {
      clearInterval(probeTimer);
      probeStop.abort();
      await probe;
      await runner.close();
    }
  } finally {
    journal.close();
  }
}
