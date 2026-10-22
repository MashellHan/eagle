import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MACHINE_GROUP_NAME,
  machinesBySidebarGroup,
} from "../src/shared/machine-groups.ts";

test("sidebar groups hide empty sections and keep stable order", () => {
  const machines = [
    { id: "b", name: "B" },
    { id: "a", name: "A" },
    { id: "c", name: "C" },
  ];
  const sections = machinesBySidebarGroup(machines, {
    groups: [
      { id: "g2", name: "Lab" },
      { id: "g1", name: "Prod" },
    ],
    assignments: {
      a: "g1",
      b: "g2",
      c: null,
    },
  });
  assert.deepEqual(
    sections.map((section) => section.name),
    ["Lab", "Prod", DEFAULT_MACHINE_GROUP_NAME],
  );
  assert.deepEqual(
    sections[0].machines.map((machine) => machine.id),
    ["b"],
  );
  assert.deepEqual(
    sections[1].machines.map((machine) => machine.id),
    ["a"],
  );
  assert.deepEqual(
    sections[2].machines.map((machine) => machine.id),
    ["c"],
  );
});

test("unknown assignments fall back to the default group", () => {
  const sections = machinesBySidebarGroup([{ id: "solo", name: "Solo" }], {
    groups: [],
    assignments: { solo: "gone" },
  });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, DEFAULT_MACHINE_GROUP_NAME);
});
