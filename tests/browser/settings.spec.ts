import { expect, test } from "@playwright/test";
import {
  HourlySettingsSchema,
  REPORT_SECTIONS,
  TEMPLATE_VERSION,
} from "../../src/shared/hourly.ts";

test("AI key can be saved, retained, tested and cleared without returning or persisting its plaintext", async ({
  page,
}) => {
  const key = "browser-only-test-key";
  let storedKey = "";
  let settings = {
    ...HourlySettingsSchema.parse({
      provider: "custom",
      model: "test-model",
      baseURL: "https://api.ai.example/v1",
    }),
    hasApiKey: false,
    configured: false,
  };
  let tests = 0;
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now: new Date().toISOString(), machines: [] } }),
  );
  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() === "POST") {
      const { apiKey, ...config } = route.request().postDataJSON();
      if (apiKey === null) storedKey = "";
      else if (apiKey) storedKey = apiKey;
      settings = {
        ...settings,
        ...config,
        hasApiKey: !!storedKey,
        configured: !!storedKey,
      };
    }
    await route.fulfill({ json: settings });
  });
  await page.route("**/api/v1/settings/test", async (route) => {
    expect(route.request().postDataJSON().apiKey || storedKey).toBe(key);
    tests++;
    await route.fulfill({ json: { success: true } });
  });
  await page.goto("/settings");
  const input = page.getByLabel("API Key", { exact: true });
  await expect(input).toHaveAttribute("type", "password");
  await input.fill(key);
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByText("AI 连接成功。", { exact: true })).toBeVisible();
  expect(storedKey).toBe("");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已保存", exact: true }),
  ).toBeVisible();
  expect(storedKey).toBe(key);
  await expect(input).toHaveValue("");
  await page.reload();
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute(
    "placeholder",
    "已配置，留空保留当前密钥",
  );
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已保存", exact: true }),
  ).toBeVisible();
  expect(storedKey).toBe(key);
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByText("AI 连接成功。", { exact: true })).toBeVisible();
  expect(tests).toBe(2);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: localStorage, session: sessionStorage }),
    ),
  ).not.toContain(key);
  await page.getByRole("button", { name: "清除密钥", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已保存", exact: true }),
  ).toBeVisible();
  expect(storedKey).toBe("");
  await expect(
    page.getByRole("button", { name: "测试连接", exact: true }),
  ).toBeDisabled();
});

test("settings loads from sidebar, saves hourly cadence and explains missing AI without storing credentials", async ({
  page,
  isMobile,
}) => {
  let settings = {
    ...HourlySettingsSchema.parse({}),
    hasApiKey: false,
    configured: false,
  };
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now: new Date().toISOString(), machines: [] } }),
  );
  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() === "POST")
      settings = { ...settings, ...route.request().postDataJSON() };
    await route.fulfill({ json: settings });
  });
  await page.goto("/");
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByText("未配置 AI，自动跳过报告生成。", { exact: true }),
  ).toBeVisible();
  const cadence = page.getByRole("combobox", { name: "生成间隔" });
  await expect(cadence).toContainText("1 小时");
  await cadence.click();
  await page.getByRole("option", { name: "2 小时", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已保存", exact: true }),
  ).toBeVisible();
  expect(settings.intervalHours).toBe(2);
  await page.reload();
  await expect(cadence).toContainText("2 小时");
  for (const title of Object.values(REPORT_SECTIONS))
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "apiKey",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("history expands a persisted Chinese hourly report and keeps it mounted during refresh", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: { now: new Date().toISOString(), machines: [], entries: [] },
    }),
  );
  await page.route("**/api/v1/hourly-reports?**", (route) =>
    route.fulfill({
      json: {
        entries: [
          {
            seq: 1,
            report: {
              machineId: "mac-studio",
              machineName: "Mac Studio",
              hour: "2026-09-19T09:00:00.000Z",
              generatedAt: "2026-09-19T10:05:00.000Z",
              templateVersion: TEMPLATE_VERSION,
              model: "test-model",
              provider: "custom",
              snapshots: 120,
              semanticRecords: 24,
              inputRecords: 80,
              inputHash: "hash",
              firstObservedAt: "2026-09-19T09:00:03.000Z",
              lastObservedAt: "2026-09-19T09:59:31.000Z",
              content: {
                ...Object.fromEntries(
                  Object.keys(REPORT_SECTIONS).map((k) => [
                    k,
                    "本小时完成接口集成，生产部署仍待核实。",
                  ]),
                ),
                evidenceIds: ["F1"],
              },
            },
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.goto("/history");
  const card = page.getByRole("article", { name: "Mac Studio 小时报告" });
  await expect(card).toContainText("120 次采集");
  await card.getByRole("button", { name: "展开报告" }).click();
  for (const title of Object.values(REPORT_SECTIONS))
    await expect(
      card.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  await card.evaluate((node) =>
    node.setAttribute("data-continuity", "original"),
  );
  await page.getByRole("button", { name: "刷新小时报告" }).click();
  await expect(card).toHaveAttribute("data-continuity", "original");
  await expect(
    card.getByRole("heading", { name: "判断依据与数据覆盖" }),
  ).toBeVisible();
});
