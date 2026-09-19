import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { report, telemetry } from "../fixtures.ts";

test("global overview summarizes the fleet and opens only the selected machine", async ({
  page,
  isMobile,
}) => {
  const now = new Date().toISOString();
  const machines = ["One", "Two"].map((name) => {
    const value = report(`fleet-${name}`, now);
    value.spaces[0].name = `${name} Space`;
    return {
      id: name.toLowerCase(),
      name: `Mac ${name}`,
      report: value,
      lastSeen: now,
      receivedAt: now,
      warning: null,
    };
  });
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now, machines } }),
  );
  await page.goto("/");
  await expect(page.getByRole("region", { name: "全部机器" })).toBeVisible();
  await expect(page.getByText("2/2 台机器在线")).toBeVisible();
  await expect(page.locator(".space-card")).toHaveCount(0);
  await expect(page.getByLabel("搜索 Space")).toHaveCount(0);
  const card = page.locator(".fleet-machine").first();
  await card.evaluate((node) =>
    node.setAttribute("data-continuity", "original"),
  );
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(card).toHaveAttribute("data-continuity", "original");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await expect(page.locator(".space-card")).toHaveCount(1);
  await expect(page.locator(".space-card")).toContainText("One Space");
  await expect(page.getByRole("region", { name: "当前工作态势" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("region", { name: "机器资源" })).toBeVisible();
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await page.getByRole("button", { name: "全局总览", exact: true }).click();
  await expect(page.locator(".fleet-machine")).toHaveCount(2);
  await expect(page.locator(".space-card")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("live overview reads only current state and keeps cards mounted through refresh and failures", async ({
  page,
}) => {
  let revision = 1;
  let fail = false;
  let release: (() => void) | undefined;
  let paused: Promise<void> | undefined;
  let historyReads = 0;
  const value = report("do-snapshot", new Date().toISOString());
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("history")) historyReads++;
    await paused;
    if (fail) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({
      json: {
        now: new Date().toISOString(),
        pendingMachines: [],
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            revision,
            changedAt: value.capturedAt,
            changes: ["Eagle：任务已更新"],
            lastSeen: value.capturedAt,
            receivedAt: value.capturedAt,
            warning: null,
            report: { ...value, reportId: `do-${revision}` },
          },
        ],
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  const card = page.locator(".space-card").first();
  await expect(card).toBeVisible();
  await expect(page.getByText("Eagle：任务已更新")).toBeVisible();
  expect(historyReads).toBe(0);
  await page
    .locator(".dashboard-content")
    .evaluate((node) =>
      Promise.all(node.getAnimations().map((animation) => animation.finished)),
    );
  await card.evaluate((node) =>
    node.setAttribute("data-continuity", "original"),
  );
  // Move off any hovered card and settle its lift before measuring refresh.
  await page.getByRole("button", { name: "刷新", exact: true }).hover();
  await page.getByRole("button", { name: "刷新", exact: true }).focus();
  await card.evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished)),
  );
  const before = await card.boundingBox();
  paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(card).toHaveAttribute("data-continuity", "original");
  await expect(
    page.getByRole("status", { name: "正在同步工作空间" }),
  ).toHaveCount(0);
  await expect(card).toHaveCSS("opacity", "1");
  revision++;
  release?.();
  await expect(
    page.getByRole("button", { name: "刷新", exact: true }),
  ).toBeEnabled();
  await expect(card).toHaveAttribute("data-continuity", "original");
  expect(await card.boundingBox()).toEqual(before);
  fail = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("连接中断");
  await expect(card).toHaveAttribute("data-continuity", "original");
  expect(historyReads).toBe(0);
});

