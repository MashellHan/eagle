import { createHash, type KeyObject } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { z } from "zod";
import type { BotRegistry, ReadyReplica } from "./core/BotRegistry.ts";
import {
  type DeviceSyncPort,
  deviceSyncProof,
  type SyncApi,
  type SyncStatus,
  syncPullInput,
} from "./core/DeviceSyncPort.ts";
import { ClassifiedFailure, type Failure } from "./core/domain.ts";
import { newFailure } from "./core/failures.ts";
import { declareEvent } from "./log/events.ts";
import type { Log } from "./log/log.ts";
import { FAILURE_ID } from "./protocol/limits.ts";
import {
  checkTime,
  ephemeral,
  MAX_SYNC_FRAME,
  nonce,
  type Proof,
  seal,
  unseal,
  verifyProof,
} from "./sync-crypto.ts";

const Events = {
  start: declareEvent("runtime.sync.start"),
  ok: declareEvent("runtime.sync.ok"),
  fail: declareEvent("runtime.sync.fail"),
};
const bytes32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const challengeInput = z.strictObject({
  version: z.literal(1),
  sharedBotId: z.uuid().toLowerCase(),
  readerDeviceId: z.uuid().toLowerCase(),
  readerNonce: bytes32,
  readerEphemeral: bytes32,
});
const challengeReply = z.strictObject({
  proof: deviceSyncProof,
  signature: z.string().max(2048),
  trace: z.string().max(160),
});
const pageInput = z.strictObject({
  sessionId: bytes32,
  signature: z.string().max(2048),
  box: z.unknown(),
});
const query = syncPullInput.omit({ peerDeviceId: true });
const remoteFailure = z.strictObject({
  id: z.string().regex(FAILURE_ID),
  kind: z.enum([
    "auth_failed",
    "invalid_command",
    "unknown_bot",
    "internal",
    "storage_failed",
    "limit_exceeded",
  ]),
  layer: z.enum(["transport", "protocol", "core", "runtime", "pi"]),
});
type Context = { trace: string; botId: string };
type Pending = { proof: Proof; privateKey: KeyObject; replica: ReadyReplica };

