import { expect, test } from "@playwright/test";
import { report } from "../fixtures.ts";

test("private login, executive overview, topology evidence, history and empty search", async ({
  page,
}) => {
  let signedIn = false;
  const value = report("browser-report", new Date().toISOString());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") {
      signedIn = route.request().method() !== "DELETE";
      return route.fulfill({ json: { authenticated: signedIn } });
    }
    if (!signedIn)
      return route.fulfill({
        status: 401,
        json: { error: "Sign in required" },
      });
    if (path.includes("history"))
      return route.fulfill({
        json: {
          entries: [
            {
              seq: 1,
              report: value,
              receivedAt: value.capturedAt,
              changes: ["首次接入：Eagle"],
            },
          ],
          nextCursor: null,
        },
      });
    return route.fulfill({
      json: {
        now: new Date().toISOString(),
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            lastSeen: new Date().toISOString(),
            receivedAt: value.capturedAt,
            warning: null,
            report: value,
          },
        ],
      },
    });
  });
  await page.goto("/");
  await page.getByLabel("访问令牌").fill("test-token");
  await page.getByRole("button", { name: "进入 Eagle" }).click();
  await expect(page.getByRole("heading", { name: "当前态势" })).toBeVisible();
  await expect(
    page.getByText("已验证完成", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "最近变化" })).toBeVisible();
  await expect(page.getByText("首次接入：Eagle")).toBeVisible();
  await page.getByRole("button", { name: "查看 Eagle" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Herdr 弱提示：done")).toBeVisible();
  await expect(page.getByText(/待补充或核对/).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("搜索 Space").fill("no-such-space");
  await expect(page.getByText("没有匹配的 Space")).toBeVisible();
  await page.getByLabel("搜索 Space").clear();
  await page.getByRole("button", { name: "查看最近历史" }).click();
  await expect(page.getByText("首次接入：Eagle")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "test-token",
  );
});

test("failed refresh clearly preserves last known data and does not imply live success", async ({
  page,
}) => {
  let fail = false;
  await page.route("**/api/**", (route) => {
    if (fail)
      return route.fulfill({ status: 503, json: { error: "unavailable" } });
    return route.fulfill({
      json: { now: new Date().toISOString(), machines: [] },
    });
  });
  await page.goto("/");
  await expect(page.getByText("等待第一台机器接入")).toBeVisible();
  fail = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("连接中断");
});

test("stale machine data is marked explicitly", async ({ page }) => {
  const value = report("stale", new Date(Date.now() - 600_000).toISOString());
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now: new Date().toISOString(),
        machines: [
          {
            id: "mac-one",
            name: "Old Mac",
            lastSeen: value.capturedAt,
            receivedAt: value.capturedAt,
            report: value,
            warning: null,
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("心跳过期", { exact: true })).toBeVisible();
  await expect(page.getByText("历史快照 · 等待重新采集")).toBeVisible();
});
