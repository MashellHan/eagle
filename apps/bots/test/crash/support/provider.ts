// A model endpoint that can stop mid-answer (docs/bots/TESTING.md, "Crash test"): the
// first request emits one streamed chunk, writes a sentinel file and then never returns,
// so completion is blocked by construction. Later requests answer normally, which is what
// the restarted daemon meets when it resumes the interrupted task.

import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";

export type Provider = {
  readonly baseUrl: string;
  /** Resolves once the first answer is streaming and the process is blocked. */
  readonly blocked: Promise<void>;
  requests(): number;
  close(): Promise<void>;
};

const frame = (type: string, body: unknown): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...(body as object) })}\n\n`;

const opening = (id: string): string =>
  frame("response.created", { response: { id, status: "in_progress" } }) +
  frame("response.output_item.added", {
    output_index: 0,
    item: { type: "message", id: `msg_${id}`, role: "assistant", content: [] },
  });

const delta = (id: string, text: string): string =>
  frame("response.output_text.delta", {
    output_index: 0,
    item_id: `msg_${id}`,
    content_index: 0,
    delta: text,
  });

const finish = (id: string, text: string): string => {
  const response = {
    id,
    status: "completed",
    output: [
      {
        type: "message",
        id: `msg_${id}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  return (
    frame("response.output_text.done", { output_index: 0, item_id: `msg_${id}`, text }) +
    frame("response.output_item.done", { output_index: 0, item: response.output[0] }) +
    frame("response.completed", { response })
  );
};

export const startProvider = async (
  sentinel: string,
  options: { readonly chunk?: boolean } = {},
): Promise<Provider> => {
  let requests = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hanging: (() => void)[] = [];
  const server: Server = createServer((request, response) => {
    requests += 1;
    const current = requests;
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    if (current > 1) {
      // A resumed task is answered completely so the run can finish.
      const text = "重启之后完成的回答";
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(opening(`resp_${current}`));
      response.write(delta(`resp_${current}`, text));
      response.end(finish(`resp_${current}`, text));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(opening(`resp_${current}`));
    if (options.chunk !== false) response.write(delta(`resp_${current}`, "会被杀死的第一段"));
    hanging.push(() => {
      response.destroy();
    });
    void writeFile(sentinel, "blocked\n").then(() => release?.());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    blocked,
    requests: () => requests,
    close: async () => {
      for (const close of hanging) close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
};
