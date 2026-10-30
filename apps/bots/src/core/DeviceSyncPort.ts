import { z } from "zod";

const identity = z.strictObject({
  deviceId: z.uuid(),
  publicKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(2048),
  groupId: z.uuid().nullable(),
  membershipEpoch: z.number().int().nonnegative(),
  credentialVersion: z.number().int().positive(),
});
export const deviceSyncInput = z.strictObject({
  peerDeviceId: z.uuid().toLowerCase(),
  purpose: z.literal("replica.read"),
});
const address = z.union([z.ipv4(), z.ipv6()]).refine((ip) => {
  if (ip.includes(":")) return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
});
export const deviceSyncIdentity = z.strictObject({ version: z.literal(1), identity });
export const deviceSyncAccess = z.strictObject({
  version: z.literal(1),
  sharedBotId: z.uuid(),
  purpose: z.literal("replica.read"),
  local: identity,
  peer: identity,
  endpoints: z
    .strictObject({
      identity,
      publishedAt: z.number().int().positive(),
      candidates: z
        .array(z.strictObject({ address, port: z.number().int().min(1).max(65535) }))
        .max(8),
    })
    .nullable(),
});

/** Metadata only, independently versioned from the host execution port. */
export interface DeviceSyncPort {
  readonly version: 1;
  identity(context: { trace: string; botId: string }): Promise<z.infer<typeof deviceSyncIdentity>>;
  access(
    input: z.infer<typeof deviceSyncInput> & { sharedBotId: string },
    context: { trace: string; botId: string },
  ): Promise<z.infer<typeof deviceSyncAccess>>;
}
