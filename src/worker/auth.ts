import { timingSafeEqual } from "node:crypto";

const encoder = new TextEncoder();
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const hashes = await Promise.all(
    [a, b].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s))),
  );
  return timingSafeEqual(new Uint8Array(hashes[0]), new Uint8Array(hashes[1]));
}
export function bearer(request: Request) {
  return (
    request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1] ?? ""
  );
}
export function agentTokens(env: Env): Record<string, string> {
  const parsed: unknown = JSON.parse(env.AGENT_TOKENS);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((t) => typeof t === "string" && t.length >= 32)
  )
    throw new Error("Invalid authentication configuration");
  return parsed as Record<string, string>;
}
export async function agentIdentity(request: Request, env: Env) {
  const token = bearer(request);
  if (!token) return null;
  for (const [id, value] of Object.entries(agentTokens(env)))
    if (await equalSecret(token, value)) return id;
  return null;
}
async function sign(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function sessionValue(secret: string) {
  const payload = `${Date.now() + 43_200_000}.${crypto.randomUUID()}`;
  return `${payload}.${await sign(payload, secret)}`;
}
export async function viewerAuthorized(request: Request, env: Env) {
  if (!env.VIEWER_TOKEN || env.VIEWER_TOKEN.length < 32) return false;
  const token = bearer(request);
  if (token && (await equalSecret(token, env.VIEWER_TOKEN))) return true;
  const cookie = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)eagle_session=([^;]+)/)?.[1];
  if (!cookie) return false;
  const [expires, nonce, signature, extra] = cookie.split(".");
  if (
    extra ||
    !nonce ||
    !signature ||
    !/^\d+$/.test(expires) ||
    Number(expires) <= Date.now() ||
    Number(expires) > Date.now() + 43_200_000
  )
    return false;
  return equalSecret(
    signature,
    await sign(`${expires}.${nonce}`, env.VIEWER_TOKEN),
  );
}
export const cookieFor = (value: string, age = 43200) =>
  `eagle_session=${value}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
