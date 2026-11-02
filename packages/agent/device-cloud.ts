import WebSocket from "ws";
import { z } from "zod";
import {
  HISTORY_FRAME_BYTES,
  HISTORY_QUEUE_FRAMES,
  HistoryAgentFrame,
  HistoryServerFrame,
  isHistoryFrame,
} from "../contracts/src/device-history.ts";
import {
  DEVICE_PREFIX,
  type Device,
  type DeviceDirectory,
  DevicePolicy,
  OperationRequest,
  OperationResult,
  PolicyResultFrame,
  PolicySetFrame,
  PolicySetRequest,
} from "../contracts/src/devices.ts";
import type { DeviceRuntime } from "./device-runtime.ts";

const operationFrame = z.strictObject({
  type: z.literal("operation"),
  sourceDeviceId: z.uuid(),
  sourcePublicKey: z.string().max(2048),
  request: OperationRequest,
});
const responseFrame = z.strictObject({
  type: z.literal("response"),
  requestId: z.uuid(),
  operationId: z.uuid(),
  targetDeviceId: z.uuid(),
  result: OperationResult,
});
const capabilities = [
  "command",
  "file.read",
  "file.write",
  "file.list",
  "policy.manage",
];
type HistoryCloudEvent =
  | HistoryServerFrame
  | { type: "history.online" }
  | { type: "history.offline" };
