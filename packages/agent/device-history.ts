import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import {
  HISTORY_FRAME_BYTES,
  HISTORY_PLAINTEXT_BYTES,
  HistoryKeyIdentity,
  type HistoryKeyProof,
  HistoryPacket,
  HistoryPeer,
  historyKeyPayload,
  verifyHistoryPeer,
} from "../contracts/src/device-history.ts";
import {
  canonicalDeviceJSON,
  type Device,
  deviceDigest,
} from "../contracts/src/devices.ts";

const fingerprint = (proof: HistoryKeyProof) =>
  deviceDigest(`${historyKeyPayload(proof)}\n${proof.signature}`);

/** Ephemeral transport keys only; the native identity never leaves its trusted helper. */
export class DeviceHistoryCipher {
  readonly proof: HistoryKeyProof;
  readonly device: HistoryPeer["device"];
  private readonly key: KeyObject;
  private readonly serviceOrigin: string;
  private constructor(
    serviceOrigin: string,
    device: HistoryPeer["device"],
    proof: HistoryKeyProof,
    key: KeyObject,
  ) {
    this.serviceOrigin = serviceOrigin;
    this.device = device;
    this.proof = proof;
    this.key = key;
  }
  static async create(
    serviceOrigin: string,
    device: Device,
    signer: (proof: HistoryKeyIdentity) => Promise<string>,
  ): Promise<DeviceHistoryCipher> {
    if (!device.groupId || device.membershipEpoch <= 0)
      throw new Error("history_membership_unresolved");
    const pair = generateKeyPairSync("x25519");
    const identity = HistoryKeyIdentity.parse({
      purpose: "eagle-history-key-v1",
      serviceOrigin,
      deviceId: device.deviceId,
      groupId: device.groupId,
      membershipEpoch: device.membershipEpoch,
      ephemeralKey: pair.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url"),
      expiresAt: Date.now() + 120_000,
    });
    const proof = { ...identity, signature: await signer(identity) };
    const peer = HistoryPeer.parse({ device, proof });
    if (!(await verifyHistoryPeer(peer, serviceOrigin)))
      throw new Error("history_identity_invalid");
    return new DeviceHistoryCipher(
      serviceOrigin,
      peer.device,
      proof,
      pair.privateKey,
    );
  }
  private async authorize(peer: HistoryPeer) {
    if (
      peer.device.groupId !== this.device.groupId ||
      !(await verifyHistoryPeer(
        { device: peer.device, proof: peer.proof },
        this.serviceOrigin,
      )) ||
      !(await verifyHistoryPeer(
        { device: this.device, proof: this.proof },
        this.serviceOrigin,
      ))
    )
      throw new Error("history_peer_unauthorized");
  }
  private shared(peer: HistoryPeer): Buffer {
    const key = createPublicKey({
      key: Buffer.from(peer.proof.ephemeralKey, "base64url"),
      type: "spki",
      format: "der",
    });
    if (key.asymmetricKeyType !== "x25519")
      throw new Error("history_key_invalid");
    const secret = diffieHellman({ privateKey: this.key, publicKey: key });
    return Buffer.from(
      hkdfSync("sha256", secret, this.device.groupId, "eagle-history-v1", 32),
    );
  }
  async seal(
    target: HistoryPeer,
    requestId: string,
    input: unknown,
    purpose?: "endpoint" | "ack",
  ): Promise<HistoryPacket> {
    await this.authorize(target);
    const plaintext = Buffer.from(JSON.stringify(input));
    if (plaintext.length > HISTORY_PLAINTEXT_BYTES)
      throw new Error("history_payload_limit");
    const header = {
      version: 1 as const,
      ...(purpose === undefined ? {} : { purpose }),
      requestId,
      groupId: this.device.groupId,
      sourceDeviceId: this.device.deviceId,
      targetDeviceId: target.device.deviceId,
      sourceEpoch: this.device.membershipEpoch,
      targetEpoch: target.device.membershipEpoch,
      sourceKey: await fingerprint(this.proof),
      targetKey: await fingerprint(target.proof),
    };
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.shared(target), nonce);
    cipher.setAAD(Buffer.from(canonicalDeviceJSON(header)));
    const body = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const packet = HistoryPacket.parse({
      ...header,
      nonce: nonce.toString("base64url"),
      body: body.toString("base64url"),
    });
    if (Buffer.byteLength(JSON.stringify(packet)) > HISTORY_FRAME_BYTES - 4096)
      throw new Error("history_frame_limit");
    return packet;
  }
  async open(source: HistoryPeer, input: unknown): Promise<unknown> {
    await this.authorize(source);
    const packet = HistoryPacket.parse(input);
    if (
      packet.groupId !== this.device.groupId ||
      packet.sourceDeviceId !== source.device.deviceId ||
      packet.targetDeviceId !== this.device.deviceId ||
      packet.sourceEpoch !== source.device.membershipEpoch ||
      packet.targetEpoch !== this.device.membershipEpoch ||
      packet.sourceKey !== (await fingerprint(source.proof)) ||
      packet.targetKey !== (await fingerprint(this.proof))
    )
      throw new Error("history_packet_identity_mismatch");
    const { body, nonce, ...header } = packet;
    const bytes = Buffer.from(body, "base64url");
    if (bytes.length < 16 || bytes.length > HISTORY_PLAINTEXT_BYTES + 16)
      throw new Error("history_payload_limit");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.shared(source),
      Buffer.from(nonce, "base64url"),
    );
    decipher.setAAD(Buffer.from(canonicalDeviceJSON(header)));
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(0, -16)),
        decipher.final(),
      ]).toString(),
    );
  }
}
