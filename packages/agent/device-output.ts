import { redact } from "./collector.ts";
import type { OperationOutcome } from "./device-journal.ts";

function prefix(text: string, budget: number): string {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, Math.max(0, budget));
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
function sanitized(
  text: string,
  budget: number,
  secrets: string[],
  uncertain: boolean,
): string {
  const captured = prefix(text, budget);
  let clean = redact(captured, secrets);
  if (uncertain || captured.length !== text.length) {
    for (const secret of secrets) {
      if (!secret) continue;
      for (
        let length = Math.min(secret.length - 1, clean.length);
        length > 0;
        length--
      )
        if (clean.endsWith(secret.slice(0, length))) {
          clean = `${clean.slice(0, -length)}[REDACTED]`;
          break;
        }
    }
  }
  return prefix(clean, budget);
}
/** Bound each journal field before persistence, preserving UTF-8 and command redaction semantics. */
export function deviceOutcome(
  value: OperationOutcome,
  secrets: string[],
): OperationOutcome {
  return {
    ...value,
    stdout: sanitized(
      value.stdout,
      60 * 1024,
      secrets,
      value.state === "unknown",
    ),
    stderr: sanitized(
      value.stderr,
      4 * 1024,
      secrets,
      value.state === "unknown",
    ),
    exitCode: ["unknown", "cancelled"].includes(value.state)
      ? null
      : value.exitCode,
  };
}
