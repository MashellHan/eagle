import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { type AgentConfig, collect, sendReport } from "../agent/collector.ts";
import type { Overview } from "../src/shared/schema.ts";

const origin = process.env.EAGLE_VERIFY_ORIGIN || "https://eagle.dev.hexly.ai";
const config: AgentConfig = JSON.parse(
  await readFile(process.env.EAGLE_CONFIG || ".local/agent-dev.json", "utf8"),
);
const secrets = JSON.parse(
  await readFile(
    process.env.EAGLE_VERIFY_SECRETS || ".local/dev-secrets.json",
    "utf8",
  ),
);
const report = await collect(config);
await sendReport(config.url, config.token, report);
const duplicate = (await sendReport(config.url, config.token, report)) as {
  duplicate: boolean;
};
assert.equal(duplicate.duplicate, true);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1050 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const anonymous = await context.request.get(`${origin}/api/v1/overview`);
  assert.equal(anonymous.status(), 401);
  await page.goto(origin);
  await page.getByLabel("访问令牌").fill(secrets.VIEWER_TOKEN);
  await page.getByRole("button", { name: "进入 Eagle" }).click();
  await expect(page.getByRole("heading", { name: "当前态势" })).toBeVisible();
  const response = await context.request.get(`${origin}/api/v1/overview`);
  assert.equal(response.status(), 200);
  const overview = (await response.json()) as Overview;
  const machine = overview.machines.find((m) => m.id === config.machineId);
  assert(machine);
  assert.equal(machine.report.reportId, report.reportId);
  assert.deepEqual(
    machine.report.spaces.map((s) => s.id).sort(),
    report.spaces.map((s) => s.id).sort(),
  );
  for (const space of report.spaces)
    await expect(
      page.getByRole("button", { name: `查看 ${space.name}`, exact: true }),
    ).toBeAttached();
  const second = await collect(config);
  await sendReport(config.url, config.token, second);
  await expect
    .poll(
      async () =>
        (await page.locator("body").innerText()).includes(
          new Date(second.capturedAt).toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }),
        ),
      { timeout: 12000 },
    )
    .toBe(true);
  const target =
    second.spaces.find((s) => s.name === "eagle") ?? second.spaces[0];
  await page
    .getByRole("button", { name: `查看 ${target.name}`, exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Herdr 弱提示");
  const prefix = origin.includes(".dev.") ? "local" : "production";
  await page.screenshot({ path: `.local/${prefix}-detail.png` });
  await page.keyboard.press("Escape");
  await page
    .getByRole("heading", { name: "当前态势" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.local/${prefix}-desktop.png` });
  await page.getByRole("button", { name: "查看最近历史" }).click();
  await expect(
    page.getByText(
      `#${(await (await context.request.get(`${origin}/api/v1/history?machine=${config.machineId}&limit=1`)).json()).entries[0].seq}`,
      { exact: false },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回总览", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `.local/${prefix}-mobile.png` });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert(
    !(await page.evaluate(() =>
      JSON.stringify(localStorage).includes("VIEWER_TOKEN"),
    )),
  );
  assert.deepEqual(errors, []);
  const result = {
    origin,
    checkedAt: new Date().toISOString(),
    machine: config.machineId,
    spaces: second.spaces.length,
    panes: second.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes)).length,
    reportId: second.reportId,
    checks: [
      "anonymous 401",
      "secure login",
      "real Herdr inventory in D1 API",
      "idempotent retry",
      "all Spaces rendered",
      "automatic refresh",
      "pane evidence",
      "history",
      "desktop and mobile",
      "no browser errors",
    ],
  };
  await writeFile(
    `.local/${prefix}-verification.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  await context.close();
} finally {
  await browser.close();
}
