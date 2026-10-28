import { createServer } from "node:http";
import { WebSocketServer } from "ws";

// Owned loopback server for the instrumented Swift client tests. No live service.
const owner = "isolated-spm-execution-owner-token-at-least-32-characters";
const server = createServer((_request, response) =>
  response.writeHead(404).end(),
);
const sockets = new WebSocketServer({ noServer: true });
const observed = { runs: 0, gets: 0, cancels: 0, pings: 0 };
server.on("upgrade", (request, socket, head) => {
  const mode = new URL(request.url, "http://fixture").searchParams.get(
    "machine",
  );
  if (
    request.headers.authorization !== `Bearer ${owner}` ||
    mode === "authentication"
  ) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  if (mode === "redirect") {
    socket.end(
      "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/foreign\r\nContent-Length: 0\r\n\r\n",
    );
    return;
  }
  sockets.handleUpgrade(request, socket, head, (ws) => {
    ws.on("error", () => {});
    ws.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString());
      if (request.type === "ping") {
        observed.pings++;
        ws.send(JSON.stringify({ type: "pong" }));
        if (mode === "heartbeat")
          ws.send(
            JSON.stringify({
              type: "result",
              requestId: ws.requestId,
              operation: {
                id: "wire-operation",
                state: "succeeded",
                stdout: "heartbeat verified",
                stderr: "",
                exitCode: 0,
              },
            }),
          );
        return;
      }
      ws.requestId = request.requestId;
      if (request.type === "run") observed.runs++;
      if (request.type === "get") observed.gets++;
      if (request.type === "cancel") observed.cancels++;
      if (["stall", "heartbeat"].includes(mode)) return;
      if (mode === "revoked") {
        ws.close(4001);
        return;
      }
      if (mode === "binary") {
        ws.send(Buffer.from("binary"));
        return;
      }
      if (mode === "offline") {
        ws.send(
          JSON.stringify({
            type: "error",
            requestId: request.requestId,
            operationId: "wire-operation",
            code: "offline",
          }),
        );
        return;
      }
      const reply =
        request.type === "cancel"
          ? {
              type: "cancel-ack",
              requestId: request.requestId,
              operationId: "wire-operation",
              requested: true,
            }
          : {
              type: "result",
              requestId: request.requestId,
              operation: {
                id: "wire-operation",
                state: "succeeded",
                stdout:
                  mode === "stats"
                    ? JSON.stringify(observed)
                    : "actual fixture result",
                stderr: "",
                exitCode: 0,
              },
            };
      ws.send(JSON.stringify({ type: "pong" }));
      ws.send(JSON.stringify(reply));
    });
  });
});
server.listen(0, "127.0.0.1", () =>
  process.stdout.write(`${server.address().port}\n`),
);
function close() {
  for (const socket of sockets.clients) socket.terminate();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
setTimeout(close, 40_000).unref();
