import { expect, test, type WebSocketRoute } from "@playwright/test";
import { report } from "../fixtures.ts";

test("tab switches retain history and unread output received while unmounted", async ({
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
            report: report("tab-retention", now),
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    }),
  );
  let socket: WebSocketRoute;
  let revision = 0;
  const subscription = {
    spaceId: "default:w1",
    subscriptionId: "tab-retention",
  };
  const text = Array.from(
    { length: 150 },
    (_, index) => `history ${index} https://example.test/history/${index}`,
  ).join("\n");
  const frame = (paneId: string, value: string) =>
    socket.send(
      JSON.stringify({
        type: "frame",
        ...subscription,
        paneId,
        terminalId: `${paneId}-terminal`,
        revision: ++revision,
        observedAt: now,
        text: value,
      }),
    );
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ type: "status", online: true, control: false }));
    ws.send(
      JSON.stringify({
        type: "topology",
        ...subscription,
        tabs: ["Build", "Tools"].map((name) => ({
          id: name,
          name,
          panes: [
            {
              id: name,
              title: name,
              terminalId: `${name}-terminal`,
              rect: { x: 0, y: 0, width: 1, height: 1 },
            },
          ],
        })),
      }),
    );
    frame("Build", text);
    frame("Tools", "other tab");
    ws.onMessage(() => {});
  });
  await page.goto("/overview");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  const screen = page.locator(".live-pane pre");
  const unread = page.getByRole("button", { name: "新输出，回到底部" });
  const selectTab = async (name: string) => {
    await page.getByRole("combobox", { name: "实时标签页" }).click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  await expect(screen).toHaveText(text);
  await screen.evaluate((element) => {
    element.scrollTop = 100;
    element.dispatchEvent(new Event("scroll"));
  });
  await selectTab("Tools");
  await expect(screen).toHaveText("other tab");
  frame("Build", text);
  await selectTab("Build");
  await expect
    .poll(() => screen.evaluate((element) => element.scrollTop))
    .toBe(100);
  await expect(unread).toHaveCount(0);
  await selectTab("Tools");
  const latest = text.replace("history 0", "updated 0");
  frame("Build", latest);
  await selectTab("Build");
  await expect(screen).toHaveText(latest);
  await expect
    .poll(() => screen.evaluate((element) => element.scrollTop))
    .toBe(100);
  await expect(unread).toBeVisible();
  await expect(
    screen.getByRole("link", {
      name: "https://example.test/history/5",
      exact: true,
    }),
  ).toHaveAttribute("href", "https://example.test/history/5");
  await unread.click();
  await expect(unread).toHaveCount(0);
  await expect
    .poll(() =>
      screen.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThan(3);
  await selectTab("Tools");
  frame("Build", `${latest}\nnew bottom`);
  await selectTab("Build");
  await expect(screen).toContainText("new bottom");
  await expect(unread).toHaveCount(0);
  await expect
    .poll(() =>
      screen.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThan(3);
});

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
    inputs = 0,
    revision = 0;
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
                rect: { x: 0, y: 0, width: 0.5, height: 1 },
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
  const text =
    Array.from({ length: 150 }, (_, i) => `retained line ${i}`).join("\n") +
    "\nhttps://example.test/retained";
  const latestText = `${text}\nnew while selected https://example.test/latest`;
  const frame = (value = text) =>
    socket.send(
      JSON.stringify({
        type: "frame",
        spaceId: "default:w1",
        subscriptionId: `epoch-${connections}`,
        paneId: "pane",
        terminalId: "terminal",
        revision: ++revision,
        text: value,
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
  await expect(
    screen.getByRole("link", {
      name: "https://example.test/retained",
      exact: true,
    }),
  ).toHaveAttribute("href", "https://example.test/retained");
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
  // Combined #71/#72: selection freezes only the rendered snapshot. Leaving
  // the view must retain the latest incoming frame, scroll, unread and safety.
  await screen.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByText("选择文字中，画面已暂停更新")).toBeVisible();
  frame(latestText);
  await expect(screen).toHaveText(text);
  await expect(
    screen.getByRole("link", {
      name: "https://example.test/latest",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "新输出，回到底部" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await expect(screen).toHaveText(latestText);
  await expect(
    screen.getByRole("link", {
      name: "https://example.test/latest",
      exact: true,
    }),
  ).toHaveAttribute("href", "https://example.test/latest");
  await expect.poll(() => screen.evaluate((el) => el.scrollTop)).toBe(100);
  await expect(page.getByText("选择文字中，画面已暂停更新")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "上一条历史", exact: true }),
  ).toBeDisabled();
  expect(controls).toBe(1);
  expect(inputs).toBe(1);
  topology();
  frame();
  await expect(screen).toHaveText(text);
  await page.getByRole("button", { name: "新输出，回到底部" }).click();
  await screen.evaluate((el) => {
    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
  });
  // The 15-minute lease renews viewing, never input authority.
  await page.getByRole("combobox", { name: "当前终端" }).click();
  await page
    .getByRole("option", { name: "CLI 2 · pane-2", exact: true })
    .click();
  frame(`${text}\nhidden-pane update`);
  await expect(
    page.locator('.live-pane[data-selected="false"] pre'),
  ).toContainText("hidden-pane update");
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await page.getByRole("combobox", { name: "当前终端" }).click();
  await page.getByRole("option", { name: "CLI · pane", exact: true }).click();
  await expect.poll(() => screen.evaluate((el) => el.scrollTop)).toBe(100);
  await expect(
    page.getByRole("button", { name: "新输出，回到底部" }),
  ).toBeVisible();
  topology();
  frame();
  close(4002, "Renew authorization");
  await expect(page.locator(".live-reconnecting")).toBeVisible();
  await page.clock.runFor(1100);
  expect(connections).toBe(5);
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
