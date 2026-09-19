import { z } from "zod";

const id = z.string().min(1).max(160);
export const SubscriptionSchema = z.strictObject({
  spaceId: id,
  subscriptionId: id,
});
export type Subscription = z.infer<typeof SubscriptionSchema>;
export const LivePaneSchema = z.strictObject({
  id,
  terminalId: id,
  title: z.string().max(240),
  rect: z.strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  }),
});
export const TopologySchema = SubscriptionSchema.extend({
  type: z.literal("topology"),
  tabs: z
    .array(
      z.strictObject({
        id,
        name: z.string().max(240),
        panes: z.array(LivePaneSchema).max(32),
      }),
    )
    .max(16),
}).refine((v) => v.tabs.reduce((n, t) => n + t.panes.length, 0) <= 32);
export type LiveTopology = z.infer<typeof TopologySchema>;
export const InputSchema = z
  .strictObject({
    type: z.literal("input"),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    paneId: id,
    terminalId: id,
    text: z.string().max(8000).default(""),
    keys: z
      .array(
        z.enum([
          "enter",
          "esc",
          "tab",
          "shift+tab",
          "backspace",
          "delete",
          "up",
          "down",
          "left",
          "right",
          "home",
          "end",
          "pageup",
          "pagedown",
          "ctrl+c",
          "ctrl+d",
          "ctrl+l",
        ]),
      )
      .max(4)
      .default([]),
  })
  .refine((v) => v.text.length > 0 || v.keys.length > 0);
export type LiveInput = z.infer<typeof InputSchema>;
export const ViewerMessageSchema = z.union([
  InputSchema,
  z.strictObject({ type: z.enum(["ping", "control", "release"]) }),
]);
export const FrameSchema = SubscriptionSchema.extend({
  type: z.literal("frame"),
  paneId: id,
  terminalId: id,
  revision: z.number().int().nonnegative(),
  text: z.string().max(32000),
  observedAt: z.string().datetime(),
});
export const AckSchema = z.strictObject({
  type: z.literal("ack"),
  clientId: id,
  seq: z.number().int().positive(),
  status: z.enum(["delivered", "rejected", "unknown"]),
});
export const AgentMessageSchema = z.union([
  TopologySchema,
  FrameSchema,
  AckSchema,
  SubscriptionSchema.extend({ type: z.literal("unavailable") }),
  z.strictObject({ type: z.literal("ping") }),
]);
export const BridgeMessageSchema = z.union([
  z.strictObject({
    type: z.literal("subscriptions"),
    spaces: z.array(SubscriptionSchema).max(4),
  }),
  InputSchema.safeExtend({ ...SubscriptionSchema.shape, clientId: id }),
  z.strictObject({ type: z.literal("pong") }),
]);
export const LiveServerMessageSchema = z.union([
  TopologySchema,
  FrameSchema,
  AckSchema.omit({ clientId: true }),
  z.strictObject({
    type: z.literal("status"),
    online: z.boolean(),
    control: z.boolean(),
  }),
  z.strictObject({ type: z.literal("pong") }),
]);
export type LiveFrame = z.infer<typeof FrameSchema>;
