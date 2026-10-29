import { createHash } from "node:crypto";
import {
  EXECUTION_MESSAGE_BYTES,
  ExecutionAgentMessageSchema,
  type ExecutionHello,
  type ExecutionRequest,
  ExecutionViewerMessageSchema,
  executionTimeoutMs,
} from "../../../../packages/contracts/src/execution.ts";
import { payloadContainsCredential } from "./auth.ts";
import { scheduleEarlier } from "./realtime.ts";

type Attachment = {
  role: "agent" | "viewer";
  id: string;
  machineId: string;
  expires: number;
  seen: number;
  credentialId: string | null;
  ready: boolean;
  pending: Record<
    string,
    {
      hash: string;
      kind: ExecutionRequest["type"];
      deadline: number;
      agentId: string;
    }
  >;
};
type Observation = Omit<ExecutionHello, "type" | "protocolVersion"> & {
  observedAt: string;
};
const fingerprint = (id: string) =>
  createHash("sha256").update(id).digest("base64url").slice(0, 22);

/** Only public identity/capability observations and bounded routing metadata persist. */
export class ExecutionRelay {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
    private authorized: (id: string | null) => boolean,
  ) {}
  private sockets() {
    return this.ctx
      .getWebSockets("execution")
      .filter((socket) => socket.readyState === WebSocket.OPEN);
  }
  private meta(socket: WebSocket) {
    return socket.deserializeAttachment() as Attachment;
  }
  owns(socket: WebSocket) {
    return this.ctx.getTags(socket).includes("execution");
  }
  private agent() {
    return this.sockets().find(
      (socket) => this.meta(socket).role === "agent" && this.meta(socket).ready,
    );
  }
  private viewers() {
    return this.sockets().filter(
      (socket) => this.meta(socket).role === "viewer",
    );
  }
  private send(socket: WebSocket, value: unknown) {
    try {
      socket.send(JSON.stringify(value));
    } catch {
      socket.close(1011, "Connection failed");
    }
  }
  private prune() {
    for (const socket of this.sockets()) {
      const meta = this.meta(socket);
      if (meta.role === "agent" && !this.authorized(meta.credentialId))
        socket.close(4001, "Authorization revoked");
      else if (meta.expires <= Date.now())
        socket.close(4002, "Renew authorization");
      else if (Date.now() - meta.seen >= 35_000)
        socket.close(4000, "Heartbeat timeout");
      else if (
        Object.values(meta.pending).some(
          (pending) => pending.deadline <= Date.now(),
        )
      )
        socket.close(
          4004,
          "Request timed out; query original operation after reconnect",
        );
    }
  }
  status(machineId: string) {
    this.prune();
    const last = this.ctx.storage.kv.get<Observation>("execution-observation");
    return {
      machineId,
      online: !!this.agent(),
      observedAt: last?.observedAt ?? null,
      agentVersion: last?.agentVersion ?? null,
      capabilities: last?.capabilities ?? null,
    };
  }
  private broadcastStatus() {
    for (const viewer of this.viewers())
      this.send(viewer, {
        type: "status",
        ...this.status(this.meta(viewer).machineId),
      });
  }
  async schedule() {
    await scheduleEarlier(
      this.ctx,
      Math.min(
        ...this.sockets().map((socket) => {
          const meta = this.meta(socket);
          return Math.min(
            meta.expires,
            meta.seen + 35_000,
            ...Object.values(meta.pending).map((pending) => pending.deadline),
          );
        }),
      ),
    );
  }
  sweep() {
    this.prune();
    this.broadcastStatus();
  }
  connect(
    role: Attachment["role"],
    machineId: string,
    expires: number,
    credentialId: string | null,
  ) {
    this.prune();
    if (
      !Number.isFinite(expires) ||
      expires <= Date.now() ||
      expires > Date.now() + 15 * 60_000
    )
      return new Response(null, { status: 401 });
    if (role === "agent" && !this.authorized(credentialId))
      return new Response(null, { status: 401 });
    if (
      role === "agent" &&
      this.sockets().some((socket) => this.meta(socket).role === "agent")
    )
      return new Response(null, { status: 409 });
    if (role === "viewer" && this.viewers().length >= 12)
      return new Response(null, { status: 429 });
    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["execution"]);
    server.serializeAttachment({
      role,
      machineId,
      id: crypto.randomUUID(),
      expires,
      credentialId,
      ready: false,
      seen: Date.now(),
      pending: {},
    } satisfies Attachment);
    this.ctx.waitUntil(this.schedule());
    if (role === "viewer")
      this.send(server, { type: "status", ...this.status(machineId) });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  message(socket: WebSocket, message: string | ArrayBuffer) {
    this.prune();
    if (socket.readyState !== WebSocket.OPEN) return;
    const meta = this.meta(socket);
    if (
      typeof message !== "string" ||
      new TextEncoder().encode(message).length >
        (meta.role === "agent" ? EXECUTION_MESSAGE_BYTES : 16_384)
    ) {
      socket.close(1008, "Invalid message");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      socket.close(1008, "Invalid JSON");
      return;
    }
    if (payloadContainsCredential(value, this.env)) {
      socket.close(1008, "Invalid message");
      return;
    }
    meta.seen = Date.now();
    if (meta.role === "agent") {
      const parsed = ExecutionAgentMessageSchema.safeParse(value);
      if (!parsed.success) {
        socket.close(1008, "Invalid message");
        return;
      }
      const data = parsed.data;
      if (data.type === "hello") {
        if (data.machineId !== meta.machineId) {
          socket.close(1008, "Machine mismatch");
          return;
        }
        meta.ready = true;
        const { type: _type, protocolVersion: _version, ...observation } = data;
        this.ctx.storage.kv.put("execution-observation", {
          ...observation,
          observedAt: new Date().toISOString(),
        });
        socket.serializeAttachment(meta);
        this.broadcastStatus();
      } else if (data.type === "ping") this.send(socket, { type: "pong" });
      else {
        if (!meta.ready) {
          socket.close(1008, "Hello required");
          return;
        }
        const viewer = this.viewers().find(
          (other) => this.meta(other).id === data.clientId,
        );
        if (viewer) {
          const target = this.meta(viewer);
          const id =
            data.type === "result" ? data.operation.id : data.operationId;
          const pending = Object.hasOwn(target.pending, data.requestId)
            ? target.pending[data.requestId]
            : undefined;
          if (
            !pending ||
            pending.hash !== fingerprint(id) ||
            pending.agentId !== meta.id ||
            (data.type !== "error" &&
              (pending.kind === "cancel"
                ? data.type !== "cancel-ack"
                : data.type !== "result"))
          ) {
            socket.close(1008, "Reply identity mismatch");
            return;
          }
          delete target.pending[data.requestId];
          viewer.serializeAttachment(target);
          const { clientId: _client, ...reply } = data;
          this.send(viewer, reply);
        }
      }
    } else {
      const parsed = ExecutionViewerMessageSchema.safeParse(value);
      if (!parsed.success) {
        socket.close(1008, "Invalid message");
        return;
      }
      const data = parsed.data;
      if (data.type === "ping") this.send(socket, { type: "pong" });
      else {
        if (Object.hasOwn(meta.pending, data.requestId)) {
          socket.close(
            4004,
            "Duplicate request ID; query original operation after reconnect",
          );
          return;
        }
        const id = data.type === "run" ? data.operation.id : data.operationId;
        if (
          data.type === "run" &&
          data.operation.machineId !== meta.machineId
        ) {
          socket.close(1008, "Machine mismatch");
          return;
        }
        const agent = this.agent();
        if (!agent)
          this.send(socket, {
            type: "error",
            requestId: data.requestId,
            operationId: id,
            code: "offline",
          });
        else if (Object.keys(meta.pending).length >= 8)
          this.send(socket, {
            type: "error",
            requestId: data.requestId,
            operationId: id,
            code: "busy",
          });
        else {
          // Computed own properties are safe for __proto__ before/after hibernation.
          meta.pending = {
            ...meta.pending,
            [data.requestId]: {
              hash: fingerprint(id),
              kind: data.type,
              agentId: this.meta(agent).id,
              deadline:
                Date.now() +
                (data.type === "run"
                  ? executionTimeoutMs(data.operation) + 5000
                  : 5000),
            },
          };
          this.send(agent, { ...data, clientId: meta.id });
        }
      }
    }
    socket.serializeAttachment(meta);
    this.ctx.waitUntil(this.schedule());
  }
  close(socket: WebSocket) {
    const closed = this.meta(socket);
    if (closed.role === "agent") {
      for (const viewer of this.viewers()) {
        // Lost in-flight responses remain unknown to callers; force reconciliation.
        if (
          Object.values(this.meta(viewer).pending).some(
            (pending) => pending.agentId === closed.id,
          )
        )
          viewer.close(
            4000,
            "Agent disconnected; query original operations after reconnect",
          );
      }
    }
    this.broadcastStatus();
    this.ctx.waitUntil(this.schedule());
  }
  revoke() {
    for (const socket of this.sockets())
      socket.close(4001, "Authorization revoked");
  }
}
