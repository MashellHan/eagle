import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "eagle-native-machines-"));
const binary = join(root, "native-machines");
const token = "isolated-native-owner-credential-at-least-32-characters";
let server: Server;
let foreign: Server;
let origin: string;
let foreignOrigin: string;
let foreignRequests = 0;
let responseMode = "valid";
const requests: string[] = [];

before(async () => {
  const supportedSDK =
    "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk";
  const sdk =
    process.env.EAGLE_TEST_SDK ??
    (existsSync(supportedSDK)
      ? supportedSDK
      : spawnSync("xcrun", ["--show-sdk-path"], {
          encoding: "utf8",
        }).stdout.trim());
  const compiled = spawnSync(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "6",
      "-sdk",
      sdk,
      "-parse-as-library",
      resolve(
        "apps/macos/Sources/EagleFeatures/Machines/MachineConnection.swift",
      ),
      resolve(
        "apps/macos/Sources/EagleFeatures/Machines/MachineCredentials.swift",
      ),
      resolve(
        "apps/macos/Sources/EagleFeatures/Machines/LocalAgentService.swift",
      ),
      resolve(
        "apps/macos/Sources/EagleFeatures/Machines/MachineSettingsModel.swift",
      ),
      resolve("tests/fixtures/native-machines.swift"),
      "-o",
      binary,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
  foreign = createServer((_request, response) => {
    foreignRequests++;
    response.end("unexpected");
  });
  foreign.listen(0, "127.0.0.1");
  await once(foreign, "listening");
  foreignOrigin = `http://127.0.0.1:${(foreign.address() as AddressInfo).port}`;
  server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(
      request.headers["cf-access-client-id"],
      responseMode === "empty-access" ? undefined : "isolated-access-id",
    );
    assert.equal(
      request.headers["cf-access-client-secret"],
      responseMode === "empty-access" ? undefined : "isolated-access-secret",
    );
    assert.equal(request.url?.includes(token), false);
    requests.push(`${request.method} ${request.url}`);
    if (responseMode === "auth") {
      response.writeHead(401).end("private error not for display");
      return;
    }
    if (responseMode === "redirect") {
      response.writeHead(302, { Location: `${foreignOrigin}/leak` }).end();
      return;
    }
    if (responseMode === "html") {
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<html>Access login</html>");
      return;
    }
    if (responseMode === "oversized") {
      response.writeHead(200, { "Content-Type": "application/json" });
      for (let index = 0; index < 17; index++)
        response.write("x".repeat(65_536));
      response.end();
      return;
    }
    const machine = { id: "native-mac", name: "Native Mac", enabled: true };
    let payload: unknown;
    if (request.url === "/api/v1/machines")
      payload = { machines: [machine], canIssue: true, machineGroups: {} };
    else if (request.url === "/api/v1/execution/status?machine=native-mac")
      payload = {
        machineId: "native-mac",
        online: responseMode !== "offline",
        observedAt:
          responseMode === "empty-time"
            ? ""
            : responseMode === "invalid-time"
              ? "2026-02-30T05:00:00.000Z"
              : responseMode === "secret-time"
                ? token
                : "2026-10-28T05:00:00.000Z",
        agentVersion: "1.1.0-alpha.0",
        capabilities: { commands: false },
      };
    else if (request.url === "/api/v1/machines/native-mac/rename") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const value = JSON.parse(body) as { name: string };
      if (responseMode !== "names")
        assert.deepEqual(value, { name: "书房 Mac" });
      assert(value.name.length <= 120);
      payload = { machine: { ...machine, name: value.name } };
    } else if (request.url === "/api/v1/machines/native-mac/revoke")
      payload = { machine: { ...machine, enabled: false } };
    else {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const service of [server, foreign])
    if (service) await new Promise<void>((done) => service.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

async function run(mode: string, kind = "") {
  const child = spawn(binary, [mode], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data;
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data;
  });
  child.stdin.end(
    JSON.stringify({
      origin,
      token,
      kind,
      accessID: "isolated-access-id",
      accessSecret: "isolated-access-secret",
    }),
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const [code] = await once(child, "exit");
  clearTimeout(timeout);
  assert.equal(output.includes(token), false);
  assert.equal(code, 0, output);
  return output;
}

test("native URLSession reads actual directory/capability responses and acknowledges rename/revoke", async () => {
  responseMode = "valid";
  assert.match(await run("http"), /http-machine-path-pass/);
  assert.deepEqual(requests, [
    "GET /api/v1/machines",
    "GET /api/v1/execution/status?machine=native-mac",
    "POST /api/v1/machines/native-mac/rename",
    "POST /api/v1/machines/native-mac/revoke",
  ]);
});

test("native address and credential validation refuses unsafe origins", async () => {
  assert.match(await run("addresses"), /address-boundaries-pass/);
});

test("native authentication errors do not become an empty directory", async () => {
  responseMode = "auth";
  assert.match(await run("rejected", "auth"), /rejection-pass/);
});

test("native redirects never forward owner or Access credentials", async () => {
  responseMode = "redirect";
  await run("rejected");
  assert.equal(foreignRequests, 0);
});

test("native login HTML and oversized responses are not successful machine connections", async () => {
  for (const mode of ["html", "oversized"]) {
    responseMode = mode;
    await run("rejected");
  }
});

test("native credentials round trip through an isolated real Keychain item", async () => {
  assert.match(await run("keychain"), /keychain-pass/);
});

test("native machine model uses real responses, stores origin-bound credentials and waits for acknowledgements", async () => {
  responseMode = "valid";
  assert.match(await run("model"), /model-machine-path-pass/);
});

test("native machine names follow the Worker UTF-16 length contract", async () => {
  responseMode = "names";
  assert.match(await run("names"), /names-pass/);
});

test("native observation timestamps reject invalid or secret data while preserving offline history", async () => {
  for (const mode of ["empty-time", "invalid-time", "secret-time"]) {
    responseMode = mode;
    assert.match(await run("status-rejected"), /status-rejection-pass/);
  }
  responseMode = "offline";
  assert.match(await run("status-offline"), /offline-history-pass/);
});

test("enabling Access without a saved or entered pair is refused before any HTTP request", async () => {
  responseMode = "empty-access";
  const count = requests.length;
  assert.match(await run("access-empty"), /empty-access-refused/);
  assert.equal(requests.length, count);
});
