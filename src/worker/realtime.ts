import {
  AgentMessageSchema,
  type Subscription,
  ViewerMessageSchema,
} from "../shared/realtime.ts";
import { containsCredential } from "./auth.ts";

type Attachment = {
  role: "agent" | "viewer";
  id: string;
  expires: number;
  seen: number;
  credentialId: string | null;
  spaceId?: string;
  subscriptionId?: string;
  control?: boolean;
  seq?: number;
  pending?: number;
  panes?: Record<string, string>;
};
// Attachments contain routing/leases only. Terminal text and inputs are never persisted.
export class LiveRelay {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
    private authorized: (id: string | null) => boolean,
  ) {}
  private sockets() {
    return this.ctx
      .getWebSockets("live")
      .filter((s) => s.readyState === WebSocket.OPEN);
  }
  private meta(s: WebSocket) {
    return s.deserializeAttachment() as Attachment;
  }
  private send(s: WebSocket, value: unknown) {
    try {
      s.send(JSON.stringify(value));
    } catch {
      s.close(1011, "Connection failed");
    }
  }
  private agent() {
    return this.sockets().find((s) => this.meta(s).role === "agent");
  }
  private viewers(spaceId?: string) {
    return this.sockets().filter((s) => {
      const a = this.meta(s);
      return a.role === "viewer" && (!spaceId || a.spaceId === spaceId);
    });
  }
  private status() {
    for (const s of this.viewers())
      this.send(s, {
        type: "status",
        online: !!this.agent(),
        control: !!this.meta(s).control,
      });
  }
  private subscriptions() {
    const spaces = new Map<string, Subscription>();
    for (const s of this.viewers()) {
      const a = this.meta(s);
      if (a.spaceId && a.subscriptionId)
        spaces.set(a.spaceId, {
          spaceId: a.spaceId,
          subscriptionId: a.subscriptionId,
        });
    }
    const agent = this.agent();
    if (agent)
      this.send(agent, { type: "subscriptions", spaces: [...spaces.values()] });
  }
  private prune() {
    for (const s of this.sockets()) {
      const a = this.meta(s);
      if (
        a.expires <= Date.now() ||
        Date.now() - a.seen > 35000 ||
        (a.role === "agent" && !this.authorized(a.credentialId))
      )
        s.close(4001, "Lease expired");
    }
  }
  connect(
    role: "agent" | "viewer",
    expires: number,
    credentialId: string | null,
    spaceId?: string,
  ) {
    this.prune();
    if (role === "agent" && !this.authorized(credentialId))
      return new Response(null, { status: 401 });
    if (role === "agent" && this.agent())
      return new Response(null, { status: 409 });
    const viewers = this.viewers();
    if (
      role === "viewer" &&
      (viewers.length >= 12 ||
        (!viewers.some((s) => this.meta(s).spaceId === spaceId) &&
          new Set(viewers.map((s) => this.meta(s).spaceId)).size >= 4))
    )
      return new Response(null, { status: 429 });
    const pair = new WebSocketPair();
    const server = pair[1];
    const existing = this.viewers(spaceId)[0];
    const attachment: Attachment = {
      role,
      id: crypto.randomUUID(),
      expires,
      seen: Date.now(),
      credentialId,
      ...(role === "viewer"
        ? {
            spaceId,
            subscriptionId: existing
              ? this.meta(existing).subscriptionId
              : crypto.randomUUID(),
            seq: 0,
            panes: {},
          }
        : {}),
    };
    this.ctx.acceptWebSocket(server, ["live"]);
    server.serializeAttachment(attachment);
    this.subscriptions();
    this.status();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  message(socket: WebSocket, message: string | ArrayBuffer) {
    this.prune();
    if (socket.readyState !== WebSocket.OPEN) {
      this.subscriptions();
      this.status();
      return;
    }
    const a = this.meta(socket);
    if (
      typeof message !== "string" ||
      message.length > 262144 ||
      containsCredential(message, this.env)
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
    const parsed = (
      a.role === "agent" ? AgentMessageSchema : ViewerMessageSchema
    ).safeParse(value);
    if (!parsed.success) {
      socket.close(1008, "Invalid message");
      return;
    }
    a.seen = Date.now();
    socket.serializeAttachment(a);
    const data = parsed.data;
    if (data.type === "ping") {
      this.send(socket, { type: "pong" });
      this.subscriptions();
      this.status();
      return;
    }
    if (a.role === "agent") {
      if (data.type === "ack") {
        const viewer = this.viewers().find(
          (s) => this.meta(s).id === data.clientId,
        );
        if (viewer) {
          const v = this.meta(viewer);
          if (v.pending === data.seq) {
            delete v.pending;
            viewer.serializeAttachment(v);
            this.send(viewer, {
              type: "ack",
              seq: data.seq,
              status: data.status,
            });
          }
        }
      } else if ("spaceId" in data) {
        for (const viewer of this.viewers(data.spaceId)) {
          const v = this.meta(viewer);
          if (v.subscriptionId !== data.subscriptionId) continue;
          if (data.type === "unavailable") {
            viewer.close(4004, "Space unavailable");
            continue;
          }
          if (data.type === "topology") {
            v.panes = Object.fromEntries(
              data.tabs.flatMap((t) =>
                t.panes.map((p) => [p.id, p.terminalId]),
              ),
            );
            viewer.serializeAttachment(v);
          }
          if (
            data.type !== "frame" ||
            v.panes?.[data.paneId] === data.terminalId
          )
            this.send(viewer, data);
        }
      }
      return;
    }
    if (data.type === "control" || data.type === "release") {
      a.control =
        data.type === "control" &&
        !!this.agent() &&
        !this.viewers(a.spaceId).some(
          (s) => s !== socket && this.meta(s).control,
        );
      socket.serializeAttachment(a);
      this.status();
      return;
    }
    if (data.type === "input") {
      const agent = this.agent();
      if (
        !agent ||
        !a.control ||
        a.pending ||
        data.seq <= (a.seq ?? 0) ||
        a.panes?.[data.paneId] !== data.terminalId
      ) {
        this.send(socket, { type: "ack", seq: data.seq, status: "rejected" });
        return;
      }
      a.seq = data.seq;
      a.pending = data.seq;
      socket.serializeAttachment(a); // Record the sequence before forwarding; never replay uncertain input.
      this.send(agent, {
        ...data,
        spaceId: a.spaceId,
        subscriptionId: a.subscriptionId,
        clientId: a.id,
      });
    }
  }
  close(socket: WebSocket) {
    if (this.meta(socket)?.role === "agent")
      for (const s of this.viewers()) s.close(1012, "Bridge disconnected");
    this.subscriptions();
    this.status();
  }
  revoke() {
    for (const s of this.sockets()) s.close(4001, "Credentials changed");
  }
}