export class DeviceCloud {
  readonly device: Device;
  private baseUrl: string;
  private token = "";
  private expires = 0;
  private session?: Promise<string>;
  private agent?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private connecting?: Promise<void>;
  private retryDelay = 1000;
  private shutdown = new AbortController();
  private stopped = false;
  private callers = new Set<WebSocket>();
  private historyListeners = new Set<(event: HistoryCloudEvent) => void>();
  private historyPending = new Map<
    string,
    {
      resolve: (value: HistoryServerFrame) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  status: "online" | "offline" = "offline";
  constructor(
    baseUrl: string,
    device: Device,
    privateRuntime: DeviceRuntime,
    signer: (payload: string) => Promise<string>,
    onStatus?: (status: "online" | "offline") => void,
  ) {
    this.device = device;
    const url = new URL(baseUrl);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      throw new Error("HTTPS device service required");
    this.baseUrl = url.origin;
    this.runtime = privateRuntime;
    this.signer = signer;
    this.onStatus = onStatus;
  }
  private runtime: DeviceRuntime;
  private signer: (payload: string) => Promise<string>;
  private onStatus?: (status: "online" | "offline") => void;
  get origin(): string {
    return this.baseUrl;
  }
  secrets(): string[] {
    return this.token ? [this.token] : [];
  }
  private state(status: "online" | "offline"): void {
    this.status = status;
    this.onStatus?.(status);
    if (status === "offline") {
      for (const pending of this.historyPending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("history_offline"));
      }
      this.historyPending.clear();
    }
    this.publishHistory({
      type: status === "online" ? "history.online" : "history.offline",
    });
  }
  observeHistory(listener: (event: HistoryCloudEvent) => void): () => void {
    this.historyListeners.add(listener);
    return () => {
      this.historyListeners.delete(listener);
    };
  }
  private publishHistory(event: HistoryCloudEvent): void {
    for (const listener of this.historyListeners) {
      try {
        listener(event);
      } catch {
        /* Optional history consumers cannot affect commands. */
      }
    }
  }
  async historyRequest(input: HistoryAgentFrame): Promise<HistoryServerFrame> {
    const frame = HistoryAgentFrame.parse(input);
    const socket = this.agent;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      this.status !== "online"
    )
      throw new Error("history_offline");
    const body = JSON.stringify(frame);
    if (Buffer.byteLength(body) > HISTORY_FRAME_BYTES)
      throw new Error("history_frame_limit");
    if (
      this.historyPending.size >= HISTORY_QUEUE_FRAMES ||
      this.historyPending.has(frame.requestId) ||
      socket.bufferedAmount > HISTORY_FRAME_BYTES * HISTORY_QUEUE_FRAMES
    )
      throw new Error("history_busy");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.historyPending.delete(frame.requestId);
        reject(new Error("history_response_timeout"));
      }, 5000);
      this.historyPending.set(frame.requestId, { resolve, reject, timer });
      socket.send(body, (error) => {
        if (!error) return;
        const pending = this.historyPending.get(frame.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.historyPending.delete(frame.requestId);
          pending.reject(new Error("history_offline"));
        }
      });
    });
  }
  private closedSession(
    token: string,
    closeCode: number,
    reason: Buffer,
  ): void {
    if (
      closeCode === 1008 &&
      this.token === token &&
      ["unauthorized_agent", "revoked_agent", "unauthorized_caller"].includes(
        reason.toString("utf8"),
      )
    )
      this.expires = 0;
  }
  private async http(
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}${DEVICE_PREFIX}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([
        AbortSignal.timeout(10000),
        this.shutdown.signal,
      ]),
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      if (response.status === 401) this.expires = 0;
      throw new Error(
        typeof result.error === "string"
          ? result.error
          : "device_service_failed",
      );
    }
    return result;
  }
  private async authenticate(): Promise<string> {
    if (this.token && this.expires > Date.now() + 30000) return this.token;
    if (this.session) return this.session;
    this.session = (async () => {
      const { deviceId, publicKey, name, platform, arch } = this.device;
      const registration = await this.http("/register/challenge", {
        deviceId,
        publicKey,
        name,
        platform,
        arch,
      });
      const challenge = z
        .strictObject({
          challengeId: z.uuid(),
          payload: z.string().max(4096),
          expiresAt: z.number(),
        })
        .parse(registration);
      const lines = challenge.payload.split("\n");
      if (
        lines.length !== 7 ||
        lines[0] !== "eagle-device-register-v1" ||
        lines[1] !== this.baseUrl ||
        lines[2] !== deviceId ||
        lines[3] !== publicKey ||
        lines[4] !== challenge.challengeId ||
        Number(lines[6]) !== challenge.expiresAt ||
        challenge.expiresAt <= Date.now() ||
        challenge.expiresAt > Date.now() + 60000
      )
        throw new Error("unbound_challenge");
      const signature = await this.signer(challenge.payload);
      const complete = await this.http("/register/complete", {
        challengeId: challenge.challengeId,
        signature,
      });
      const session = z
        .object({ sessionToken: z.string().max(200), expiresAt: z.number() })
        .parse(complete);
      this.token = session.sessionToken;
      this.expires = session.expiresAt;
      return this.token;
    })();
    try {
      return await this.session;
    } finally {
      this.session = undefined;
    }
  }
  async directory(): Promise<DeviceDirectory> {
    return (await this.http(
      "/directory",
      undefined,
      await this.authenticate(),
    )) as unknown as DeviceDirectory;
  }
  async manage(path: string, body?: unknown): Promise<unknown> {
    return this.http(path, body, await this.authenticate());
  }
  async setPolicy(request: PolicySetRequest): Promise<DevicePolicy> {
    if (this.stopped) throw new Error("device_cloud_stopped");
    try {
      return DevicePolicy.parse(
        await this.manage("/policy", PolicySetRequest.parse(request)),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        /^[a-z][a-z0-9_]{0,80}$/.test(error.message)
      )
        throw error;
      throw new Error("policy_result_unknown_refresh_target");
    }
  }
  private wsUrl(target: string, role: "agent" | "request"): string {
    const url = new URL(
      `${this.baseUrl}${DEVICE_PREFIX}/execution/${target}/${role}`,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
  async start(): Promise<void> {
    if (this.agent?.readyState === WebSocket.OPEN && this.status === "online")
      return;
    if (this.connecting) return this.connecting;
    const connecting = this.connect().catch((error) => {
      this.state("offline");
      this.scheduleReconnect();
      throw error;
    });
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = undefined;
    }
  }
  private async connect(): Promise<void> {
    if (this.stopped) throw new Error("device_cloud_stopped");
    const token = await this.authenticate();
    if (this.stopped) throw new Error("device_cloud_stopped");
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl(this.device.deviceId, "agent"), {
        maxPayload: 524288,
      });
      this.agent = socket;
      let ready = false;
      const deadline = setTimeout(() => {
        socket.terminate();
        reject(new Error("agent_connection_timeout"));
      }, 10000);
      socket.on("open", () =>
        socket.send(
          JSON.stringify({
            type: "authenticate",
            sessionToken: token,
            capabilities,
            policy: this.runtime.policy,
          }),
        ),
      );
      socket.on("message", (data) => {
        void (async () => {
          const frame: unknown = JSON.parse(data.toString());
          if (!ready) {
            if (
              !(
                frame &&
                typeof frame === "object" &&
                "type" in frame &&
                frame.type === "ready"
              )
            )
              throw new Error("agent_authentication_failed");
            ready = true;
            clearTimeout(deadline);
            this.state("online");
            this.retryDelay = 1000;
            this.heartbeat = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN)
                socket.send(
                  JSON.stringify({
                    type: "heartbeat",
                    capabilities,
                    policy: this.runtime.policy,
                  }),
                );
            }, 10000);
            resolve();
            return;
          }
          if (isHistoryFrame(frame)) {
            if (this.agent !== socket || this.stopped) return;
            if (Buffer.byteLength(data.toString()) > HISTORY_FRAME_BYTES)
              return;
            const parsed = HistoryServerFrame.safeParse(frame);
            if (!parsed.success) return;
            const message = parsed.data;
            if ("requestId" in message) {
              const pending = this.historyPending.get(message.requestId);
              if (pending) {
                clearTimeout(pending.timer);
                this.historyPending.delete(message.requestId);
                if (message.type === "history.error")
                  pending.reject(new Error(message.error));
                else pending.resolve(message);
              }
            } else this.publishHistory(message);
            return;
          }
          const policy = PolicySetFrame.safeParse(frame);
          if (policy.success) {
            if (
              this.stopped ||
              this.agent !== socket ||
              socket.readyState !== WebSocket.OPEN
            )
              return;
            const message = policy.data;
            let reply: { policy: DevicePolicy } | { error: string };
            try {
              reply = {
                policy: this.runtime.applyPolicy(
                  message.request,
                  message.sourceDeviceId,
                ),
              };
            } catch (error) {
              reply = {
                error:
                  error instanceof Error &&
                  /^[a-z][a-z0-9_]{0,80}$/.test(error.message)
                    ? error.message
                    : "policy_result_unknown_refresh_target",
              };
            }
            this.publishPolicy();
            socket.send(
              JSON.stringify(
                PolicyResultFrame.parse({
                  type: "policy.result",
                  relayId: message.relayId,
                  requestId: message.request.requestId,
                  deviceId: this.device.deviceId,
                  ...reply,
                }),
              ),
            );
            return;
          }
          const operation = operationFrame.parse(frame);
          const source = {
            ...this.device,
            deviceId: operation.sourceDeviceId,
            publicKey: operation.sourcePublicKey,
          };
          const result = await this.runtime.handle(operation.request, source);
          if (socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                type: "result",
                requestId: operation.request.requestId,
                operationId: operation.request.operationId,
                targetDeviceId: this.device.deviceId,
                result,
              }),
            );
        })().catch(() => socket.close(1008, "invalid_agent_frame"));
      });
      const ended = (closeCode: number, reason: Buffer) => {
        this.closedSession(token, closeCode, reason);
        clearTimeout(deadline);
        clearInterval(this.heartbeat);
        if (this.agent === socket) {
          this.agent = undefined;
          this.state("offline");
          this.scheduleReconnect();
        }
        if (!ready) reject(new Error("agent_connection_failed"));
      };
      socket.once("close", ended);
      socket.on("error", () => {
        socket.terminate();
      });
    });
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(30000, this.retryDelay * 2);
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.start().catch(() => this.scheduleReconnect());
    }, delay);
  }
  async execute(input: OperationRequest): Promise<OperationResult> {
    const request = OperationRequest.parse(input);
    if (this.stopped)
      return { status: "unknown", error: "device_cloud_stopped" };
    let token: string;
    try {
      token = await this.authenticate();
    } catch {
      return {
        status: "unknown",
        error: "cloud_unavailable_query_original_id",
      };
    }
    if (this.stopped)
      return { status: "unknown", error: "device_cloud_stopped" };
    return new Promise((resolve) => {
      const socket = new WebSocket(
        this.wsUrl(request.targetDeviceId, "request"),
        { maxPayload: 524288 },
      );
      this.callers.add(socket);
      let settled = false;
      const finish = (result: OperationResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.callers.delete(socket);
        socket.close();
        resolve(result);
      };
      const timer = setTimeout(
        () => {
          finish({
            status: "unknown",
            error: "connection_timeout_query_original_id",
          });
          socket.terminate();
        },
        request.operation?.kind === "command"
          ? (request.operation.timeoutMs ?? 30000) + 10000
          : 40000,
      );
      socket.once("open", () =>
        socket.send(
          JSON.stringify({ type: "request", sessionToken: token, request }),
        ),
      );
      socket.on("message", (data) => {
        try {
          const frame = responseFrame.parse(JSON.parse(data.toString()));
          if (
            frame.requestId !== request.requestId ||
            frame.operationId !== request.operationId ||
            frame.targetDeviceId !== request.targetDeviceId
          )
            throw new Error("response_mismatch");
          finish(frame.result);
        } catch {
          finish({
            status: "unknown",
            error: "invalid_response_query_original_id",
          });
        }
      });
      socket.once("close", (closeCode, reason) => {
        this.closedSession(token, closeCode, reason);
        finish({
          status: "unknown",
          error: "connection_lost_query_original_id",
        });
      });
      socket.on("error", () => {
        finish({
          status: "unknown",
          error: "connection_failed_query_original_id",
        });
        socket.terminate();
      });
    });
  }
  publishPolicy(): void {
    if (this.agent?.readyState === WebSocket.OPEN)
      this.agent.send(
        JSON.stringify({
          type: "heartbeat",
          capabilities,
          policy: this.runtime.policy,
        }),
      );
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.shutdown.abort();
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.agent?.terminate();
    for (const caller of this.callers) caller.terminate();
    this.state("offline");
  }
}
