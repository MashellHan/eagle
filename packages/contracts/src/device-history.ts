import { z } from "zod";
import {
  DeviceId,
  DeviceRegistration,
  verifyDeviceSignature,
} from "./devices.ts";

export const HISTORY_PLAINTEXT_BYTES = 128 * 1024;
export const HISTORY_FRAME_BYTES = 192 * 1024;
export const HISTORY_QUEUE_FRAMES = 2;
const encoded = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const HistoryKeyIdentity = z.strictObject({
  purpose: z.literal("eagle-history-key-v1"),
  serviceOrigin: z.url().refine((value) => new URL(value).origin === value),
  deviceId: DeviceId,
  groupId: DeviceId,
  membershipEpoch: z.number().int().positive(),
  ephemeralKey: encoded.length(59).startsWith("MCowBQYDK2VuAyEA"),
  expiresAt: z.number().int().positive(),
});
export type HistoryKeyIdentity = z.infer<typeof HistoryKeyIdentity>;
export const HistoryKeyProof = HistoryKeyIdentity.extend({
  signature: encoded.length(86),
});
export type HistoryKeyProof = z.infer<typeof HistoryKeyProof>;
export const HistoryPeer = z.strictObject({
  device: z.object({
    ...DeviceRegistration.shape,
    groupId: DeviceId,
    membershipEpoch: z.number().int().positive(),
    credentialVersion: z.number().int().positive(),
  }),
  proof: HistoryKeyProof,
});
export type HistoryPeer = z.infer<typeof HistoryPeer>;
export const historyKeyPayload = (proof: HistoryKeyIdentity): string =>
  [
    proof.purpose,
    proof.serviceOrigin,
    proof.deviceId,
    proof.groupId,
    String(proof.membershipEpoch),
    proof.ephemeralKey,
    String(proof.expiresAt),
  ].join("\n");
export const verifyHistoryPeer = async (
  input: unknown,
  serviceOrigin: string,
  now = Date.now(),
): Promise<boolean> => {
  const parsed = HistoryPeer.safeParse(input);
  if (!parsed.success) return false;
  const { device, proof } = parsed.data;
  return (
    proof.serviceOrigin === serviceOrigin &&
    proof.deviceId === device.deviceId &&
    proof.groupId === device.groupId &&
    proof.membershipEpoch === device.membershipEpoch &&
    proof.expiresAt > now &&
    proof.expiresAt <= now + 300_000 &&
    (await verifyDeviceSignature(
      device.publicKey,
      historyKeyPayload(proof),
      proof.signature,
    ))
  );
};
export const HistoryPacket = z.strictObject({
  version: z.literal(1),
  requestId: DeviceId,
  groupId: DeviceId,
  sourceDeviceId: DeviceId,
  targetDeviceId: DeviceId,
  sourceEpoch: z.number().int().positive(),
  targetEpoch: z.number().int().positive(),
  sourceKey: z.string().regex(/^[a-f0-9]{64}$/),
  targetKey: z.string().regex(/^[a-f0-9]{64}$/),
  nonce: encoded.length(16),
  body: encoded.max(Math.ceil(((HISTORY_PLAINTEXT_BYTES + 16) * 4) / 3)),
});
export type HistoryPacket = z.infer<typeof HistoryPacket>;
export const HistoryAgentFrame = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("history.configure"),
    requestId: DeviceId,
    proof: HistoryKeyProof.nullable(),
  }),
  z.strictObject({ type: z.literal("history.peers"), requestId: DeviceId }),
  z.strictObject({ type: z.literal("history.changed"), requestId: DeviceId }),
  z.strictObject({
    type: z.literal("history.send"),
    requestId: DeviceId,
    targetDeviceId: DeviceId,
    packet: HistoryPacket,
  }),
]);
export type HistoryAgentFrame = z.infer<typeof HistoryAgentFrame>;
export const HistoryServerFrame = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("history.configured"),
    requestId: DeviceId,
  }),
  z.strictObject({
    type: z.literal("history.peers"),
    requestId: DeviceId,
    peers: z.array(HistoryPeer).max(32),
  }),
  z.strictObject({ type: z.literal("history.changed"), source: HistoryPeer }),
  z.strictObject({
    type: z.literal("history.packet"),
    source: HistoryPeer,
    packet: HistoryPacket,
  }),
  z.strictObject({ type: z.literal("history.sent"), requestId: DeviceId }),
  z.strictObject({
    type: z.literal("history.error"),
    requestId: DeviceId,
    error: z.string().regex(/^[a-z][a-z0-9_]{0,80}$/),
  }),
]);
export type HistoryServerFrame = z.infer<typeof HistoryServerFrame>;
export const isHistoryFrame = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string" &&
  value.type.startsWith("history.");
