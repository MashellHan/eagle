import { expect, test } from "@playwright/test";
import { report } from "../fixtures.ts";

test("Space realtime receives screens, gates input, and closes sockets on leaving", async ({
  page,
}) => {
  const now = new Date().toISOString();
  const snapshot = report("live-ui", now);
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            report: snapshot,
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    }),
  );
  let closed = 0;
  let acknowledge = true;
  const inputs: unknown[] = [];
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    const sub = { spaceId: "default:w1", subscriptionId: "epoch" };
    ws.send(JSON.stringify({ type: "status", online: true, control: false }));
    ws.send(
      JSON.stringify({
        type: "topology",
        ...sub,
        tabs: [
          {
            id: "tab",
            name: "Build",
            panes: [
              {
                id: "pane",
                terminalId: "terminal",
                title: "Codex",
                rect: { x: 0, y: 0, width: 1, height: 1 },
              },
            ],
          },
        ],
      }),
    );
    ws.send(
      JSON.stringify({
        type: "frame",
        ...sub,
        paneId: "pane",
        terminalId: "terminal",
        revision: 1,
        text: "ready from Herdr",
        observedAt: now,
      }),
    );
    ws.onMessage((data) => {
      const m = JSON.parse(String(data));
      if (m.type === "control")
        ws.send(
          JSON.stringify({ type: "status", online: true, control: true }),
        );
      if (m.type === "input") {
        inputs.push(m);
        if (acknowledge)
          ws.send(
            JSON.stringify({ type: "ack", seq: m.seq, status: "delivered" }),
          );
      }
    });
    ws.onClose(() => closed++);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await expect(page.getByText("ready from Herdr")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送并回车" })).toBeDisabled();
  await page.getByRole("button", { name: "接管输入" }).click();
  await page.getByLabel("发送到当前 Pane").fill("hello");
  await page.getByRole("button", { name: "发送并回车" }).click();
  await expect.poll(() => inputs.length).toBe(1);
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect.poll(() => closed).toBe(1);
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await expect(page.getByText("ready from Herdr")).toBeVisible();
  acknowledge = false;
  await page.getByRole("button", { name: "接管输入" }).click();
  await page.getByLabel("发送到当前 Pane").fill("never-replay-this");
  await page.getByRole("button", { name: "发送并回车" }).click();
  await expect.poll(() => inputs.length).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => closed).toBe(2);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByText("ready from Herdr")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送并回车" })).toBeDisabled();
  expect(inputs.length).toBe(2);
  await page.keyboard.press("Escape");
  await expect.poll(() => closed).toBe(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
