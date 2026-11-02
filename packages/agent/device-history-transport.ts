import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import type {
  HistoryKeyIdentity,
  HistoryServerFrame,
} from "../contracts/src/device-history.ts";
import {
  HISTORY_FRAME_BYTES,
  HistoryPacket,
  type HistoryPeer,
} from "../contracts/src/device-history.ts";
import type { DeviceCloud } from "./device-cloud.ts";
import { DeviceHistoryCipher } from "./device-history.ts";
import { isTailnetAddress, readTailscaleAddress } from "./device-tailscale.ts";

const endpoint = z.strictObject({
  address: z.string().refine(isTailnetAddress),
  port: z.number().int().min(1).max(65535),
});
const peerBinding = (peer: HistoryPeer) =>
  JSON.stringify([peer.device, peer.proof]);

export type HistoryLocalEvent =
  | { type: "history.ready"; enabled: boolean; ready: boolean }
  | { type: "history.changed"; sourceDeviceId: string }
  | { type: "history.packet"; sourceDeviceId: string; payload: unknown };

/** Optional private IPC transport. It never interprets a payload as a device operation. */
export class DeviceHistoryTransport {
  private enabled = false;
  private cipher?: DeviceHistoryCipher;
  private configuring?: Promise<void>;
  private generation = 0;
  private noticeGeneration = 0;
  private renewal?: ReturnType<typeof setTimeout>;
  private recovery?: ReturnType<typeof setTimeout>;
  private noticeRetry?: ReturnType<typeof setTimeout>;
  private listeners = new Set<(event: HistoryLocalEvent) => void>();
  private detach: () => void;
  private incoming = 0;
  private outgoing = 0;
  private closed = false;
  private readonly path: string;
  private readonly cloud: DeviceCloud;
  private readonly signer: (proof: HistoryKeyIdentity) => Promise<string>;
  private direct?: Server;
  private directStarting?: Promise<void>;
  private endpointRetry?: ReturnType<typeof setTimeout>;
  private endpoint?: z.infer<typeof endpoint>;
  private readonly endpoints = new Map<
    string,
    { endpoint: z.infer<typeof endpoint>; binding: string; retryAt: number }
  >();
  private readonly seen = new Set<string>();
  private readonly discover: () => Promise<string | undefined>;
  constructor(
    cloud: DeviceCloud,
    directory: string,
    signer: (proof: HistoryKeyIdentity) => Promise<string>,
    discover = readTailscaleAddress,
  ) {
    this.cloud = cloud;
    this.signer = signer;
    this.discover = discover;
    this.path = join(directory, "history.json");
    const stat = lstatSync(this.path, { throwIfNoEntry: false });
    if (stat) {
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.nlink !== 1 ||
        stat.mode & 0o077 ||
        stat.size > 1024
      )
        throw new Error("history_settings_insecure");
      this.enabled = z
        .strictObject({ enabled: z.boolean() })
        .parse(JSON.parse(readFileSync(this.path, "utf8"))).enabled;
    }
    this.detach = cloud.observeHistory((event) => {
      if (event.type === "history.online")
        void this.refresh().catch((error) => this.failedRefresh(error));
      else if (event.type === "history.offline") {
        this.generation++;
        this.cipher = undefined;
        this.cancelTimers();
        this.publishReady();
      } else
        void this.receive(event).catch(() => {
          /* Untrusted or stale ciphertext never reaches the consumer. */
        });
    });
  }
  status() {
    return {
      enabled: this.enabled,
      ready: !!this.cipher && this.cloud.status === "online",
    };
  }
  observe(listener: (event: HistoryLocalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(event: HistoryLocalEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* Optional consumers are isolated from the device runtime. */
      }
    }
  }
  private publishReady() {
    this.publish({ type: "history.ready", ...this.status() });
  }
  private cancelTimers() {
    clearTimeout(this.renewal);
    clearTimeout(this.recovery);
    clearTimeout(this.noticeRetry);
    this.renewal = undefined;
    this.recovery = undefined;
    this.noticeRetry = undefined;
    this.direct?.closeAllConnections();
    this.direct?.close();
    this.direct = undefined;
    this.directStarting = undefined;
    this.endpoint = undefined;
    this.endpoints.clear();
    this.seen.clear();
    clearTimeout(this.endpointRetry);
    this.endpointRetry = undefined;
  }
  async setEnabled(enabled: boolean) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ enabled }), {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, this.path);
    this.enabled = enabled;
    this.generation++;
    this.cipher = undefined;
    this.cancelTimers();
    this.publishReady();
    if (enabled) {
      try {
        await this.refresh();
      } catch (error) {
        this.failedRefresh(error);
        throw error;
      }
    } else if (this.cloud.status === "online")
      await this.cloud.historyRequest({
        type: "history.configure",
        requestId: randomUUID(),
        proof: null,
      });
    return this.status();
  }
  async refresh(): Promise<void> {
    if (!this.enabled || this.closed || this.cloud.status !== "online") return;
    if (this.configuring) {
      await this.configuring;
      if (!this.cipher && this.enabled) return this.refresh();
      return;
    }
    const generation = this.generation;
    const current = () =>
      !this.closed && this.enabled && this.generation === generation;
    this.configuring = (async () => {
      const directory = await this.cloud.directory();
      const device = directory.devices.find(
        (item) => item.deviceId === this.cloud.device.deviceId,
      );
      if (!device || !current()) return;
      const cipher = await DeviceHistoryCipher.create(
        this.cloud.origin,
        device,
        this.signer,
      );
      if (!current()) return;
      await this.cloud.historyRequest({
        type: "history.configure",
        requestId: randomUUID(),
        proof: cipher.proof,
      });
      if (!current()) return;
      this.cipher = cipher;
      const peers = await this.peers();
      await this.notify();
      this.publishReady();
      this.prepareDirect();
      for (const peer of peers)
        this.publish({
          type: "history.changed",
          sourceDeviceId: peer.deviceId,
        });
      clearTimeout(this.renewal);
      this.renewal = setTimeout(() => {
        void this.refresh().catch((error) => this.failedRefresh(error));
      }, 60_000);
      this.renewal.unref();
    })();
    try {
      await this.configuring;
    } finally {
      this.configuring = undefined;
    }
  }
  private transient(error: unknown) {
    return (
      error instanceof Error &&
      (error.name === "TimeoutError" ||
        [
          "internal_error",
          "history_busy",
          "history_response_timeout",
          "history_delivery_failed",
          "history_rate_limit",
          "history_offline",
        ].includes(error.message))
    );
  }
  private failedRefresh(error: unknown) {
    this.cipher = undefined;
    this.publishReady();
    if (
      !this.closed &&
      this.enabled &&
      this.cloud.status === "online" &&
      this.transient(error) &&
      !this.recovery
    ) {
      this.recovery = setTimeout(() => {
        this.recovery = undefined;
        void this.refresh().catch((error) => this.failedRefresh(error));
      }, 1000);
      this.recovery.unref();
    }
  }
  private async peerKeys() {
    if (!this.enabled || !this.cipher)
      throw new Error("history_disabled_or_unavailable");
    const response = await this.cloud.historyRequest({
      type: "history.peers",
      requestId: randomUUID(),
    });
    if (response.type !== "history.peers")
      throw new Error("history_invalid_response");
    return response.peers;
  }
  async peers() {
    return (await this.peerKeys()).map((peer) => peer.device);
  }
  async send(targetDeviceId: string, payload: unknown) {
    if (this.outgoing >= 2) throw new Error("history_busy");
    this.outgoing++;
    try {
      return await this.deliver(targetDeviceId, payload);
    } finally {
      this.outgoing--;
    }
  }
  private async deliver(targetDeviceId: string, payload: unknown) {
    const cipher = this.cipher;
    if (!this.enabled || !cipher)
      throw new Error("history_disabled_or_unavailable");
    const peer = (await this.peerKeys()).find(
      (peer) => peer.device.deviceId === targetDeviceId,
    );
    if (!peer || this.cipher !== cipher)
      throw new Error("history_peer_unavailable");
    const requestId = randomUUID();
    const packet = await cipher.seal(peer, requestId, payload);
    if (!this.enabled || this.cipher !== cipher)
      throw new Error("history_disabled_or_unavailable");
    const direct = this.endpoints.get(targetDeviceId);
    if (direct?.binding === peerBinding(peer) && direct.retryAt <= Date.now()) {
      try {
        const url = new URL(
          `http://${direct.endpoint.address.includes(":") ? `[${direct.endpoint.address}]` : direct.endpoint.address}:${direct.endpoint.port}/history/v1`,
        );
        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            redirect: "manual",
            signal: AbortSignal.timeout(750),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ packet }),
          });
        } catch {
          throw new Error("history_direct_unavailable");
        }
        if (
          [401, 403].includes(response.status) ||
          (response.status >= 300 && response.status < 400)
        )
          throw new Error("history_direct_unauthorized");
        if (!response.ok) throw new Error("history_direct_unavailable");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("history_direct_invalid_ack");
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const part = await reader.read().catch(() => {
            throw new Error("history_direct_unavailable");
          });
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > HISTORY_FRAME_BYTES) {
            await reader.cancel();
            throw new Error("history_direct_invalid_ack");
          }
          chunks.push(part.value);
        }
        const ack = z
          .strictObject({ packet: HistoryPacket })
          .parse(JSON.parse(Buffer.concat(chunks).toString()));
        if (
          ack.packet.purpose !== "ack" ||
          ack.packet.requestId !== packet.requestId
        )
          throw new Error("history_direct_invalid_ack");
        const received = await cipher.open(peer, ack.packet);
        if (
          JSON.stringify(received) !==
            JSON.stringify({ received: packet.requestId }) ||
          this.cipher !== cipher
        )
          throw new Error("history_direct_invalid_ack");
        return { sent: true, route: "tailscale" };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "history_direct_unavailable"
        )
          throw error;
        direct.retryAt = Date.now() + 30_000;
      }
    }
    if (!this.enabled || this.cipher !== cipher)
      throw new Error("history_disabled_or_unavailable");
    await this.cloud.historyRequest({
      type: "history.send",
      requestId,
      targetDeviceId,
      packet,
    });
    return { sent: true, route: "do" };
  }

  private async startDirect() {
    if (this.directStarting) return this.directStarting;
    const generation = this.generation;
    const current = () =>
      !this.closed &&
      this.enabled &&
      this.generation === generation &&
      this.cloud.status === "online";
    const starting = (async () => {
      if (!this.endpoint) {
        const address = await this.discover();
        if (!address || !isTailnetAddress(address) || !current()) return;
        const server = createServer((request, response) => {
          void (async () => {
            if (request.method !== "POST" || request.url !== "/history/v1") {
              response.writeHead(404).end();
              return;
            }
            if (!current() || !this.cipher) {
              response.writeHead(403).end();
              return;
            }
            if (this.incoming >= 2) {
              response.writeHead(429).end();
              return;
            }
            this.incoming++;
            const deadline = setTimeout(() => {
              request.destroy();
              response.destroy();
            }, 1000);
            try {
              let size = 0;
              const chunks: Buffer[] = [];
              for await (const chunk of request) {
                size += chunk.length;
                if (size > HISTORY_FRAME_BYTES) {
                  response.writeHead(413).end();
                  request.destroy();
                  return;
                }
                chunks.push(chunk);
              }
              const { packet } = z
                .strictObject({ packet: HistoryPacket })
                .parse(JSON.parse(Buffer.concat(chunks).toString()));
              if (packet.purpose !== undefined)
                throw new Error("history_direct_unauthorized");
              const cipher = this.cipher;
              const peer = (await this.peerKeys()).find(
                (peer) => peer.device.deviceId === packet.sourceDeviceId,
              );
              if (!peer || !cipher || this.cipher !== cipher || !current())
                throw new Error("history_direct_unauthorized");
              await this.accept(cipher, peer, packet);
              const ack = await cipher.seal(
                peer,
                packet.requestId,
                { received: packet.requestId },
                "ack",
              );
              if (this.cipher !== cipher || !current())
                throw new Error("history_direct_unauthorized");
              response
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify({ packet: ack }));
            } catch {
              response.writeHead(403).end();
            } finally {
              clearTimeout(deadline);
              this.incoming--;
            }
          })().catch(() => response.destroy());
        });
        server.requestTimeout = 1000;
        server.headersTimeout = 1000;
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host: address, port: 0 }, () => {
            server.off("error", reject);
            resolve();
          });
        });
        server.on("error", () => {
          if (this.direct === server) {
            this.endpoint = undefined;
            this.direct = undefined;
          }
          server.close();
        });
        if (!current()) {
          server.close();
          return;
        }
        this.direct = server;
        const bound = server.address();
        if (bound === null || typeof bound === "string") {
          server.close();
          return;
        }
        this.endpoint = { address, port: bound.port };
      }
      for (const peer of await this.peerKeys())
        await this.announceEndpoint(peer);
    })();
    this.directStarting = starting;
    try {
      await starting;
    } finally {
      if (this.directStarting === starting) this.directStarting = undefined;
    }
  }

  private async announceEndpoint(peer: HistoryPeer) {
    if (this.outgoing >= 2) throw new Error("history_busy");
    const cipher = this.cipher;
    if (!cipher || !this.endpoint || !this.enabled) return;
    this.outgoing++;
    try {
      const requestId = randomUUID();
      const packet = await cipher.seal(
        peer,
        requestId,
        this.endpoint,
        "endpoint",
      );
      if (this.cipher !== cipher) return;
      await this.cloud.historyRequest({
        type: "history.send",
        requestId,
        targetDeviceId: peer.device.deviceId,
        packet,
      });
    } finally {
      this.outgoing--;
    }
  }

  private prepareDirect() {
    void this.startDirect().catch((error) => {
      if (
        !this.closed &&
        this.enabled &&
        this.cloud.status === "online" &&
        this.transient(error) &&
        !this.endpointRetry
      ) {
        this.endpointRetry = setTimeout(() => {
          this.endpointRetry = undefined;
          this.prepareDirect();
        }, 1000);
        this.endpointRetry.unref();
      }
    });
  }

  private async accept(
    cipher: DeviceHistoryCipher,
    source: HistoryPeer,
    packet: z.infer<typeof HistoryPacket>,
  ) {
    const payload = await cipher.open(source, packet);
    if (!this.enabled || this.cipher !== cipher || this.closed)
      throw new Error("history_disabled_or_unavailable");
    const id = `${packet.sourceKey}/${packet.requestId}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    const oldest = this.seen.values().next().value;
    if (this.seen.size > 256 && oldest !== undefined) this.seen.delete(oldest);
    if (packet.purpose === "endpoint") {
      const value = endpoint.parse(payload);
      const previous = this.endpoints.get(source.device.deviceId);
      const binding = peerBinding(source);
      this.endpoints.set(source.device.deviceId, {
        endpoint: value,
        binding,
        retryAt: 0,
      });
      if (
        !previous ||
        previous.binding !== binding ||
        JSON.stringify(previous.endpoint) !== JSON.stringify(value)
      ) {
        try {
          await this.announceEndpoint(source);
        } catch (error) {
          this.prepareDirect();
          throw error;
        }
      }
    } else if (packet.purpose === undefined)
      this.publish({
        type: "history.packet",
        sourceDeviceId: source.device.deviceId,
        payload,
      });
  }
  async notify() {
    if (this.enabled && this.cipher) {
      const notice = ++this.noticeGeneration;
      const generation = this.generation;
      const cipher = this.cipher;
      const current = () =>
        !this.closed &&
        this.enabled &&
        this.generation === generation &&
        this.cipher === cipher &&
        this.noticeGeneration === notice;
      try {
        await this.cloud.historyRequest({
          type: "history.changed",
          requestId: randomUUID(),
        });
        if (current()) {
          clearTimeout(this.noticeRetry);
          this.noticeRetry = undefined;
        }
      } catch (error) {
        if (current() && this.transient(error) && !this.noticeRetry) {
          this.noticeRetry = setTimeout(() => {
            this.noticeRetry = undefined;
            void this.notify().catch(() => {});
          }, 1000);
          this.noticeRetry.unref();
        }
        throw error;
      }
    }
    return this.status();
  }
  private async receive(event: HistoryServerFrame) {
    const cipher = this.cipher;
    if (!this.enabled || !cipher || this.closed) return;
    if (event.type === "history.changed") {
      this.publish({
        type: "history.changed",
        sourceDeviceId: event.source.device.deviceId,
      });
    } else if (event.type === "history.packet") {
      if (this.incoming >= 2) return;
      this.incoming++;
      try {
        await this.accept(cipher, event.source, event.packet);
      } finally {
        this.incoming--;
      }
    }
  }
  close() {
    this.closed = true;
    this.generation++;
    this.cipher = undefined;
    this.cancelTimers();
    this.detach();
    this.listeners.clear();
  }
}