test("machine resources and named TCP ports show freshness and missing data honestly", async ({
  page,
}) => {
  const now = new Date().toISOString();
  const snapshot = telemetry(now);
  const value = report("resources", now);
  let stale = false;
  let legacy = false;
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now: new Date().toISOString(),
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            lastSeen: now,
            receivedAt: now,
            warning: null,
            report: {
              ...value,
              machine: {
                ...value.machine,
                ...(!legacy && {
                  telemetry: {
                    ...snapshot,
                    observedAt: stale
                      ? new Date(Date.now() - 600000).toISOString()
                      : now,
                    ports: snapshot.ports.map((port) => ({
                      ...port,
                      checkedAt: stale
                        ? new Date(Date.now() - 600000).toISOString()
                        : now,
                    })),
                  },
                }),
              },
            },
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  const resources = page.getByRole("region", { name: "机器资源" });
  await expect(resources).toContainText("25%");
  await expect(resources).toContainText("12 / 16 GiB");
  await expect(resources).toContainText("200 GiB");
  await expect(resources).toContainText("Raven");
  await expect(resources).toContainText("7024");
  await expect(resources.getByText("可连接", { exact: true })).toBeVisible();
  stale = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(resources).toContainText("历史快照");
  await expect(resources.getByText("可连接", { exact: true })).toHaveCount(0);
  await expect(resources).toContainText("上次可连接");
  legacy = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(resources).toContainText("尚未上报机器资源");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

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
            changes: ["首次接入：Eagle"],
            changedAt: value.capturedAt,
            revision: 1,
            report: value,
          },
        ],
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await expect(page.getByLabel("访问令牌")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Space 拓扑" })).toBeVisible();
  await page.getByRole("button", { name: "筛选进行中" }).click();
  await expect(page.getByText("没有匹配的 Space")).toBeVisible();
  await page.getByRole("button", { name: "筛选全部" }).click();
  await expect(page.getByRole("heading", { name: "当前态势" })).toHaveCount(0);
  await expect(page.getByText("待核实", { exact: true }).first()).toBeVisible();
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
  await expect(page.locator(".sync-caption")).toContainText(
    "连接中断 · 保留上次快照",
  );
  await expect(page.locator(".sync-caption")).not.toContainText("已同步");
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
  await page.getByRole("button", { name: "打开机器 Old Mac" }).click();
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
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await expect(page.getByRole("button", { name: "收起导航" })).toBeVisible();
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
  const expandedMark = await mark.boundingBox();
  await page.getByRole("button", { name: "收起导航" }).click();
  if (!isMobile) {
    await expect(mark).toBeVisible();
    await expect.poll(() => mark.boundingBox()).toEqual(expandedMark);
    const toggle = page.getByRole("button", { name: "展开导航" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect.poll(() => mark.boundingBox()).toEqual(expandedMark);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("sidebar profile shows service avatar and Access logout in expanded and collapsed layouts", async ({
  page,
  isMobile,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now: new Date().toISOString(), machines: [] } }),
  );
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        name: "Li Zheng",
        email: "viewer@example.test",
        avatar: "https://images.example.test/avatar.svg",
        local: false,
      },
    }),
  );
  await page.route("https://images.example.test/avatar.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20" fill="blue"/></svg>',
    }),
  );
  await page.route("**/cdn-cgi/access/logout", (route) =>
    route.fulfill({ body: "Signed out" }),
  );
  await page.goto("/");
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await expect(page.getByText("Li Zheng", { exact: true })).toBeVisible();
  await expect(
    page.getByText("viewer@example.test", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Li Zheng 的头像" }),
  ).toBeVisible();
  if (!isMobile) {
    await page.getByRole("button", { name: "收起导航" }).click();
    await expect(
      page.getByRole("img", { name: "Li Zheng 的头像" }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/);
});

test("local sidebar preserves logout chrome without inventing a login session", async ({
  page,
  isMobile,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now: new Date().toISOString(), machines: [] } }),
  );
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: { name: "本地开发", email: "", avatar: null, local: true },
    }),
  );
  await page.goto("/");
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await expect(page.getByText("本地开发", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("本地免登录", { exact: true })).toBeVisible();
});

test("deployment image policy allows HTTPS author-service avatars", async ({
  page,
}) => {
  const policy = readFileSync("public/_headers", "utf8")
    .split("\n")
    .find((line) => line.trim().startsWith("Content-Security-Policy:"))
    ?.trim()
    .slice("Content-Security-Policy:".length)
    .trim();
  expect(policy).toBeTruthy();
  await page.route("**/avatar-policy-check", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: { "Content-Security-Policy": policy as string },
      body: '<img alt="Profile" src="https://images.example.test/profile.svg">',
    }),
  );
  await page.route("https://images.example.test/profile.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20"/></svg>',
    }),
  );
  await page.goto("/avatar-policy-check");
  await expect(page.getByRole("img", { name: "Profile" })).toHaveJSProperty(
    "naturalWidth",
    40,
  );
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
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await expect(page.locator(".space-card h3").first()).toHaveText("Urgent");
  expect(
    await page
      .locator(".space-card")
      .first()
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
});

test("Connect manages machines and creates a one-time onboarding prompt without browser persistence", async ({
  page,
}) => {
  let machines: {
    id: string;
    name: string;
    enabled: boolean;
    source: string;
    expiresAt: string;
  }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/machines" && request.method() === "GET")
      return route.fulfill({ json: { machines, canIssue: true } });
    if (path === "/api/v1/machines") {
      machines = [
        {
          ...request.postDataJSON(),
          enabled: true,
          source: "managed",
          expiresAt: "2027-09-19T00:00:00Z",
        },
      ];
      return route.fulfill({
        status: 201,
        json: {
          machine: machines[0],
          token: "eag1.test-only-never-persisted-token",
        },
      });
    }
    if (path.endsWith("/revoke")) {
      machines[0].enabled = false;
      return route.fulfill({ json: { machine: machines[0] } });
    }
    return route.fulfill({
      json: {
        now: new Date().toISOString(),
        machines: [],
        pendingMachines: [],
      },
    });
  });
  await page.goto("/connect");
  await expect(page.getByRole("heading", { name: "添加机器" })).toBeVisible();
  await page.getByLabel("机器名称", { exact: true }).fill("Studio Mac");
  await page.getByLabel("机器 ID", { exact: true }).fill("studio-mac");
  await page.getByLabel("关注端口", { exact: true }).fill("Raven:7024");
  await page.getByRole("button", { name: "创建并生成提示词" }).click();
  await expect(page.getByRole("heading", { name: "接入提示词" })).toBeVisible();
  await expect(page.getByLabel("提示词预览")).toContainText(
    "npm install -g @nocoo/eagle-agent@0.3.0 --registry=https://registry.npmjs.org",
  );
  await expect(page.getByLabel("提示词预览")).toContainText(
    "npm install -g @nocoo/eagle-agent@0.3.0 --registry=https://mirrors.cloud.tencent.com/npm/",
  );
  await expect(page.getByLabel("提示词预览")).toContainText("首选腾讯云镜像");
  await expect(page.getByLabel("提示词预览")).toContainText(
    "eagle-agent --version",
  );
  await expect(page.getByLabel("提示词预览")).toContainText("7024");
  await expect(page.getByLabel("提示词预览")).not.toContainText(
    "eag1.test-only",
  );
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("eag1.");
  await page.getByRole("button", { name: "关闭提示词" }).click();
  await page.getByRole("button", { name: "停用 Studio Mac" }).click();
  await page.getByRole("button", { name: "确认停用" }).click();
  await expect(page.getByText("已停用", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "重新启用 Studio Mac" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "接入提示词" })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
