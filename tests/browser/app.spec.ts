import { expect, test } from "@playwright/test";
import { report } from "../fixtures.ts";

test("token-free overview, topology evidence, history and empty search", async ({
  page,
}) => {
  const value = report("browser-report", new Date().toISOString());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
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
  await expect(page.getByLabel("访问令牌")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Space 拓扑" })).toBeVisible();
  await page.getByRole("button", { name: "筛选进行中" }).click();
  await expect(page.getByText("没有匹配的 Space")).toBeVisible();
  await page.getByRole("button", { name: "筛选全部" }).click();
  await expect(page.getByRole("heading", { name: "当前态势" })).toBeVisible();
  await expect(
    page.getByText("已验证完成", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "最近变化" })).toBeVisible();
  await expect(page.getByText("首次接入：Eagle").first()).toBeVisible();
  await page.getByRole("button", { name: "查看 Eagle" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Herdr 弱提示：done")).toBeVisible();
  await expect(page.getByText(/待补充或核对/).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("搜索 Space").fill("no-such-space");
  await expect(page.getByText("没有匹配的 Space")).toBeVisible();
  await page.getByLabel("搜索 Space").clear();
  await page.getByRole("button", { name: "查看最近历史" }).click();
  await expect(page.getByText("首次接入：Eagle").first()).toBeVisible();
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

test("adopted eagle mark and family links work in both sidebar states", async ({
  page,
  isMobile,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now: new Date().toISOString(), machines: [] } }),
  );
  await page.goto("/");
  await expect(page.getByText("等待第一台机器接入")).toBeVisible();
  const github = page.getByRole("link", {
    name: "Eagle GitHub 仓库（新标签页）",
  });
  const hexly = page.getByRole("link", {
    name: "在 hexly.ai 查看 Eagle（新标签页）",
  });
  await expect(github).toHaveAttribute(
    "href",
    "https://github.com/nocoo/eagle",
  );
  await expect(hexly).toHaveAttribute(
    "href",
    "https://hexly.ai/projects/eagle",
  );
  await expect(hexly).toHaveAttribute("target", "_blank");
  await hexly.focus();
  await expect(page.getByRole("tooltip")).toContainText(
    "在 hexly.ai 查看 Eagle",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "展开导航" }).click();
  const mark = page.locator("img[data-eagle-mark]").last();
  await expect(mark).toBeVisible();
  await mark.evaluate((node) => (node as HTMLImageElement).decode());
  expect(
    await mark.evaluate(
      (node) =>
        (node as HTMLImageElement).complete &&
        (node as HTMLImageElement).naturalWidth > 0,
    ),
  ).toBe(true);
  expect(
    await mark.evaluate((node) => getComputedStyle(node).borderRadius),
  ).toBe("0px");
  await page.getByRole("button", { name: "收起导航" }).click();
  if (!isMobile) await expect(mark).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("first load shows a stable skeleton and Access expiry offers SSO without a token field", async ({
  page,
}) => {
  let finish: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route("**/api/**", async (route) => {
    await ready;
    await route.fulfill({ status: 401, json: { error: "Access required" } });
  });
  await page.goto("/");
  await expect(
    page.getByRole("status", { name: "正在同步工作空间" }),
  ).toBeVisible();
  finish();
  await expect(
    page.getByRole("button", { name: "通过 Cloudflare Access 继续" }),
  ).toBeVisible();
  await expect(page.getByLabel("访问令牌")).toHaveCount(0);
});

test("attention is shown first and reduced-motion users get no entrance animation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const value = report("priority", new Date().toISOString());
  const urgent = structuredClone(value.spaces[0]);
  urgent.id = "default:w2";
  urgent.name = "Urgent";
  urgent.tabs[0].panes[0].evidence.push({
    kind: "test",
    status: "failure",
    summary: "Production regression",
    source: "test",
    observedAt: value.capturedAt,
    taskId: "task-1",
  });
  value.spaces.push(urgent);
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("history")
        ? { entries: [], nextCursor: null }
        : {
            now: value.capturedAt,
            machines: [
              {
                id: "mac-one",
                name: "Mac One",
                lastSeen: value.capturedAt,
                receivedAt: value.capturedAt,
                warning: null,
                report: value,
              },
            ],
          },
    }),
  );
  await page.goto("/");
  await expect(page.locator(".space-card h3").first()).toHaveText("Urgent");
  expect(
    await page
      .locator(".space-card")
      .first()
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
});
