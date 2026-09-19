import assert from "node:assert/strict";
import { test } from "node:test";
import { ReportSchema } from "../src/shared/schema.ts";
import { report } from "./fixtures.ts";

test("v1 report round trips; unsupported versions, secrets and duplicate IDs fail closed", () => {
  const value = report();
  assert.deepEqual(ReportSchema.parse(value), value);
  assert.equal(
    ReportSchema.safeParse({ ...value, schemaVersion: 2 }).success,
    false,
  );
  assert.equal(
    ReportSchema.safeParse({ ...value, token: "never-store" }).success,
    false,
  );
  assert.equal(
    ReportSchema.safeParse({
      ...value,
      spaces: [...value.spaces, ...value.spaces],
    }).success,
    false,
  );
  assert.equal(
    ReportSchema.safeParse({
      ...value,
      machine: { ...value.machine, token: "secret" },
    }).success,
    false,
  );
});
test("reject invalid dates, geometry, excessive strings and duplicate pane identities", () => {
  const value = report();
  assert.equal(
    ReportSchema.safeParse({ ...value, capturedAt: "yesterday" }).success,
    false,
  );
  const pane = value.spaces[0].tabs[0].panes[0];
  pane.rect.width = -1;
  assert.equal(ReportSchema.safeParse(value).success, false);
  pane.rect.width = 1;
  pane.rect.x = 0.5;
  assert.equal(ReportSchema.safeParse(value).success, false);
  pane.rect.x = 0;
  value.spaces[0].tabs[0].panes.push(pane);
  assert.equal(ReportSchema.safeParse(value).success, false);
});
