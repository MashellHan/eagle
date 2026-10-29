import { z } from "zod";

export const DeviceId = z.uuid();
const encoded = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(2048);
export const DeviceRegistration = z.strictObject({
  deviceId: DeviceId,
  publicKey: encoded,
  name: z.string().min(1).max(100),
  platform: z.string().min(1).max(30),
  arch: z.string().min(1).max(30),
});
export const DeviceProof = z.strictObject({
  challengeId: DeviceId,
  signature: encoded,
});
export const PairingCreate = z.strictObject({
  ttlSeconds: z.number().int().min(1).max(86400).default(3600),
});
export const PairingCode = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const PairingRedeem = z.strictObject({
  requestId: DeviceId,
  code: PairingCode,
});
export const DeviceOperation = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("native"),
    tool: z.string().min(1).max(120),
    args: z.record(z.string(), z.unknown()),
    cwd: z.string().max(4096).optional(),
  }),
  z.strictObject({
    kind: z.literal("command"),
    command: z.string().min(1).max(65536),
    cwd: z.string().max(4096).optional(),
    timeoutMs: z.number().int().min(1).max(300000).optional(),
  }),
  z.strictObject({
    kind: z.literal("file.read"),
    path: z.string().min(1).max(4096),
  }),
  z.strictObject({
    kind: z.literal("file.write"),
    path: z.string().min(1).max(4096),
    content: z.string().max(262144),
  }),
  z.strictObject({
    kind: z.literal("file.list"),
    path: z.string().min(1).max(4096),
  }),
]);
export const DevicePolicy = z.strictObject({
  mode: z.enum(["all-approve", "always-ask", "paused"]),
  version: z.number().int().positive(),
});
export type DevicePolicy = z.infer<typeof DevicePolicy>;
export const DeviceApproval = z.strictObject({
  operationId: DeviceId,
  sourceDeviceId: DeviceId,
  targetDeviceId: DeviceId,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  signature: encoded,
});
export type DeviceApproval = z.infer<typeof DeviceApproval>;
export const OperationRequest = z
  .strictObject({
    sourceBotId: z.string().min(1).max(120).optional(),
    requestId: DeviceId,
    operationId: DeviceId,
    targetDeviceId: DeviceId,
    action: z.enum(["run", "get", "cancel"]),
    operation: DeviceOperation.optional(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    approval: DeviceApproval.optional(),
  })
  .superRefine((request, ctx) => {
    if (request.action === "run" && (!request.operation || !request.digest))
      ctx.addIssue({
        code: "custom",
        message: "run requires operation and digest",
      });
  });
export type OperationRequest = z.infer<typeof OperationRequest>;
export const OperationResult = z.strictObject({
  status: z.enum([
    "running",
    "completed",
    "failed",
    "cancelled",
    "unknown",
    "busy",
    "denied",
  ]),
  output: z.string().max(262144).optional(),
  error: z.string().max(4096).optional(),
  exitCode: z.number().int().nullable().optional(),
});
export type OperationResult = z.infer<typeof OperationResult>;
export type Device = z.infer<typeof DeviceRegistration> & {
  groupId: string | null;
  membershipEpoch: number;
  credentialVersion: number;
};
export type DeviceDirectory = {
  localDeviceId: string;
  groupId: string | null;
  revision: number;
  devices: Device[];
};
export const DEVICE_PREFIX = "/api/devices/v1";
export function canonicalDeviceJSON(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalDeviceJSON).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalDeviceJSON(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function deviceDigest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function deviceBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function deviceBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
export function approvalPayload(
  approval: Omit<DeviceApproval, "signature">,
): string {
  return `eagle-device-approval-v1\n${approval.operationId}\n${approval.sourceDeviceId}\n${approval.targetDeviceId}\n${approval.digest}\n${approval.policyVersion}\n${approval.expiresAt}`;
}
export async function verifyDeviceSignature(
  publicKey: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      deviceBytes(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      deviceBytes(signature),
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}
export async function verifyApproval(
  approval: DeviceApproval | undefined,
  request: OperationRequest,
  source: Device,
  policy: DevicePolicy,
): Promise<boolean> {
  if (
    !approval ||
    approval.operationId !== request.operationId ||
    approval.sourceDeviceId !== source.deviceId ||
    approval.targetDeviceId !== request.targetDeviceId ||
    approval.digest !== request.digest ||
    approval.policyVersion !== policy.version ||
    approval.expiresAt <= Date.now() ||
    approval.expiresAt > Date.now() + 300000
  )
    return false;
  return verifyDeviceSignature(
    source.publicKey,
    approvalPayload(approval),
    approval.signature,
  );
}
