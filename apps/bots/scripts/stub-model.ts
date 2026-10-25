// A model endpoint for the client's own tests and for a local demo: it answers every
// request with one complete streamed answer in the OpenAI Responses shape, so a real
// daemon can be driven without a network provider. It is not a mock daemon — the daemon
// still runs its real adapter, sqlite storage and sockets.
//
//   node --experimental-strip-types scripts/stub-model.ts [answer]
//
// Prints one line, `{"event":"stub.ready","port":<port>}`, and serves until killed.

import { createServer } from "node:http";

const answer = process.argv[2] ?? "这是本地模型的示例回答。";

const frame = (type: string, body: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;

const server = createServer((request, response) => {
  if (request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  const id = `resp_${Date.now()}`;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(frame("response.created", { response: { id, status: "in_progress" } }));
  response.write(
    frame("response.output_item.added", {
      output_index: 0,
      item: { type: "message", id: `msg_${id}`, role: "assistant", content: [] },
    }),
  );
  response.write(
    frame("response.output_text.delta", {
      output_index: 0,
      item_id: `msg_${id}`,
      content_index: 0,
      delta: answer,
    }),
  );
  const completed = {
    id,
    status: "completed",
    output: [
      {
        type: "message",
        id: `msg_${id}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: answer, annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  response.write(
    frame("response.output_text.done", {
      output_index: 0,
      item_id: `msg_${id}`,
      text: answer,
    }),
  );
  response.write(
    frame("response.output_item.done", { output_index: 0, item: completed.output[0] }),
  );
  response.end(frame("response.completed", { response: completed }));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(`${JSON.stringify({ event: "stub.ready", port })}\n`);
});
