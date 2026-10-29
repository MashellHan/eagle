import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  DEVICE_PREFIX,
  type Device,
  type DeviceDirectory,
  DeviceId,
  DeviceProof,
  DeviceRegistration,
  deviceBase64,
  deviceDigest,
  PairingCode,
  PairingCreate,
  PairingRedeem,
  verifyDeviceSignature,
} from "../../../../packages/contracts/src/devices.ts";

export class DeviceHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const deviceJSON = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export function deviceFailure(error: unknown): Response {
  if (error instanceof DeviceHttpError)
    return deviceJSON({ error: error.message }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return deviceJSON({ error: "invalid_request" }, 400);
  return deviceJSON({ error: "internal_error" }, 500);
}
export async function deviceBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new DeviceHttpError(415, "expected_json");
  const reader = request.body?.getReader();
  if (!reader) throw new DeviceHttpError(400, "missing_body");
  let content = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 524288) {
      await reader.cancel();
      throw new DeviceHttpError(413, "body_too_large");
    }
    content += decoder.decode(value, { stream: true });
  }
  content += decoder.decode();
  return JSON.parse(content);
}
type DeviceRow = {
  deviceId: string;
  publicKey: string;
  name: string;
  platform: string;
  arch: string;
  groupId: string | null;
  membershipEpoch: number;
  credentialVersion: number;
};
type Challenge = {
  id: string;
  payload: string;
  registration: string;
  expires: number;
};
type Pairing = {
  hash: string;
  issuer: string;
  epoch: number;
  expires: number;
  revoked: number;
  redeemer: string | null;
  result: string | null;
};
export class DeviceRegistry extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS devices(deviceId TEXT PRIMARY KEY,publicKey TEXT NOT NULL,name TEXT NOT NULL,platform TEXT NOT NULL,arch TEXT NOT NULL,groupId TEXT,membershipEpoch INTEGER NOT NULL DEFAULT 0,credentialVersion INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS groups(groupId TEXT PRIMARY KEY,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,payload TEXT NOT NULL,registration TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,deviceId TEXT NOT NULL,version INTEGER NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pairings(hash TEXT PRIMARY KEY,issuer TEXT NOT NULL,epoch INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,redeemer TEXT,result TEXT);
    CREATE TABLE IF NOT EXISTS pairing_results(deviceId TEXT NOT NULL,requestId TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(deviceId,requestId));
    CREATE TABLE IF NOT EXISTS rates(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until INTEGER NOT NULL);
  `);
  }
  private one<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...values: SqlStorageValue[]
  ): T | undefined {
    return this.ctx.storage.sql.exec<T>(query, ...values).toArray()[0];
  }
  private device(id: string): DeviceRow {
    const row = this.one<DeviceRow>(
      "SELECT * FROM devices WHERE deviceId=?",
      id,
    );
    if (!row) throw new DeviceHttpError(401, "unknown_device");
    return row;
  }
  private limit(key: string, max: number): void {
    const now = Date.now();
    const previous = this.one<{ count: number; until: number }>(
      "SELECT count,until FROM rates WHERE key=?",
      key,
    );
    if (previous && previous.until > now && previous.count >= max)
      throw new DeviceHttpError(429, "rate_limited");
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO rates VALUES(?,?,?)",
      key,
      previous && previous.until > now ? previous.count + 1 : 1,
      previous && previous.until > now ? previous.until : now + 60000,
    );
  }
  async authenticate(token: string): Promise<Device> {
    if (token.length > 200) throw new DeviceHttpError(401, "invalid_session");
    const hash = await deviceDigest(token);
    const session = this.one<{
      deviceId: string;
      version: number;
      expires: number;
    }>("SELECT deviceId,version,expires FROM sessions WHERE hash=?", hash);
    if (!session || session.expires <= Date.now())
      throw new DeviceHttpError(401, "invalid_session");
    const device = this.device(session.deviceId);
    if (device.credentialVersion !== session.version)
      throw new DeviceHttpError(401, "revoked_session");
    return device;
  }
  async authorize(
    token: string,
    targetId: string,
  ): Promise<{ source: Device; target: Device }> {
    const source = await this.authenticate(token);
    const target = this.device(targetId);
    if (
      source.deviceId !== target.deviceId &&
      (!source.groupId || source.groupId !== target.groupId)
    )
      throw new DeviceHttpError(403, "different_group");
    return { source, target };
  }
  async check(
    token: string,
    targetId?: string,
  ): Promise<
    | { ok: true; source: Device; target: Device }
    | { ok: false; status: number; error: string }
  > {
    try {
      const source = await this.authenticate(token);
      if (!targetId) return { ok: true, source, target: source };
      return { ok: true, ...(await this.authorize(token, targetId)) };
    } catch (error) {
      return {
        ok: false,
        status: error instanceof DeviceHttpError ? error.status : 401,
        error:
          error instanceof DeviceHttpError ? error.message : "invalid_session",
      };
    }
  }
  private async observedDirectory(id: string): Promise<DeviceDirectory> {
    const directory = this.directory(id);
    if (!this.env.DEVICE_EXECUTION) return directory;
    directory.devices = await Promise.all(
      directory.devices.map(async (device) => {
        try {
          return {
            ...device,
            ...(await this.env.DEVICE_EXECUTION.getByName(
              device.deviceId,
            ).observation()),
          };
        } catch {
          return device;
        }
      }),
    );
    return directory;
  }
  directory(id: string): DeviceDirectory {
    const self = this.device(id);
    const devices = self.groupId
      ? this.ctx.storage.sql
          .exec<DeviceRow>(
            "SELECT * FROM devices WHERE groupId=? ORDER BY deviceId",
            self.groupId,
          )
          .toArray()
      : [self];
    const revision = self.groupId
      ? (this.one<{ revision: number }>(
          "SELECT revision FROM groups WHERE groupId=?",
          self.groupId,
        )?.revision ?? 0)
      : self.membershipEpoch;
    return {
      localDeviceId: id,
      groupId: self.groupId,
      revision,
      devices: devices.map((device) => ({
        ...device,
        online: null,
        lastSeenAt: null,
        capabilities: null,
        policy: null,
      })),
    };
  }
  private result(id: string, result: string): unknown {
    return { ...JSON.parse(result), directory: this.directory(id) };
  }
  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      return deviceFailure(error);
    }
  }
  private async route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.slice(DEVICE_PREFIX.length);
    const post = request.method === "POST";
    if (path === "/register/challenge" && post) {
      const input = DeviceRegistration.parse(await deviceBody(request));
      try {
        await crypto.subtle.importKey(
          "spki",
          Uint8Array.from(
            atob(input.publicKey.replaceAll("-", "+").replaceAll("_", "/")),
            (c) => c.charCodeAt(0),
          ),
          { name: "Ed25519" },
          false,
          ["verify"],
        );
      } catch {
        throw new DeviceHttpError(400, "invalid_public_key");
      }
      this.limit(
        `registration:${request.headers.get("CF-Connecting-IP") ?? "local"}`,
        120,
      );
      const existing = this.one<DeviceRow>(
        "SELECT * FROM devices WHERE deviceId=?",
        input.deviceId,
      );
      if (existing && existing.publicKey !== input.publicKey)
        throw new DeviceHttpError(409, "identity_conflict");
      if (
        !existing &&
        (this.one<{ count: number }>("SELECT count(*) AS count FROM devices")
          ?.count ?? 0) >= 10000
      )
        throw new DeviceHttpError(429, "device_quota");
      this.ctx.storage.sql.exec(
        "DELETE FROM challenges WHERE expires<=?",
        Date.now(),
      );
      const challengeId = crypto.randomUUID();
      const expiresAt = Date.now() + 60000;
      const payload = `eagle-device-register-v1\n${new URL(request.url).origin}\n${input.deviceId}\n${input.publicKey}\n${challengeId}\n${deviceBase64(crypto.getRandomValues(new Uint8Array(32)))}\n${expiresAt}`;
      this.ctx.storage.sql.exec(
        "INSERT INTO challenges VALUES(?,?,?,?)",
        challengeId,
        payload,
        JSON.stringify(input),
        expiresAt,
      );
      return deviceJSON({ challengeId, payload, expiresAt });
    }
    if (path === "/register/complete" && post) {
      const input = DeviceProof.parse(await deviceBody(request));
      const challenge = this.one<Challenge>(
        "SELECT * FROM challenges WHERE id=?",
        input.challengeId,
      );
      if (!challenge || challenge.expires <= Date.now())
        throw new DeviceHttpError(401, "invalid_challenge");
      const registration = DeviceRegistration.parse(
        JSON.parse(challenge.registration),
      );
      if (
        !(await verifyDeviceSignature(
          registration.publicKey,
          challenge.payload,
          input.signature,
        ))
      )
        throw new DeviceHttpError(401, "invalid_proof");
      const sessionToken = deviceBase64(
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const hash = await deviceDigest(sessionToken);
      const expiresAt = Date.now() + 900000;
      const device = this.ctx.storage.transactionSync(() => {
        const active = this.one<Challenge>(
          "SELECT * FROM challenges WHERE id=?",
          input.challengeId,
        );
        if (!active || active.expires <= Date.now())
          throw new DeviceHttpError(401, "invalid_challenge");
        const previous = this.one<DeviceRow>(
          "SELECT * FROM devices WHERE deviceId=?",
          registration.deviceId,
        );
        if (previous && previous.publicKey !== registration.publicKey)
          throw new DeviceHttpError(409, "identity_conflict");
        this.ctx.storage.sql.exec(
          "INSERT INTO devices(deviceId,publicKey,name,platform,arch) VALUES(?,?,?,?,?) ON CONFLICT(deviceId) DO UPDATE SET name=excluded.name,platform=excluded.platform,arch=excluded.arch",
          registration.deviceId,
          registration.publicKey,
          registration.name,
          registration.platform,
          registration.arch,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM challenges WHERE id=?",
          input.challengeId,
        );
        const device = this.device(registration.deviceId);
        this.ctx.storage.sql.exec(
          "DELETE FROM sessions WHERE expires<=?",
          Date.now(),
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO sessions VALUES(?,?,?,?)",
          hash,
          device.deviceId,
          device.credentialVersion,
          expiresAt,
        );
        return device;
      });
      return deviceJSON({ device, sessionToken, expiresAt });
    }
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer (.+)$/)?.[1];
    if (!token) throw new DeviceHttpError(401, "session_required");
    const self = await this.authenticate(token);
    if (path === "/directory" && request.method === "GET")
      return deviceJSON(await this.observedDirectory(self.deviceId));
    if (path === "/pairings" && post) {
      const { ttlSeconds } = PairingCreate.parse(await deviceBody(request));
      const code = deviceBase64(crypto.getRandomValues(new Uint8Array(32)));
      const hash = await deviceDigest(code);
      const expiresAt = Date.now() + ttlSeconds * 1000;
      this.limit(`invite:${self.deviceId}`, 20);
      const current = this.device(self.deviceId);
      this.ctx.storage.sql.exec(
        "INSERT INTO pairings(hash,issuer,epoch,expires) VALUES(?,?,?,?)",
        hash,
        self.deviceId,
        current.membershipEpoch,
        expiresAt,
      );
      return deviceJSON({ code, expiresAt });
    }
    if (path === "/pairings/revoke" && post) {
      const { code } = z
        .strictObject({ code: PairingCode })
        .parse(await deviceBody(request));
      const hash = await deviceDigest(code);
      const pairing = this.one<Pairing>(
        "SELECT * FROM pairings WHERE hash=?",
        hash,
      );
      if (!pairing || pairing.issuer !== self.deviceId)
        throw new DeviceHttpError(404, "pairing_not_found");
      this.ctx.storage.sql.exec(
        "UPDATE pairings SET revoked=1 WHERE hash=?",
        hash,
      );
      return deviceJSON({ revoked: true });
    }
    if (path === "/pairings/redeem" && post) {
      const { requestId, code } = PairingRedeem.parse(
        await deviceBody(request),
      );
      const hash = await deviceDigest(code);
      this.limit(`redeem:${self.deviceId}`, 30);
      const result = this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "DELETE FROM pairing_results WHERE created<?",
          Date.now() - 604800000,
        );
        const previous = this.one<{ hash: string; result: string }>(
          "SELECT hash,result FROM pairing_results WHERE deviceId=? AND requestId=?",
          self.deviceId,
          requestId,
        );
        if (previous) {
          if (previous.hash !== hash)
            throw new DeviceHttpError(409, "request_conflict");
          return previous.result;
        }
        const pairing = this.one<Pairing>(
          "SELECT * FROM pairings WHERE hash=?",
          hash,
        );
        if (!pairing) throw new DeviceHttpError(410, "pairing_unavailable");
        if (pairing.redeemer) {
          if (pairing.redeemer !== self.deviceId || !pairing.result)
            throw new DeviceHttpError(409, "pairing_consumed");
          const recovered = JSON.stringify({
            ...JSON.parse(pairing.result),
            requestId,
          });
          this.ctx.storage.sql.exec(
            "INSERT INTO pairing_results VALUES(?,?,?,?,?)",
            self.deviceId,
            requestId,
            hash,
            recovered,
            Date.now(),
          );
          return recovered;
        }
        const issuer = this.device(pairing.issuer);
        const redeemer = this.device(self.deviceId);
        if (
          pairing.revoked ||
          pairing.expires <= Date.now() ||
          issuer.membershipEpoch !== pairing.epoch
        )
          throw new DeviceHttpError(410, "pairing_unavailable");
        if (issuer.deviceId === redeemer.deviceId)
          throw new DeviceHttpError(400, "self_pairing");
        if (
          issuer.groupId &&
          redeemer.groupId &&
          issuer.groupId !== redeemer.groupId
        )
          throw new DeviceHttpError(409, "group_conflict");
        const groupId =
          issuer.groupId ?? redeemer.groupId ?? crypto.randomUUID();
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO groups VALUES(?,0)",
          groupId,
        );
        let changed = false;
        for (const device of [issuer, redeemer])
          if (device.groupId !== groupId) {
            this.ctx.storage.sql.exec(
              "UPDATE devices SET groupId=?,membershipEpoch=membershipEpoch+1 WHERE deviceId=?",
              groupId,
              device.deviceId,
            );
            changed = true;
          }
        if (changed)
          this.ctx.storage.sql.exec(
            "UPDATE groups SET revision=revision+1 WHERE groupId=?",
            groupId,
          );
        const result = JSON.stringify({ requestId, groupId });
        this.ctx.storage.sql.exec(
          "UPDATE pairings SET redeemer=?,result=? WHERE hash=?",
          self.deviceId,
          result,
          hash,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO pairing_results VALUES(?,?,?,?,?)",
          self.deviceId,
          requestId,
          hash,
          result,
          Date.now(),
        );
        return result;
      });
      return deviceJSON(this.result(self.deviceId, result));
    }
    if (path.startsWith("/pairings/results/") && request.method === "GET") {
      const requestId = DeviceId.parse(path.slice("/pairings/results/".length));
      const result = this.one<{ result: string; created: number }>(
        "SELECT result,created FROM pairing_results WHERE deviceId=? AND requestId=?",
        self.deviceId,
        requestId,
      );
      if (!result || result.created < Date.now() - 604800000)
        throw new DeviceHttpError(404, "result_not_found");
      return deviceJSON(this.result(self.deviceId, result.result));
    }
    if (path === "/members/remove" && post) {
      const { deviceId } = z
        .strictObject({ deviceId: DeviceId })
        .parse(await deviceBody(request));
      this.ctx.storage.transactionSync(() => {
        const source = this.device(self.deviceId);
        const target = this.device(deviceId);
        if (!source.groupId || source.groupId !== target.groupId)
          throw new DeviceHttpError(403, "different_group");
        this.ctx.storage.sql.exec(
          "UPDATE groups SET revision=revision+1 WHERE groupId=?",
          target.groupId,
        );
        this.ctx.storage.sql.exec(
          "UPDATE devices SET groupId=NULL,membershipEpoch=membershipEpoch+1,credentialVersion=credentialVersion+1 WHERE deviceId=?",
          deviceId,
        );
      });
      return deviceJSON(await this.observedDirectory(self.deviceId));
    }
    throw new DeviceHttpError(404, "not_found");
  }
}
