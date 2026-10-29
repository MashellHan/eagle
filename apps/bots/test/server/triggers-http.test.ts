// docs/bots/TRIGGERS.md §8.3: the app's only trigger surface. A person reads detail and
// switches one trigger; every other mutation belongs to the bot's own model.
import assert from "node:assert/strict";
import test from "node:test";
import type { TriggerApi } from "../../src/server/http.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";

const surface = () => {
  const toggles: { botId: string; triggerId: string; enabled: boolean }[] = [];
  const entries: Record<string, unknown>[] = [
    {
      id: "t_9f2a1c3d04",
      kind: "schedule",
      name: "morning triage",
      enabled: true,
      prompt: "triage the queue",
      schedule: { cron: "0 9 * * *", timezone: "Asia/Shanghai" },
      counters: { fired: 0, dropped: 0, refused: 0 },
    },
    {
      id: "t_7b1e55aa10",
      kind: "webhook",
      name: "deploy notify",
      enabled: true,
      prompt: "handle the deploy",
      endpoint: "/v1/triggers/b_1/t_7b1e55aa10",
      counters: { fired: 0, dropped: 0, refused: 0 },
    },
  ];
  const api: TriggerApi = {
    list: async (botId) =>
      botId === "b_1"
        ? entries
        : (() => {
            throw Object.assign(new Error("no such bot"), { name: "ClassifiedFailure" });
          })(),
    setEnabled: async (botId, triggerId, enabled) => {
      toggles.push({ botId, triggerId, enabled });
      const found = entries.find((entry) => entry.id === triggerId);
      if (botId !== "b_1" || found === undefined) return undefined;
      return { ...found, enabled };
    },
  };
  return { api, toggles };
};

const call = async (
  stack: { port: number; token: string },
  path: string,
  init: { method?: string; body?: unknown } = {},
) =>
  fetch(`http://127.0.0.1:${stack.port}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

test("detail is read-only and carries the prompt and a credential-free endpoint", async () => {
  const { api } = surface();
  const stack = await startStack({ triggers: api });
  try {
    const response = await call(stack, "/v1/triggers?botId=b_1");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { triggers: Record<string, unknown>[] };
    assert.equal(body.triggers.length, 2);
    assert.equal(body.triggers[0]?.prompt, "triage the queue");
    assert.equal(body.triggers[1]?.endpoint, "/v1/triggers/b_1/t_7b1e55aa10");
    assert.equal(
      JSON.stringify(body).includes("token"),
      false,
      "the list never carries a credential",
    );

    const missing = await call(stack, "/v1/triggers");
    assert.equal(missing.status, 400, "botId is required");
  } finally {
    await stack.close();
  }
});

test("the enable switch is the only mutation, and it rejects anything else", async () => {
  const { api, toggles } = surface();
  const stack = await startStack({ triggers: api });
  try {
    const off = await call(stack, "/v1/triggers/b_1/t_9f2a1c3d04", {
      method: "PATCH",
      body: { enabled: false },
    });
    assert.equal(off.status, 200);
    const body = (await off.json()) as { trigger: { enabled: boolean; id: string } };
    assert.equal(body.trigger.enabled, false);
    assert.deepEqual(toggles, [{ botId: "b_1", triggerId: "t_9f2a1c3d04", enabled: false }]);

    const extra = await call(stack, "/v1/triggers/b_1/t_9f2a1c3d04", {
      method: "PATCH",
      body: { enabled: true, prompt: "edit me" },
    });
    assert.equal(extra.status, 400, "a person may not edit the definition");
    const unknown = await call(stack, "/v1/triggers/b_1/t_aaaaaaaaaa", {
      method: "PATCH",
      body: { enabled: true },
    });
    assert.equal(unknown.status, 404);
    const notABot = await call(stack, "/v1/triggers/b_2/t_9f2a1c3d04", {
      method: "PATCH",
      body: { enabled: true },
    });
    assert.equal(notABot.status, 404, "a trigger belongs to one bot");
  } finally {
    await stack.close();
  }
});

test("the daemon advertises the triggers capability", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    const welcome = await frames.next();
    assert.equal(welcome.type, "welcome");
    assert.equal(
      (welcome as { capabilities?: Record<string, boolean> }).capabilities?.triggers,
      true,
    );
    socket.close();
    void trace;
  } finally {
    await stack.close();
  }
});