async function body(request: IncomingMessage, limit: number): Promise<unknown> {
  if (Number(request.headers["content-length"] ?? 0) > limit) {
    request.resume();
    throw new Error("sync_frame_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("sync_frame_too_large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function reply(response: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_SYNC_FRAME) throw new Error("sync_frame_too_large");
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(text);
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** One authenticated ephemeral exchange; no queue, recovery, cache key or remote execution. */
export class AuthenticatedSync implements SyncApi {
  readonly #registry: BotRegistry;
  readonly #device: DeviceSyncPort;
  readonly #log: Log;
  readonly #binding: string | null;
  readonly #instance: string;
  #generation = nonce();
  #closed = false;
  readonly #pending = new Map<string, Pending>();
  #ready: { port: number; digest: string } | undefined;
  constructor(options: {
    registry: BotRegistry;
    device: DeviceSyncPort;
    log: Log;
    deviceSocket?: string;
    instance?: string;
  }) {
    this.#registry = options.registry;
    this.#device = options.device;
    this.#log = options.log;
    this.#binding =
      options.deviceSocket === undefined
        ? null
        : createHash("sha256").update(options.deviceSocket).digest("hex");
    this.#instance = options.instance ?? `i_${nonce()}`;
  }
  status(): SyncStatus {
    return {
      version: 1,
      instance: this.#instance,
      pid: process.pid,
      binding: this.#binding,
      ready: this.#ready !== undefined && !this.#closed,
      actualPort: this.#ready?.port ?? null,
      selfDigest: this.#ready?.digest ?? null,
    };
  }
  setReady(value: { port: number; digest: string } | undefined): void {
    this.#ready = value;
    if (value === undefined) {
      this.#generation = nonce();
      this.#pending.clear();
    }
  }
  close(): void {
    this.#closed = true;
    this.setReady(undefined);
  }
  #live(generation: string): void {
    if (this.#closed || generation !== this.#generation) throw new Error("sync_generation_changed");
  }
  #use(proof: Proof, generation: string): void {
    this.#live(generation);
    checkTime(proof);
  }
  #failure(error: unknown, fields: Context): ClassifiedFailure {
    if (error instanceof ClassifiedFailure) {
      this.#log.emit("warn", "runtime", Events.fail, {
        ...fields,
        failure: error.failure,
        detail: { propagated: true, reason: "upstream", providerCode: error.failure.kind },
      });
      return error;
    }
    const reason =
      error instanceof Error && /^[a-z][a-z0-9_]{0,80}$/.test(error.message)
        ? error.message
        : "sync_protocol_invalid";
    const failure = newFailure(
      reason === "sync_network_unreachable" ? "internal" : "auth_failed",
      "runtime",
    );
    this.#log.emit("error", "runtime", Events.fail, {
      ...fields,
      failure,
      origin: true,
      detail: { reason: "upstream", providerCode: reason.slice(0, 40) },
    });
    return new ClassifiedFailure(failure, "not_admitted", "authenticated synchronization failed", {
      cause: error,
    });
  }
  async #authorize(proof: Proof, fields: Context): Promise<void> {
    checkTime(proof);
    const role = proof.role;
    const own = proof[role];
    const peer = proof[role === "reader" ? "server" : "reader"];
    const input = {
      sharedBotId: proof.sharedBotId,
      peerDeviceId: peer.deviceId,
      purpose: "replica.read" as const,
    };
    const result =
      role === "reader"
        ? await this.#device.access(input, fields)
        : await this.#device.authorize?.(input, fields);
    if (
      !result ||
      !same(result.local, own) ||
      !same(result.peer, peer) ||
      ("registryOrigin" in result && result.registryOrigin !== proof.registryOrigin)
    )
      throw new Error("sync_identity_changed");
  }
  readonly handler: RequestListener = (request, response) => {
    const requested = request.headers["x-bots-sync-trace"];
    const trace =
      typeof requested === "string" && /^tr_[A-Za-z0-9_-]{1,128}$/.test(requested)
        ? requested
        : `tr_sync_${nonce().slice(0, 16)}`;
    const fields = { trace, botId: "b_sync" };
    void (async () => {
      this.#live(this.#generation);
      if (request.method !== "POST" || request.headers.origin !== undefined)
        throw new Error("sync_route_refused");
      if (request.url === "/v1/sync/challenge")
        return this.#challenge(challengeInput.parse(await body(request, 8192)), fields);
      if (request.url === "/v1/sync/page")
        return this.#page(pageInput.parse(await body(request, MAX_SYNC_FRAME)), fields);
      throw new Error("sync_route_refused");
    })().then(
      (value) => {
        try {
          reply(response, 200, value);
        } catch (error) {
          const failure = this.#failure(error, fields);
          response.destroy(failure);
        }
      },
      (error) => {
        const failure = this.#failure(error, fields);
        if (!response.destroyed && !response.headersSent)
          reply(response, failure.failure.kind === "auth_failed" ? 403 : 409, {
            trace,
            error: { failure: failure.failure },
          });
      },
    );
  };
  async #challenge(input: z.infer<typeof challengeInput>, fields: Context) {
    const generation = this.#generation;
    for (const [id, pending] of this.#pending)
      if (pending.proof.expiresAt <= Date.now()) this.#pending.delete(id);
    if (this.#pending.size >= 128) throw new Error("sync_challenge_capacity");
    const access = await this.#device.authorize?.(
      {
        sharedBotId: input.sharedBotId,
        peerDeviceId: input.readerDeviceId,
        purpose: "replica.read",
      },
      fields,
    );
    if (!access || !this.#device.proof) throw new Error("sync_unconfigured");
    const replica = await this.#registry.readySharedReplica(input.sharedBotId, fields.trace);
    fields.botId = replica.botId;
    const pair = ephemeral();
    const proof = deviceSyncProof.parse({
      version: 1,
      registryOrigin: access.registryOrigin,
      role: "server",
      purpose: "replica.read",
      sharedBotId: input.sharedBotId,
      reader: access.peer,
      server: access.local,
      readerNonce: input.readerNonce,
      readerEphemeral: input.readerEphemeral,
      serverNonce: nonce(),
      serverEphemeral: pair.publicKey,
      generation,
      sessionId: nonce(),
      expiresAt: Date.now() + 60000,
    });
    const signature = (await this.#device.proof(proof, fields)).signature;
    verifyProof(proof, signature);
    await this.#authorize(proof, fields);
    await replica.check();
    this.#use(proof, generation);
    if (this.#pending.size >= 128) throw new Error("sync_challenge_capacity");
    this.#pending.set(proof.sessionId, { proof, privateKey: pair.privateKey, replica });
    return { proof, signature, trace: fields.trace };
  }
  async #page(input: z.infer<typeof pageInput>, fields: Context) {
    const pending = this.#pending.get(input.sessionId);
    this.#pending.delete(input.sessionId);
    if (!pending) throw new Error("sync_challenge_unknown");
    const { proof, privateKey, replica } = pending;
    fields.botId = replica.botId;
    this.#use(proof, proof.generation);
    verifyProof({ ...proof, role: "reader" }, input.signature);
    const params = query.parse(
      JSON.parse(unseal(proof, privateKey, "reader", input.box).toString("utf8")),
    );
    await this.#authorize(proof, fields);
    await replica.check();
    const page = await replica.command("pull", params, () => this.#use(proof, proof.generation));
    await this.#authorize(proof, fields);
    await replica.check();
    this.#use(proof, proof.generation);
    return {
      box: seal(proof, privateKey, "server", Buffer.from(JSON.stringify(page))),
      trace: fields.trace,
    };
  }
  async #exchange(origin: string, path: string, value: unknown, fields: Context): Promise<unknown> {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_SYNC_FRAME) throw new Error("sync_frame_too_large");
    let response: Response;
    try {
      response = await fetch(origin + path, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: { "content-type": "application/json", "x-bots-sync-trace": fields.trace },
        body: text,
      });
    } catch (error) {
      throw new Error("sync_network_unreachable", { cause: error });
    }
    if (Number(response.headers.get("content-length") ?? 0) > MAX_SYNC_FRAME) {
      await response.body?.cancel();
      throw new Error("sync_frame_too_large");
    }
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const part = await reader.read().catch((cause: unknown) => {
            throw new Error("sync_network_unreachable", { cause });
          });
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_SYNC_FRAME) {
            await reader.cancel().catch(() => undefined);
            throw new Error("sync_frame_too_large");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok) {
      const failure = remoteFailure.safeParse(
        (decoded as { error?: { failure?: unknown } })?.error?.failure,
      );
      if (failure.success)
        throw new ClassifiedFailure(
          failure.data as Failure,
          "not_admitted",
          "peer refused synchronization",
        );
      throw new Error("sync_peer_refused");
    }
    return decoded;
  }
  async pull(botId: string, input: z.infer<typeof syncPullInput>, trace: string): Promise<unknown> {
    const fields = { trace, botId };
    const generation = this.#generation;
    this.#log.emit("info", "runtime", Events.start, fields);
    try {
      this.#live(generation);
      const replica = await this.#registry.readyReplica(botId, trace);
      const selected = await this.#device.access(
        {
          sharedBotId: replica.sharedBotId,
          peerDeviceId: input.peerDeviceId,
          purpose: "replica.read",
        },
        fields,
      );
      const endpoint = selected.endpoints?.candidates[0];
      if (!endpoint) throw new Error("sync_network_unreachable");
      const origin = `http://${endpoint.address.includes(":") ? `[${endpoint.address}]` : endpoint.address}:${endpoint.port}`;
      const pair = ephemeral();
      const readerNonce = nonce();
      const challenge = challengeReply.parse(
        await this.#exchange(
          origin,
          "/v1/sync/challenge",
          {
            version: 1,
            sharedBotId: replica.sharedBotId,
            readerDeviceId: selected.local.deviceId,
            readerNonce,
            readerEphemeral: pair.publicKey,
          },
          fields,
        ),
      );
      const server = challenge.proof;
      if (
        challenge.trace !== trace ||
        server.role !== "server" ||
        server.sharedBotId !== replica.sharedBotId ||
        server.readerNonce !== readerNonce ||
        server.readerEphemeral !== pair.publicKey ||
        !same(server.reader, selected.local) ||
        !same(server.server, selected.peer)
      )
        throw new Error("sync_challenge_mismatch");
      checkTime(server);
      verifyProof(server, challenge.signature);
      const proof: Proof = { ...server, role: "reader" };
      await this.#authorize(proof, fields);
      await replica.check();
      this.#use(proof, generation);
      if (!this.#device.proof) throw new Error("sync_unconfigured");
      const signature = (await this.#device.proof(proof, fields)).signature;
      verifyProof(proof, signature);
      await this.#authorize(proof, fields);
      await replica.check();
      this.#use(proof, generation);
      const params = query.parse({ source: input.source, after: input.after, limit: input.limit });
      const response = z.strictObject({ box: z.unknown(), trace: z.literal(trace) }).parse(
        await this.#exchange(
          origin,
          "/v1/sync/page",
          {
            sessionId: server.sessionId,
            signature,
            box: seal(proof, pair.privateKey, "reader", Buffer.from(JSON.stringify(params))),
          },
          fields,
        ),
      );
      const page: unknown = JSON.parse(
        unseal(proof, pair.privateKey, "server", response.box).toString("utf8"),
      );
      await this.#authorize(proof, fields);
      await replica.check();
      const applied = await replica.command("apply", { page }, () => this.#use(proof, generation));
      this.#log.emit("info", "runtime", Events.ok, fields);
      return { page, applied };
    } catch (error) {
      throw this.#failure(error, fields);
    }
  }
}
