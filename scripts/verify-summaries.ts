import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import type { AgentConfig } from "../agent/collector.ts";
import type { MachineView } from "../src/shared/schema.ts";
import type { SemanticHour, SemanticRecord } from "../src/shared/summaries.ts";

const origin = process.env.EAGLE_VERIFY_ORIGIN || "https://eagle.dev.hexly.ai";
const config: AgentConfig = JSON.parse(
  await readFile(process.env.EAGLE_CONFIG || ".local/agent-dev.json", "utf8"),
);
const production = !origin.includes(".dev.");
const access = production
  ? (
      await readFile(
        process.env.EAGLE_ACCESS_JWT_FILE || ".local/access.jwt",
        "utf8",
      )
    ).trim()
  : null;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1050 },
  });
  if (access)
    await context.addCookies([
      {
        name: "CF_Authorization",
        value: access,
        domain: new URL(origin).hostname,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const state = await context.request.get(`${origin}/api/v1/overview`);
  assert.equal(state.status(), 200);
  const machine = (
    (await state.json()) as { machines: MachineView[] }
  ).machines.find((m) => m.id === config.machineId);
  assert(machine);
  assert(Date.now() - Date.parse(machine.report.capturedAt) < 90000);
  assert(
    machine.manager &&
      Date.now() - Date.parse(machine.manager.lastSeen) < 90000,
  );
  const live = machine.report.spaces
    .filter((s) => !s.availability)
    .flatMap((space) =>
      space.tabs.flatMap((tab) => tab.panes.map((pane) => ({ space, pane }))),
    );
  assert(live.length > 0);
  await page.goto(`${origin}/?machine=${encodeURIComponent(config.machineId)}`);
  const results = [];
  for (const { space, pane } of live) {
    const summary = machine.summaries?.find(
      (s) =>
        s.spaceId === space.id &&
        s.paneId === pane.id &&
        s.taskId === pane.task.id,
    );
    assert(
      summary,
      `Missing current-task semantic summary for ${space.name}/${pane.id}`,
    );
    assert(
      Date.now() - Date.parse(summary.checkedAt) < 300000,
      `Stale unchecked Pane ${pane.id}`,
    );
    assert(
      summary.summary.task &&
        summary.summary.progress &&
        summary.summary.nextStep,
    );
    const query = new URLSearchParams({
      machine: machine.id,
      space: space.id,
      pane: pane.id,
    });
    const response = await context.request.get(
      `${origin}/api/v1/semantic-hours?${query}`,
    );
    assert.equal(response.status(), 200);
    const { hours } = (await response.json()) as { hours: SemanticHour[] };
    assert(hours.length > 0);
    assert(hours.every((h) => h.hour.endsWith(":00:00.000Z")));
    const bucket = hours[0];
    const records = await context.request.get(
      `${origin}/api/v1/semantic-hours?${query}&hour=${encodeURIComponent(bucket.hour)}&mode=all&limit=100`,
    );
    const { entries } = (await records.json()) as { entries: SemanticRecord[] };
    assert(entries.length > 0);
    assert.equal(new Set(entries.map((e) => e.seq)).size, entries.length);
    assert(
      entries.every(
        (e) =>
          e.contentHash.length === 64 &&
          e.source.managerId === machine.manager?.id,
      ),
    );
    const latest = await context.request.get(
      `${origin}/api/v1/semantic-hours?${query}&hour=${encodeURIComponent(bucket.hour)}&mode=latest`,
    );
    assert.equal((await latest.json()).entries[0].seq, bucket.latest.seq);
    await page
      .getByRole("button", {
        name: `${pane.agent || "终端"} ${pane.id} 证据`,
        exact: true,
      })
      .first()
      .click();
    const panel = page.getByRole("region", { name: "Pane 实时总结" });
    await expect(panel).toBeVisible();
    await expect(panel).not.toContainText("等待 Manager");
    await expect(page.getByText("UTC 小时时间线")).toBeVisible();
    await panel
      .getByRole("button", { name: /展开.*条/ })
      .first()
      .click();
    await expect(
      panel.getByRole("button", { name: /收起.*条/ }).first(),
    ).toHaveAttribute("aria-expanded", "true");
    await panel.evaluate((node) =>
      node.setAttribute("data-continuity", "same"),
    );
    if (results.length === 0) {
      await page.waitForTimeout(6000);
      await expect(panel).toHaveAttribute("data-continuity", "same");
      await page.screenshot({
        path: `.local/${production ? "production" : "local"}-semantic-hour.png`,
        animations: "disabled",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: `.local/${production ? "production" : "local"}-semantic-mobile.png`,
        animations: "disabled",
      });
      await page.setViewportSize({ width: 1600, height: 1050 });
    }
    await page.keyboard.press("Escape");
    results.push({
      space: space.name,
      pane: pane.id,
      hour: bucket.hour,
      records: bucket.count,
      sequence: summary.sequence,
    });
  }
  assert.deepEqual(errors, []);
  const result = {
    origin,
    at: new Date().toISOString(),
    machine: machine.id,
    livePanes: live.length,
    verifiedPanes: results.length,
    results,
  };
  await writeFile(
    `.local/${production ? "production" : "local"}-summary-verification.json`,
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
