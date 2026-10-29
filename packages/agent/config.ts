import { z } from "zod";
import {
  SlowIntervalSchema,
  WatchPortsSchema,
} from "../contracts/src/schema.ts";

export const ConfigSchema = z.strictObject({
  url: z.string().url(),
  ownerOrigin: z.string().url().optional(),
  token: z.string().min(32),
  machineId: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  machineName: z.string().min(1),
  intervalSeconds: z.literal(30).default(30),
  slowIntervalSeconds: SlowIntervalSchema,
  codexDir: z.string().optional(),
  spoolDir: z.string().optional(),
  watchPorts: WatchPortsSchema.default([]),
  execution: z
    .strictObject({
      commands: z.boolean().default(false),
      workingDirectory: z.string().min(1).optional(),
    })
    .optional(),
});
