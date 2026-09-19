import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { type AgentConfig, collect, sendReport } from "../agent/collector.ts";
import type { Overview } from "../src/shared/schema.ts";

const origin = process.env.EAGLE_VERIFY_ORIGIN || "https://eagle.dev.hexly.ai";
const config: AgentConfig = JSON.parse(
  await readFile(process.env.EAGLE_CONFIG || ".local/agent-dev.json", "utf8"),
);
const production = !origin.includes(".dev.");
const accessToken = production
  ? (
      await readFile(
        process.env.EAGLE_ACCESS_JWT_FILE || ".local/access.jwt",
        "utf8",
      )
    ).trim()
  : null;
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
  const anonymous = await context.request.get(`${origin}/api/v1/overview`, {
    maxRedirects: 0,
  });
  assert.equal(anonymous.status(), production ? 302 : 200);
  if (production) {
    assert.equal(
      new URL(anonymous.headers().location).hostname,
      "nocoo.cloudflareaccess.com",
    );
    assert(accessToken);
    await context.addCookies([
      {
        name: "CF_Authorization",
        value: accessToken,
        domain: new URL(origin).hostname,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  }
  await page.goto(origin);
  await expect(page.getByLabel("访问令牌")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "当前态势" })).toBeVisible();
  const response = await context.request.get(`${origin}/api/v1/overview`);
  assert.equal(response.status(), 200);
  const overview = (await response.json()) as Overview;
  const machine = overview.machines.find((m) => m.id === config.machineId);
  assert(machine);
  assert.equal(machine.report.reportId, report.reportId);
  assert.deepEqual(machine.report.machine.telemetry, report.machine.telemetry);
  assert(report.machine.telemetry?.resources, "Real machine resources missing");
  assert.deepEqual(
    machine.report.spaces.map((s) => s.id).sort(),
    report.spaces.map((s) => s.id).sort(),
  );
  for (const space of report.spaces)
    await expect(
      page.getByRole("button", { name: `查看 ${space.name}`, exact: true }),
    ).toBeAttached();
  const resources = page.getByRole("region", { name: "机器资源" }).first();
  await expect(resources).toContainText("CPU");
  await expect(resources).toContainText("GiB");
  for (const port of report.machine.telemetry.ports) {
    await expect(resources).toContainText(port.name);
    await expect(resources).toContainText(String(port.port));
  }
  const second = await collect(config);
  await sendReport(config.url, config.token, second);
  await expect(
    page.locator(`.machine-heading time[datetime="${second.capturedAt}"]`),
  ).toBeVisible({ timeout: 12000 });
  const target =
    second.spaces.find((s) => s.name === "eagle") ?? second.spaces[0];
  await page
    .getByRole("button", { name: `查看 ${target.name}`, exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Herdr 弱提示");
  const prefix = origin.includes(".dev.") ? "local" : "production";
  await page.screenshot({
    animations: "disabled",
    path: `.local/${prefix}-detail.png`,
  });
  await page.keyboard.press("Escape");
  await page
    .getByRole("heading", { name: "当前态势" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: `.local/${prefix}-desktop.png`,
  });
  await page.getByRole("button", { name: "查看最近历史" }).click();
  await expect(
    page.getByText(
      `#${(await (await context.request.get(`${origin}/api/v1/history?machine=${config.machineId}&limit=1`)).json()).entries[0].seq}`,
      { exact: false },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回总览", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    animations: "disabled",
    path: `.local/${prefix}-mobile.png`,
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  assert(!accessToken || !storage.includes(accessToken));
  assert.deepEqual(errors, []);
  const result = {
    origin,
    checkedAt: new Date().toISOString(),
    machine: config.machineId,
    spaces: second.spaces.length,
    panes: second.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes)).length,
    reportId: second.reportId,
    checks: [
      production ? "anonymous Access redirect" : "local viewing without token",
      production ? "verified Access session" : "no login form",
      "real Herdr inventory in D1 API",
      "real machine resources and configured TCP ports",
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
