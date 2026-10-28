import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  containsRemoteCredential,
  parseRemoteCredential,
  type RemoteCredentials,
  RemoteError,
  remoteBinding,
} from "./keychain.ts";
import {
  machineId,
  type RemoteDestination,
  type RemoteMessage,
  type RemoteRequest,
  remoteMessage,
  remoteOperation,
} from "./protocol.ts";

export class RemoteMachineClient {
  readonly #credentials: RemoteCredentials;
  constructor(credentials: RemoteCredentials) {
    this.#credentials = credentials;
  }
  async request(
    target: RemoteDestination,
    request: RemoteRequest,
    authorize: () => void,
    signal?: AbortSignal,
  ): Promise<RemoteMessage> {
    authorize();
    const binding = remoteBinding.safeParse({
      namespace: target.namespace,
      botId: target.botId,
      credentialRef: target.target.credentialRef,
      origin: target.target.origin,
    });
    if (
      !binding.success ||
      !machineId.safeParse(target.target.machineId).success ||
      signal?.aborted
    )
      throw new RemoteError("invalid");
    if (request.type === "run") {
      const { id, machineId: machine, ...input } = request.operation;
      if (
        machine !== target.target.machineId ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(id) ||
        !remoteOperation.safeParse(input).success
      )
        throw new RemoteError("invalid");
    } else if (request.type !== "status" && !/^[A-Za-z0-9_-]{1,120}$/.test(request.operationId))
      throw new RemoteError("invalid");
    const credential = parseRemoteCredential(
      await this.#credentials.read(binding.data, signal),
      binding.data,
    );
    authorize();
    if (
      containsRemoteCredential(request, credential) ||
      containsRemoteCredential(target, credential)
    )
      throw new RemoteError("denied");
    const url = new URL("/api/v1/execution", binding.data.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("machine", target.target.machineId);
    const requestId = randomUUID();
    const payload = JSON.stringify({ ...request, requestId });
    if (Buffer.byteLength(payload) > 16 * 1024) throw new RemoteError("invalid");
    const expectedId =
      request.type === "run"
        ? request.operation.id
        : request.type === "status"
          ? undefined
          : request.operationId;
    const timeout =
      request.type === "run"
        ? (request.operation.timeoutMs ??
            (request.operation.tool === "herdr.setup" && request.operation.action === "install"
              ? 120_000
              : 30_000)) + 5000
        : 5000;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new RemoteError("unknown"));
        return;
      }
      const socket = new WebSocket(url, {
        followRedirects: false,
        handshakeTimeout: 5000,
        perMessageDeflate: false,
        maxPayload: 512 * 1024,
        headers: {
          Authorization: `Bearer ${credential.ownerToken}`,
          ...(credential.accessClientID === undefined
            ? {}
            : {
                "CF-Access-Client-Id": credential.accessClientID,
                "CF-Access-Client-Secret": credential.accessClientSecret as string,
              }),
        },
      });
      let done = false;
      let opened = false;
      const finish = (value: RemoteMessage | RemoteError) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(heartbeat);
        signal?.removeEventListener("abort", aborted);
        socket.terminate();
        if (value instanceof RemoteError) reject(value);
        else resolve(value);
      };
      const checked = (body: () => void) => {
        if (done) return;
        try {
          authorize();
          body();
        } catch (error) {
          finish(error instanceof RemoteError ? error : new RemoteError("denied"));
        }
      };
      const aborted = () => finish(new RemoteError("unknown"));
      const timer = setTimeout(aborted, timeout);
      const heartbeat = setInterval(
        () =>
          checked(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}');
          }),
        10_000,
      );
      signal?.addEventListener("abort", aborted, { once: true });
      socket.once("open", () =>
        checked(() => {
          opened = true;
          if (request.type !== "status") socket.send(payload);
        }),
      );
      socket.on("message", (data, binary) =>
        checked(() => {
          if (binary) {
            finish(new RemoteError("invalid"));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(
              new TextDecoder("utf8", { fatal: true }).decode(
                Array.isArray(data)
                  ? Buffer.concat(data)
                  : data instanceof ArrayBuffer
                    ? new Uint8Array(data)
                    : data,
              ),
            );
          } catch {
            finish(new RemoteError("invalid"));
            return;
          }
          const decoded = remoteMessage.safeParse(parsed);
          if (!decoded.success || containsRemoteCredential(decoded.data, credential)) {
            finish(new RemoteError("invalid"));
            return;
          }
          const value = decoded.data;
          if (value.type === "pong") return;
          if (value.type === "status") {
            if (
              value.machineId !== target.target.machineId ||
              (value.online && (!value.observedAt || !value.agentVersion || !value.capabilities))
            ) {
              finish(new RemoteError("invalid"));
              return;
            }
            if (request.type === "status") finish(value);
            return;
          }
          if (
            value.requestId !== requestId ||
            (value.type === "result" ? value.operation.id : value.operationId) !== expectedId
          ) {
            finish(new RemoteError("invalid"));
            return;
          }
          if (value.type === "error") {
            finish(new RemoteError(value.code));
            return;
          }
          if ((value.type === "cancel-ack") !== (request.type === "cancel")) {
            finish(new RemoteError("invalid"));
            return;
          }
          finish(value);
        }),
      );
      socket.on("error", () => finish(new RemoteError(opened ? "unknown" : "offline")));
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        finish(
          new RemoteError(
            [401, 403].includes(response.statusCode ?? 0) ? "authentication" : "offline",
          ),
        );
      });
      socket.once("close", (code) =>
        finish(new RemoteError(code === 4001 ? "authentication" : opened ? "unknown" : "offline")),
      );
      if (signal?.aborted) aborted();
    });
  }
}
