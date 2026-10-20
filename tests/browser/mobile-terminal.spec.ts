import { expect, test, type WebSocketRoute } from "@playwright/test";
import { report } from "../fixtures.ts";

test("mobile terminal keeps primary keys visible and selected output stable", async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 460 });
  const now = new Date().toISOString();
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            report: report("mobile-keys", now),
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    }),
  );
  let socket: WebSocketRoute;
  const inputs: {
    text: string;
    keys: string[];
    terminalId: string;
    seq: number;
  }[] = [];
  let revision = 0;
  const frame = (text: string) =>
    socket.send(
      JSON.stringify({
        type: "frame",
        spaceId: "default:w1",
        subscriptionId: "epoch",
        paneId: "pane",
        terminalId: "terminal",
        revision: ++revision,
        text,
        observedAt: now,
      }),
    );
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ type: "status", online: true, control: false }));
    ws.send(
      JSON.stringify({
        type: "topology",
        spaceId: "default:w1",
        subscriptionId: "epoch",
        tabs: [
          {
            id: "tab",
            name: "Build",
            panes: [
              {
                id: "pane",
                title: "CLI",
                terminalId: "terminal",
                rect: { x: 0, y: 0, width: 1, height: 1 },
              },
            ],
          },
        ],
      }),
    );
    frame("Select this synthetic output for copying.");
    ws.onMessage((data) => {
      const m = JSON.parse(String(data));
      if (m.type === "control" || m.type === "release")
        ws.send(
          JSON.stringify({
            type: "status",
            online: true,
            control: m.type === "control",
          }),
        );
      if (m.type === "input") {
        inputs.push(m);
        ws.send(
          JSON.stringify({ type: "ack", seq: m.seq, status: "submitted" }),
        );
      }
    });
  });
  await page.goto("/overview");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  const input = page.getByLabel("发送到当前 Pane");
  await input.fill("draft must not be sent by history keys");
  await input.focus();
  for (const [name, key] of [
    ["Ctrl+C", "ctrl+c"],
    ["Ctrl+D", "ctrl+d"],
    ["上一条历史", "up"],
    ["下一条历史", "down"],
  ]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeInViewport({ ratio: 1 });
    await expect(button).toBeEnabled();
    await button.click();
    await expect.poll(() => inputs.at(-1)?.keys[0]).toBe(key);
    expect(inputs.at(-1)?.text).toBe("");
    expect(inputs.at(-1)?.terminalId).toBe("terminal");
    await expect(input).toHaveValue("draft must not be sent by history keys");
  }
  await page.getByRole("button", { name: "更多快捷键" }).click();
  await expect(
    page.getByRole("button", { name: "Shift+Tab", exact: true }),
  ).toBeVisible();
  for (const name of ["Ctrl+P", "Ctrl+N"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect.poll(() => inputs.at(-1)?.keys[0]).toBe(name.toLowerCase());
    expect(inputs.at(-1)?.text).toBe("");
  }
  await page.keyboard.press("Escape");
  const screen = page.locator(".live-pane pre");
  await expect(screen).toHaveCSS("user-select", "text");
  await screen.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByText("选择文字中，画面已暂停更新")).toBeVisible();
  frame("New output after selection.");
  await expect(
    page.getByRole("button", { name: "新输出，回到底部" }),
  ).toBeVisible();
  await screen.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(
    page.getByRole("button", { name: "新输出，回到底部" }),
  ).toBeVisible();
  await expect(screen).toHaveText("Select this synthetic output for copying.");
  expect(
    await page.evaluate(() => window.getSelection()?.toString()),
  ).toContain("synthetic output");
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(screen).toHaveText("New output after selection.");
  await screen.evaluate((el) => {
    const range = document.createRange();
    range.setStart(el, 0);
    range.setEndAfter(el.parentElement?.nextElementSibling ?? el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByText("选择文字中，画面已暂停更新")).toBeVisible();
  frame("Output while selection crosses into the footer.");
  await expect(screen).toHaveText("New output after selection.");
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(screen).toHaveText(
    "Output while selection crosses into the footer.",
  );
  await page.getByRole("button", { name: "新输出，回到底部" }).click();
  await expect(
    page.getByRole("button", { name: "新输出，回到底部" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "释放输入" }).click();
  for (const name of [
    "Ctrl+C",
    "Ctrl+D",
    "上一条历史",
    "下一条历史",
    "更多快捷键",
  ]) {
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeInViewport({ ratio: 1 });
  }
  await expect(
    page.getByRole("button", { name: "上一条历史", exact: true }),
  ).toBeDisabled();
  expect(inputs).toHaveLength(6);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .locator(".space-sheet")
    .screenshot({ path: testInfo.outputPath("mobile-keys.png") });
});
