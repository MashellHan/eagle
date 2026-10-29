import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  canonicalDeviceJSON,
  DeviceId,
  type DeviceObservation,
  DevicePolicy,
  deviceDigest,
  OperationRequest,
  OperationResult,
  verifyApproval,
} from "../../../../packages/contracts/src/devices.ts";
import { deviceJSON } from "./device-registry.ts";

const authFrame = z.strictObject({
  type: z.literal("authenticate"),
  sessionToken: z.string().max(200),
  capabilities: z.array(z.string().max(80)).max(32),
  policy: DevicePolicy,
});
const callerFrame = z.strictObject({
  type: z.literal("request"),
  sessionToken: z.string().max(200),
  request: OperationRequest,
});
const heartbeat = z.strictObject({
  type: z.literal("heartbeat"),
  capabilities: z.array(z.string().max(80)).max(32),
  policy: DevicePolicy,
});
const resultFrame = z.strictObject({
  type: z.literal("result"),
  requestId: DeviceId,
  operationId: DeviceId,
  targetDeviceId: DeviceId,
  result: OperationResult,
});
type Agent = {
  socket: WebSocket;
  token: string;
  deviceId: string;
  expires: number;
  credentialVersion: number;
};
type Pending = {
  socket: WebSocket;
  request: OperationRequest;
  token: string;
  timer: ReturnType<typeof setTimeout>;
};
export class DeviceExecution extends DurableObject<Env> {
  private agent?: Agent;
  private pending = new Map<string, Pending>();
  private lease?: ReturnType<typeof setTimeout>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }
  observation(): DeviceObservation {
    const previous = this.ctx.storage.kv.get<DeviceObservation>("observation");
    return previous
      ? { ...previous, online: !!this.agent && this.agent.expires > Date.now() }
      : { online: null, lastSeenAt: null, capabilities: null, policy: null };
  }
  private observe(capabilities: string[], policy: DevicePolicy): void {
    const value: DeviceObservation = {
      online: true,
      lastSeenAt: Date.now(),
      capabilities,
      policy,
    };
    this.ctx.storage.kv.put("observation", value);
    if (this.agent) this.agent.expires = Date.now() + 30000;
    clearTimeout(this.lease);
    this.lease = setTimeout(() => {
      this.agent?.socket.close(1008, "lease_expired");
      this.agent = undefined;
      this.failPending("target_offline");
    }, 30000);
  }
  private send(socket: WebSocket, value: unknown): void {
    try {
      socket.send(JSON.stringify(value));
    } catch {
      /* Disconnection does not certify execution outcome. */
    }
  }
  private respond(
    socket: WebSocket,
    request: OperationRequest,
    result: OperationResult,
  ): void {
    this.send(socket, {
      type: "response",
      requestId: request.requestId,
      operationId: request.operationId,
      targetDeviceId: request.targetDeviceId,
      result,
    });
    try {
      socket.close(1000, "response");
    } catch {}
  }
  private failPending(error: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.respond(pending.socket, pending.request, {
        status: "unknown",
        error,
      });
    }
    this.pending.clear();
  }
  async fetch(request: Request): Promise<Response> {
    const match = new URL(request.url).pathname.match(
      /\/execution\/([^/]+)\/(agent|request)$/,
    );
    if (
      !match ||
      !DeviceId.safeParse(match[1]).success ||
      request.method !== "GET"
    )
      return deviceJSON({ error: "not_found" }, 404);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return deviceJSON({ error: "websocket_required" }, 426);
    const targetId = match[1];
    const role = match[2];
    const pair = new WebSocketPair();
    const client = pair[0];
    const socket = pair[1];
    socket.accept();
    let authenticated = false;
    let handled = false;
    let chain = Promise.resolve();
    const timeout = setTimeout(
      () => socket.close(1008, "authentication_timeout"),
      5000,
    );
    socket.addEventListener("message", (event) => {
      chain = chain
        .then(async () => {
          if (
            typeof event.data !== "string" ||
            new TextEncoder().encode(event.data).length > 524288
          )
            throw new Error("frame_limit");
          const data: unknown = JSON.parse(event.data);
          if (role === "agent") {
            if (!authenticated) {
              const auth = authFrame.parse(data);
              const checked = await this.env.DEVICE_REGISTRY.getByName(
                "registry",
              ).check(auth.sessionToken, targetId);
              if (!checked.ok || checked.source.deviceId !== targetId)
                throw new Error("unauthorized_agent");
              if (this.agent) {
                this.agent.socket.close(1008, "agent_replaced");
                this.failPending("agent_replaced");
              }
              this.agent = {
                socket,
                token: auth.sessionToken,
                deviceId: targetId,
                expires: Date.now() + 30000,
                credentialVersion: checked.source.credentialVersion,
              };
              authenticated = true;
              clearTimeout(timeout);
              this.observe(auth.capabilities, auth.policy);
              this.send(socket, { type: "ready" });
              return;
            }
            if (this.agent?.socket !== socket)
              throw new Error("agent_replaced");
            const checked = await this.env.DEVICE_REGISTRY.getByName(
              "registry",
            ).check(this.agent.token, targetId);
            if (!checked.ok) throw new Error("revoked_agent");
            const beat = heartbeat.safeParse(data);
            if (beat.success) {
              this.observe(beat.data.capabilities, beat.data.policy);
              return;
            }
            const message = resultFrame.parse(data);
            const pending = this.pending.get(message.requestId);
            if (
              !pending ||
              pending.request.operationId !== message.operationId ||
              message.targetDeviceId !== targetId
            )
              return;
            const fresh = await this.env.DEVICE_REGISTRY.getByName(
              "registry",
            ).check(pending.token, targetId);
            clearTimeout(pending.timer);
            this.pending.delete(message.requestId);
            this.respond(
              pending.socket,
              pending.request,
              fresh.ok
                ? message.result
                : { status: "denied", error: "membership_changed" },
            );
            return;
          }
          if (handled) throw new Error("one_request_per_socket");
          handled = true;
          clearTimeout(timeout);
          const caller = callerFrame.parse(data);
          const operation = caller.request;
          if (operation.targetDeviceId !== targetId) {
            this.respond(socket, operation, {
              status: "denied",
              error: "wrong_target",
            });
            return;
          }
          const checked = await this.env.DEVICE_REGISTRY.getByName(
            "registry",
          ).check(caller.sessionToken, targetId);
          if (!checked.ok) {
            this.respond(socket, operation, {
              status: "denied",
              error: checked.error,
            });
            return;
          }
          if (!this.agent || this.agent.expires <= Date.now()) {
            this.respond(socket, operation, {
              status: "unknown",
              error: "target_offline",
            });
            return;
          }
          const target = await this.env.DEVICE_REGISTRY.getByName(
            "registry",
          ).check(this.agent.token, targetId);
          if (!target.ok) {
            this.agent.socket.close(1008, "revoked_agent");
            this.agent = undefined;
            this.respond(socket, operation, {
              status: "denied",
              error: "revoked_agent",
            });
            return;
          }
          const policy = this.observation().policy;
          if (operation.action === "run") {
            if (
              operation.operation?.kind === "native" ||
              (await deviceDigest(canonicalDeviceJSON(operation.operation))) !==
                operation.digest
            ) {
              this.respond(socket, operation, {
                status: "denied",
                error: "invalid_operation",
              });
              return;
            }
            if (
              !policy ||
              policy.mode === "paused" ||
              (policy.mode === "always-ask" &&
                !(await verifyApproval(
                  operation.approval,
                  operation,
                  checked.source,
                  policy,
                )))
            ) {
              this.respond(socket, operation, {
                status: "denied",
                error: "policy_confirmation_required",
              });
              return;
            }
          }
          // All digest/signature awaits precede the final authority read.
          // Revocation before forwarding must prevent target side effects.
          const agent = this.agent;
          const final = await this.env.DEVICE_REGISTRY.getByName(
            "registry",
          ).check(caller.sessionToken, targetId);
          if (
            !final.ok ||
            !agent ||
            this.agent !== agent ||
            agent.expires <= Date.now() ||
            final.target.credentialVersion !== agent.credentialVersion
          ) {
            this.respond(socket, operation, {
              status: "denied",
              error: "membership_or_agent_changed",
            });
            return;
          }
          if (
            operation.action === "run" &&
            (!policy ||
              this.observation().policy?.version !== policy.version ||
              (policy.mode === "always-ask" &&
                (!operation.approval ||
                  operation.approval.expiresAt <= Date.now())))
          ) {
            this.respond(socket, operation, {
              status: "denied",
              error: "policy_or_approval_changed",
            });
            return;
          }
          if (
            this.pending.size >= 64 ||
            this.pending.has(operation.requestId)
          ) {
            this.respond(socket, operation, {
              status: "busy",
              error: "relay_busy",
            });
            return;
          }
          const timer = setTimeout(
            () => {
              const pending = this.pending.get(operation.requestId);
              if (pending) {
                this.pending.delete(operation.requestId);
                this.respond(socket, operation, {
                  status: "unknown",
                  error: "response_timeout_query_original_id",
                });
              }
            },
            operation.operation?.kind === "command"
              ? (operation.operation.timeoutMs ?? 30000) + 5000
              : 35000,
          );
          this.pending.set(operation.requestId, {
            socket,
            request: operation,
            token: caller.sessionToken,
            timer,
          });
          this.send(agent.socket, {
            type: "operation",
            sourceDeviceId: final.source.deviceId,
            sourcePublicKey: final.source.publicKey,
            request: operation,
          });
        })
        .catch(() => {
          try {
            socket.close(1008, "invalid_or_unauthorized_frame");
          } catch {}
        });
      this.ctx.waitUntil(chain);
    });
    const closed = () => {
      clearTimeout(timeout);
      if (this.agent?.socket === socket) {
        this.agent = undefined;
        clearTimeout(this.lease);
        this.failPending("target_disconnected_query_original_id");
      }
      for (const [id, pending] of this.pending)
        if (pending.socket === socket) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
        }
    };
    socket.addEventListener("close", closed);
    socket.addEventListener("error", closed);
    return new Response(null, { status: 101, webSocket: client });
  }
}
