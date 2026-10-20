import { expect, test, type WebSocketRoute } from "@playwright/test";
import { report } from "../fixtures.ts";

test("view switches preserve output, history position and unknown input without reclaiming control", async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const now = new Date().toISOString();
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            report: report("retention", now),
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    }),
  );
  let socket: WebSocketRoute;
  const close = (code: number, reason: string) =>
    socket.close({ code, reason });
  let connections = 0,
    controls = 0,
    inputs = 0;
  const topology = () =>
    socket.send(
      JSON.stringify({
        type: "topology",
        spaceId: "default:w1",
        subscriptionId: `epoch-${connections}`,
        tabs: [
          {
            id: "tab",
            name: "Build",
            panes: [
              {
                id: "pane",
                terminalId: "terminal",
                title: "CLI",
                rect: { x: 0, y: 0, width: 1, height: 1 },
              },
              {
                id: "pane-2",
                terminalId: "terminal-2",
                title: "CLI 2",
                rect: { x: 0.5, y: 0, width: 0.5, height: 1 },
              },
            ],
          },
        ],
      }),
    );
  const text = Array.from({ length: 150 }, (_, i) => `retained line ${i}`).join(
    "\n",
  );
  const frame = () =>
    socket.send(
      JSON.stringify({
        type: "frame",
        spaceId: "default:w1",
        subscriptionId: `epoch-${connections}`,
        paneId: "pane",
        terminalId: "terminal",
        revision: 1,
        text,
        observedAt: now,
      }),
    );
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    socket = ws;
    connections++;
    ws.send(JSON.stringify({ type: "status", online: true, control: false }));
    if (connections === 1) {
      topology();
      frame();
    }
    ws.onMessage((data) => {
      const m = JSON.parse(String(data));
      if (m.type === "control") {
        controls++;
        ws.send(
          JSON.stringify({ type: "status", online: true, control: true }),
        );
      }
      if (m.type === "input") inputs++;
      if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    });
  });
  await page.goto("/overview");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  const screen = page.locator('.live-pane[data-selected="true"] pre');
  await expect(screen).toHaveText(text);
  await screen.evaluate((el) => {
    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.getByLabel("发送到当前 Pane").fill("unknown-do-not-replay");
  await page.getByRole("button", { name: "发送并回车" }).click();
  await expect.poll(() => inputs).toBe(1);
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await expect(screen).toHaveText(text);
  await expect.poll(() => screen.evaluate((el) => el.scrollTop)).toBe(100);
  await expect(
    page.getByText("连接中断，输入结果未知；不会自动重发"),
  ).toBeVisible();
  topology();
  frame();
  await expect(page.getByRole("button", { name: "接管输入" })).toBeEnabled();
  expect(controls).toBe(1);
  expect(inputs).toBe(1);
  await expect.poll(() => screen.evaluate((el) => el.scrollTop)).toBe(100);
  // The 15-minute lease renews viewing, never input authority.
  await page.getByRole("combobox", { name: "当前终端" }).click();
  await page
    .getByRole("option", { name: "CLI 2 · pane-2", exact: true })
    .click();
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await page.getByRole("combobox", { name: "当前终端" }).click();
  await page.getByRole("option", { name: "CLI · pane", exact: true }).click();
  await expect.poll(() => screen.evaluate((el) => el.scrollTop)).toBe(100);
  topology();
  frame();
  close(4002, "Renew authorization");
  await expect(page.locator(".live-reconnecting")).toBeVisible();
  await page.clock.runFor(1100);
  expect(connections).toBe(4);
  topology();
  frame();
  expect(controls).toBe(1);
  await expect(screen).toHaveText(text);
  // Authorization revocation clears both current and retained protected output.
  close(4001, "Authorization revoked");
  await expect(screen).toHaveCount(0);
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await expect(page.locator(".live-pane pre")).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
  ).not.toContain("retained line");
});
