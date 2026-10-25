// The WebSocket transport (docs/bots/PROTOCOL.md): one bot per connection, `hello` first,
// close codes for every refusal, and a frame budget measured on the encoded text.
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import type { BotRegistry } from "../core/BotRegistry.ts";
import type { ConversationService } from "../core/ConversationService.ts";
import type { ErrorDisposition } from "../core/domain.ts";
import { ClassifiedFailure } from "../core/domain.ts";
import type { HubEvent } from "../core/EventHub.ts";
import { declareEvent } from "../log/events.ts";
import type { Log } from "../log/log.ts";
import { encodeServerEvent, serializeFrame } from "../protocol/encode.ts";
import {
  type ClientCommand,
  decodeCommand,
  FrameError,
  parseJson,
  type ServerEvent,
} from "../protocol/frames.ts";
import { assertFrameBudget, assertInboundBytes } from "../protocol/validate.ts";
import { PROTOCOL_VERSION } from "../protocol/version.ts";

const Events = {
  openOk: declareEvent("transport.conn.open.ok"),
  openFail: declareEvent("transport.conn.open.fail"),
  openReject: declareEvent("transport.conn.open.reject"),
  closeOk: declareEvent("transport.conn.close.ok"),
  closeEnd: declareEvent("transport.conn.close.end"),
  frameRecvOk: declareEvent("transport.frame.recv.ok"),
  frameRecvFail: declareEvent("transport.frame.recv.fail"),
  frameSendOk: declareEvent("transport.frame.send.ok"),
  frameSendDrop: declareEvent("transport.frame.send.drop"),
  decodeFail: declareEvent("protocol.decode.fail"),
  limitFail: declareEvent("protocol.limit.fail"),
  versionFail: declareEvent("protocol.version.fail"),
  commandStart: declareEvent("protocol.command.start"),
  commandOk: declareEvent("protocol.command.ok"),
  commandFail: declareEvent("protocol.command.fail"),
} as const;

export const CLOSE = {
  normal: 1000,
  auth: 4001,
  protocol: 1008,
  idle: 4000,
  unknownBot: 4004,
  version: 4009,
  quarantined: 4090,
  shutdown: 1001,
} as const;

/** A connection that sends no frame for this long is closed with 4000. */
export const IDLE_FRAME_MS = 60_000;
export const MAX_CONNECTIONS = 16;

export type ConnectionDeps = {
  readonly log: Log;
  readonly service: ConversationService;
  readonly registry: BotRegistry;
  readonly server: { readonly version: string; readonly instance: string; readonly pid: number };
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly connId: string;
  readonly register: (socket: WebSocket) => void;
  readonly unregister: (socket: WebSocket) => void;
  readonly idleMs?: number;
};

/** Maps a runtime event the hub numbered onto its wire event. */
export const toServerEvent = (event: HubEvent): ServerEvent => {
  switch (event.type) {
    case "snapshot":
      return { type: "snapshot", rev: event.rev, trace: event.trace, value: event.value };
    case "append":
      return {
        type: "append",
        rev: event.rev,
        trace: event.trace,
        message: event.message,
        ...(event.replaces === undefined ? {} : { replaces: event.replaces }),
      };
    case "delta":
      return {
        type: "delta",
        rev: event.rev,
        trace: event.trace,
        messageId: event.messageId,
        changes: event.changes,
      };
    case "status":
      return {
        type: "status",
        rev: event.rev,
        trace: event.trace,
        running: event.running,
        streaming: event.streaming,
        inbox: event.inbox,
      };
    case "submission":
      return { type: "submission", rev: event.rev, trace: event.trace, record: event.record };
    case "error":
      return {
        type: "error",
        rev: event.rev,
        trace: event.trace,
        kind: event.failure.kind === "version_mismatch" ? "internal" : event.failure.kind,
        disposition: "runtime",
        failure: event.failure.id,
        message: event.message,
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      };
  }
};

/**
 * One connection. It answers `hello`, then routes commands to the service and encodes the
 * events the service publishes. Every refusal has one close code so the client can decide
 * whether to reconnect.
 */
