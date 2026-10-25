// Failure identities for the wire layers (docs/bots/OBSERVABILITY.md): a transport or
// protocol refusal is its own episode, minted here and never re-minted upward.
import { randomUUID } from "node:crypto";
import type { ErrorKind, Failure } from "../core/domain.ts";

export const serverFailure = (kind: ErrorKind, layer: "transport" | "protocol"): Failure => ({
  id: `f_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  kind,
  layer,
});
