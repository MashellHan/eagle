import { z } from "zod";
import { DeviceId } from "./devices.ts";

export const SyncIdentity = z.strictObject({
  deviceId: DeviceId,
  publicKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(2048),
  groupId: DeviceId.nullable(),
  membershipEpoch: z.number().int().nonnegative(),
  credentialVersion: z.number().int().positive(),
});
export const SyncAccess = z.strictObject({
  sharedBotId: DeviceId,
  peerDeviceId: DeviceId,
  purpose: z.literal("replica.read"),
});
export const SyncShare = SyncAccess.omit({ purpose: true }).extend({
  enabled: z.boolean(),
});
export const SyncPort = z.number().int().min(1).max(65535).nullable();
export const SyncPublish = z.strictObject({ syncPort: SyncPort });
export const TailscaleAddress = z.union([z.ipv4(), z.ipv6()]).refine((ip) => {
  if (ip.includes(":")) return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
});
export const SyncCandidate = z.strictObject({
  address: TailscaleAddress,
  port: z.number().int().min(1).max(65535),
});
export const SyncEndpoints = z.strictObject({
  identity: SyncIdentity,
  publishedAt: z.number().int().positive(),
  candidates: z.array(SyncCandidate).max(8),
});
export const SyncIdentityResult = z.strictObject({
  version: z.literal(1),
  identity: SyncIdentity,
});
export const SyncAccessResult = z.strictObject({
  version: z.literal(1),
  sharedBotId: DeviceId,
  purpose: z.literal("replica.read"),
  local: SyncIdentity,
  peer: SyncIdentity,
  endpoints: SyncEndpoints.nullable(),
});
