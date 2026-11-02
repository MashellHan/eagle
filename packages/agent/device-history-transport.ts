import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  HistoryKeyIdentity,
  HistoryServerFrame,
} from "../contracts/src/device-history.ts";
import type { DeviceCloud } from "./device-cloud.ts";
import { DeviceHistoryCipher } from "./device-history.ts";

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
  private renewal?: ReturnType<typeof setTimeout>;
  private recovery?: ReturnType<typeof setTimeout>;
  private noticeRetry?: ReturnType<typeof setTimeout>;
  private listeners = new Set<(event: HistoryLocalEvent) => void>();
  private detach: () => void;
  private incoming = 0;
  private closed = false;
  private readonly path: string;
  private readonly cloud: DeviceCloud;
  private readonly signer: (proof: HistoryKeyIdentity) => Promise<string>;
  constructor(
    cloud: DeviceCloud,
    directory: string,
    signer: (proof: HistoryKeyIdentity) => Promise<string>,
  ) {
    this.cloud = cloud;
    this.signer = signer;
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
        clearTimeout(this.renewal);
        clearTimeout(this.recovery);
        clearTimeout(this.noticeRetry);
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
    clearTimeout(this.renewal);
    clearTimeout(this.recovery);
    clearTimeout(this.noticeRetry);
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
      [
        "history_busy",
        "history_response_timeout",
        "history_delivery_failed",
        "history_rate_limit",
        "history_offline",
      ].includes(error.message)
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
    await this.cloud.historyRequest({
      type: "history.send",
      requestId,
      targetDeviceId,
      packet,
    });
    return { sent: true };
  }
  async notify() {
    if (this.enabled && this.cipher) {
      try {
        await this.cloud.historyRequest({
          type: "history.changed",
          requestId: randomUUID(),
        });
        clearTimeout(this.noticeRetry);
        this.noticeRetry = undefined;
      } catch (error) {
        if (!this.closed && this.transient(error) && !this.noticeRetry) {
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
        const payload = await cipher.open(event.source, event.packet);
        if (this.enabled && this.cipher === cipher && !this.closed)
          this.publish({
            type: "history.packet",
            sourceDeviceId: event.source.device.deviceId,
            payload,
          });
      } finally {
        this.incoming--;
      }
    }
  }
  close() {
    this.closed = true;
    this.generation++;
    this.cipher = undefined;
    clearTimeout(this.renewal);
    clearTimeout(this.recovery);
    clearTimeout(this.noticeRetry);
    this.detach();
    this.listeners.clear();
  }
}
