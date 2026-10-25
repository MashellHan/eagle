// Failure identities for core (docs/bots/OBSERVABILITY.md): one per episode, minted where
// the failure is classified and carried upward unchanged.
import { randomUUID } from "node:crypto";
import type { ErrorKind, Failure } from "./domain.ts";

export const newFailure = (kind: ErrorKind, layer: Failure["layer"] = "core"): Failure => ({
  id: `f_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  kind,
  layer,
});
