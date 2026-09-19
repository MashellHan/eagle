import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

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
// Public key caches contain no user credentials and follow Access key rotation.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function viewerAuthorized(request: Request, env: Env) {
  const host = new URL(request.url).hostname;
  if (
    env.LOCAL_DEV === "true" &&
    ["localhost", "127.0.0.1", "[::1]", "eagle.dev.hexly.ai"].includes(host)
  )
    return true;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_URL || !env.ACCESS_AUD) return false;
  try {
    if (!keySets.has(env.ACCESS_TEAM_URL))
      keySets.set(
        env.ACCESS_TEAM_URL,
        createRemoteJWKSet(
          new URL(`${env.ACCESS_TEAM_URL}/cdn-cgi/access/certs`),
        ),
      );
    const keys = keySets.get(env.ACCESS_TEAM_URL);
    if (!keys) return false;
    await jwtVerify(token, keys, {
      issuer: env.ACCESS_TEAM_URL,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
    });
    return true;
  } catch {
    return false;
  }
}