export const attachConnection = (socket: WebSocket, deps: ConnectionDeps): void => {
  const { log, service, registry, connId } = deps;
  const idleMs = deps.idleMs ?? IDLE_FRAME_MS;
  let helloSent = false;
  let subscribed = false;
  let closed = false;
  let idleTimer: NodeJS.Timeout | undefined;

  const emit = (event: ServerEvent): void => {
    if (closed) return;
    const wire = encodeServerEvent(event);
    const text = serializeFrame(wire);
    try {
      assertFrameBudget(wire);
    } catch {
      log.emit("warn", "transport", Events.frameSendDrop, {
        trace: "trace" in event && event.trace !== undefined ? event.trace : `tr_${connId}`,
        connId,
        detail: { evt: event.type },
      });
      return;
    }
    socket.send(text);
    log.emit("trace", "transport", Events.frameSendOk, {
      trace: "trace" in event && event.trace !== undefined ? event.trace : `tr_${connId}`,
      connId,
      detail: { evt: event.type, bytes: Buffer.byteLength(text) },
    });
  };

  const close = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    socket.close(code, reason.slice(0, 120));
    log.emit("info", "transport", Events.closeOk, { trace: `tr_${connId}`, connId });
  };

  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => close(CLOSE.idle, "idle"), idleMs);
    idleTimer.unref?.();
  };

  socket.on("close", () => {
    closed = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (subscribed) registry.release(connectionBot);
    deps.unregister(socket);
    log.emit("info", "transport", Events.closeEnd, { trace: `tr_${connId}`, connId });
  });
  socket.on("error", () => close(CLOSE.normal, "socket error"));

  // Filled in by `subscribe`; the close handler uses it to release the idle hold.
  let connectionBot = "";

  socket.on("message", (data, isBinary) => {
    if (closed) return;
    armIdle();
    const text = isBinary ? undefined : data.toString();
    if (text === undefined) {
      log.emit("warn", "protocol", Events.decodeFail, {
        trace: `tr_${connId}`,
        connId,
        failure: { id: `f_${connId}`, kind: "invalid_command", layer: "protocol" },
        origin: true,
        detail: { reason: "invalid" },
      });
      close(CLOSE.protocol, "binary frame");
      return;
    }
    log.emit("trace", "transport", Events.frameRecvOk, {
      trace: `tr_${connId}`,
      connId,
      detail: { bytes: Buffer.byteLength(text) },
    });
    let command: ClientCommand;
    try {
      assertInboundBytes(text);
      command = decodeCommand(parseJson(text));
    } catch (error) {
      const frame = error instanceof FrameError ? error : undefined;
      const kind = frame?.reason === "limit_exceeded" ? "limit_exceeded" : "invalid_command";
      const evt = frame?.reason === "limit_exceeded" ? Events.limitFail : Events.decodeFail;
      log.emit("warn", "protocol", evt, {
        trace: frameTrace(text, connId),
        connId,
        failure: { id: `f_${connId}_${Date.now()}`, kind, layer: "protocol" },
        origin: true,
        detail: { reason: "invalid" },
      });
      if (frame?.reason === "invalid_command") {
        // A command this version does not know is refused, and the connection stays: the
        // client can carry on (PROTOCOL.md, "Client commands").
        emit({
          type: "error",
          trace: frameTrace(text, connId),
          kind: "invalid_command",
          disposition: "not_admitted",
          failure: `f_${connId}`,
          message: "the command was refused",
        });
        return;
      }
      close(CLOSE.protocol, frame?.reason ?? "bad frame");
      return;
    }
    void dispatch(command, text);
  });

  const dispatch = async (command: ClientCommand, text: string): Promise<void> => {
    const trace =
      "trace" in command && command.trace !== undefined ? command.trace : `tr_${connId}`;
    if (!helloSent) {
      if (command.type !== "hello") {
        close(CLOSE.protocol, "hello must be the first frame");
        return;
      }
      helloSent = true;
      if (command.protocolVersion !== PROTOCOL_VERSION) {
        log.emit("warn", "protocol", Events.versionFail, {
          trace,
          connId,
          failure: { id: `f_${connId}`, kind: "version_mismatch", layer: "protocol" },
          origin: true,
          detail: { reason: "invalid" },
        });
        emit({
          type: "error",
          kind: "version_mismatch",
          message: "this daemon does not speak that protocol version",
          server: { protocolVersion: PROTOCOL_VERSION },
        });
        close(CLOSE.version, "version mismatch");
        return;
      }
      emit({
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        server: deps.server,
        capabilities: deps.capabilities,
        bots: registry.summaries(),
      });
      return;
    }
    if (command.type === "hello") {
      close(CLOSE.protocol, "hello twice");
      return;
    }
    if (command.type === "ping") {
      emit({ type: "pong" });
      return;
    }
    log.emit("debug", "protocol", Events.commandStart, {
      trace,
      connId,
      detail: { kind: command.type },
    });
    try {
      await run(command, trace);
      log.emit("debug", "protocol", Events.commandOk, {
        trace,
        connId,
        detail: { kind: command.type },
      });
    } catch (error) {
      await refuse(error, command, trace);
    }
    void text;
  };

  const run = async (
    command: Exclude<ClientCommand, { type: "hello" | "ping" }>,
    trace: string,
  ): Promise<void> => {
    if (command.type === "subscribe") {
      if (subscribed) {
        close(CLOSE.protocol, "already subscribed");
        return;
      }
      if (registry.state(command.botId) === "quarantined") {
        close(CLOSE.quarantined, "quarantined");
        return;
      }
      const { rev, snapshot } = await service.subscribe(connId, command.botId, trace, (event) =>
        emit(toServerEvent(event)),
      );
      subscribed = true;
      connectionBot = command.botId;
      registry.touch(command.botId);
      emit({ type: "snapshot", rev, trace, value: snapshot });
      return;
    }
    if (command.type === "send") {
      const record = await service.send(connId, {
        requestId: command.requestId,
        text: command.text,
        whenBusy: command.whenBusy,
        trace,
      });
      emit({ type: "submission", trace, record });
      return;
    }
    if (command.type === "abort") {
      await service.abort(connId, trace);
      return;
    }
    if (command.type === "recover") {
      await service.recover(connId, trace);
      return;
    }
    if (command.type === "resync") {
      service.resync(connId, trace);
      return;
    }
    const history = await service.history(connId, {
      beforeEntryId: command.before,
      limit: command.limit,
    });
    emit({ type: "history", trace, messages: history.messages, hasMore: history.hasMore });
  };

  const refuse = async (error: unknown, command: ClientCommand, trace: string): Promise<void> => {
    const classified =
      error instanceof ClassifiedFailure
        ? error
        : new ClassifiedFailure(
            { id: `f_${connId}`, kind: "internal", layer: "core" },
            "runtime",
            "the command failed",
            { cause: error },
          );
    const kind = classified.failure.kind;
    const disposition: ErrorDisposition = classified.disposition;
    const requestId = command.type === "send" ? command.requestId : undefined;
    // Core classified it; this layer only records that it handed the failure on.
    log.emit("warn", "protocol", Events.commandFail, {
      trace,
      connId,
      ...(requestId === undefined ? {} : { reqId: requestId }),
      failure: classified.failure,
      detail: { kind: command.type, reason: "upstream", propagated: true },
    });
    if (kind === "unknown_bot" && disposition === "not_admitted") {
      close(CLOSE.unknownBot, "unknown bot");
      return;
    }
    emit({
      type: "error",
      trace,
      kind: kind === "version_mismatch" ? "internal" : kind,
      disposition,
      failure: classified.failure.id,
      message: safeMessage(classified.message),
      ...(requestId === undefined ? {} : { requestId }),
    });
  };

  armIdle();
  deps.register(socket);
  log.emit("info", "transport", Events.openOk, { trace: `tr_${connId}`, connId });
};

/** A rejection message is bounded and never carries model or provider content. */
const safeMessage = (message: string): string =>
  message.length > 200 ? `${message.slice(0, 197)}…` : message;

/** The trace of a refused frame: the client's own when the JSON parsed, else the connection. */
const frameTrace = (text: string, connId: string): string => {
  try {
    const raw = JSON.parse(text) as { trace?: unknown };
    if (typeof raw.trace === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(raw.trace)) return raw.trace;
  } catch {
    // not JSON: fall through
  }
  return `tr_${connId}`;
};

/** Rejects authentication and connection-count limits before any upgrade happens. */
export const refuseUpgrade = (socket: Duplex, code: number, message: string): void => {
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};
