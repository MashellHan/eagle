// Loopback bearer authentication (docs/bots/PROTOCOL.md "Transport"). The token lives in
// `<root>/token`, mode 0600, generated on first start; a comparison is constant time and a
// missing token never authenticates.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 32 random bytes, base64url: long enough that a bearer guess is hopeless. */
export const TOKEN_BYTES = 32;

export const generateToken = (): string => randomBytes(TOKEN_BYTES).toString("base64url");

/** Reads the token, creating it with mode 0600 when the file does not exist yet. */
export const loadToken = async (root: string): Promise<string> => {
  const path = join(root, "token");
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // fall through to creation
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const token = generateToken();
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return token;
};

/** `Authorization: Bearer <token>` → the token, or undefined when the header is absent. */
export const parseBearer = (header: string | undefined): string | undefined => {
  if (header === undefined) return undefined;
  const match = /^Bearer (\S+)$/.exec(header.trim());
  return match?.[1];
};

/** Constant-time equality; a length difference is a mismatch without leaking more. */
export const tokenMatches = (expected: string, presented: string | undefined): boolean => {
  if (presented === undefined) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};
