import { ExecutionMachineId } from "../../../../packages/contracts/src/execution.ts";
import { agentIdentity, authenticateViewer } from "./auth.ts";

const failure = (status: number, error: string) =>
  Response.json(
    { error },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );

/** Authenticated production entry, kept independent of reporting/AI handlers. */
export async function executionRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (
    ![
      "/api/v1/execution",
      "/api/v1/execution-agent",
      "/api/v1/execution/status",
    ].includes(path)
  )
    return null;
  const agent = path === "/api/v1/execution-agent";
  const status = path.endsWith("/status");
  if (url.hostname === "eagle-ingest.hexly.ai" && !agent)
    return failure(404, "Not found");
  if (request.method !== "GET") return failure(405, "Method not allowed");
  if (!status && request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return failure(426, "WebSocket required");
  let machine: string;
  let credentialId: string | null = null;
  let expires = Date.now() + 15 * 60_000;
  if (agent) {
    if (url.search) return failure(400, "Unexpected query");
    const identity = await agentIdentity(request, env);
    if (!identity) return failure(401, "Invalid agent token");
    if (request.headers.get("X-Eagle-Machine") !== identity.machineId)
      return failure(403, "Machine identity mismatch");
    machine = identity.machineId;
    credentialId = identity.credentialId;
    expires = Math.min(expires, identity.expires ?? expires);
  } else {
    const identity = await authenticateViewer(request, env);
    if (!identity) return failure(401, "Sign in required");
    const origin = request.headers.get("origin");
    if (
      (origin !== null && origin !== url.origin) ||
      (!status && origin === null && identity.kind !== "owner")
    )
      return failure(403, "Origin not allowed");
    const parsed = ExecutionMachineId.safeParse(
      url.searchParams.get("machine"),
    );
    if (
      !parsed.success ||
      [...url.searchParams.keys()].some((key) => key !== "machine") ||
      url.searchParams.getAll("machine").length !== 1
    )
      return failure(400, "Invalid machine selector");
    machine = parsed.data;
    expires = Math.min(expires, identity.expiresAt);
  }
  if (!Number.isFinite(expires) || expires <= Date.now())
    return failure(401, "Authentication expired");
  const object = env.MACHINES.getByName(machine);
  if (status) return object.executionStatus(machine);
  return object.fetch(
    new Request("https://internal/execution", {
      headers: {
        Upgrade: "websocket",
        "x-execution-role": agent ? "agent" : "viewer",
        "x-execution-machine": machine,
        "x-execution-expires": String(expires),
        ...(credentialId ? { "x-execution-credential": credentialId } : {}),
      },
    }),
  );
}
