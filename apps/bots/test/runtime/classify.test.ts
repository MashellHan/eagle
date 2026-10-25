// The failure-channel table (docs/bots/RUNTIME.md, "Failure channels"): four channels,
// one identity per episode, and the listener-error escalation rule.
import assert from "node:assert/strict";
import test from "node:test";
import type { ReportTask } from "@earendil-works/pi-durable";
import { FailureClassifier } from "../../src/runtime/pi/classify.ts";

const task = (id: string) =>
  ({ id, kind: "pi.generation", conversationId: 1 }) as unknown as ReportTask;

test("every watch end is either followed or classified, never guessed", () => {
  const ends = [
    { reason: "stopped", failure: undefined },
    { reason: "cancelled", failure: undefined },
    { reason: "session_closed", failure: undefined },
    { reason: "retired", failure: undefined },
    { reason: "listener_error", failure: undefined },
    { reason: "listener_error", failure: undefined },
    { reason: "listener_error", failure: "internal" },
    { reason: "session_failed", failure: "storage_failed" },
  ] as const;
  const classifier = new FailureClassifier({ now: () => 0 });
  for (const [index, end] of ends.entries()) {
    const minted = classifier.watchEnd({ reason: end.reason, error: new Error("x") } as never);
    assert.equal(
      minted?.classification.failure.kind,
      end.failure,
      `${end.reason} #${index} classifies as ${String(end.failure)}`,
    );
    if (end.reason === "listener_error" && minted !== undefined) {
      assert.equal(minted.classification.failure.layer, "pi");
    }
  }
});

test("a listener error escalates once per three inside a minute, and the window resets", () => {
  let now = 0;
  const classifier = new FailureClassifier({ now: () => now });
  const escalate = () =>
    classifier.watchEnd({ reason: "listener_error", error: new Error("x") } as never);
  assert.equal(escalate(), undefined, "the first is recoverable");
  now += 1_000;
  assert.equal(escalate(), undefined, "the second is recoverable");
  now += 1_000;
  const third = escalate();
  assert.equal(third?.classification.failure.kind, "internal");
  assert.equal(third?.minted, true);
  now += 1_000;
  assert.equal(escalate(), undefined, "the fourth is recoverable again");
  now += 70_000;
  assert.equal(escalate(), undefined, "the window emptied");
  now += 1;
  assert.equal(escalate(), undefined);
  now += 1;
  assert.equal(escalate()?.classification.failure.kind, "internal", "three more inside the window");
});

test("one episode gets one identity across every channel", () => {
  const classifier = new FailureClassifier();
  const parked = classifier.report({ type: "task_parked", task: task("9") });
  const report = classifier.report({ type: "task_faulted", task: task("9"), reason: "threw" });
  const event = classifier.taskFailed({ taskId: "9", kind: "pi.generation" });
  assert.equal(parked?.classification.failure.id, event.classification.failure.id);
  assert.equal(report?.minted, false, "the second notification does not mint");
  assert.equal(parked?.minted, true);

  const session = classifier.report({ type: "session_failed" });
  const watch = classifier.watchEnd({ reason: "session_failed", error: new Error("x") } as never);
  const closed = classifier.sessionEnd({ reason: "failed", error: new Error("x") });
  assert.deepEqual(
    [session, watch, closed].map((minted) => minted?.classification.failure.id),
    [
      session?.classification.failure.id,
      session?.classification.failure.id,
      session?.classification.failure.id,
    ],
    "harness.closed, the watch end and the report share the harness episode",
  );
  assert.equal(session?.classification.failure.kind, "storage_failed");
  assert.equal(
    classifier.sessionEnd({ reason: "closed" }),
    undefined,
    "a close we asked for is not a failure",
  );

  const later = classifier.nextGeneration();
  assert.equal(later, 2);
  const afterReopen = classifier.report({ type: "session_failed" });
  assert.notEqual(
    afterReopen?.classification.failure.id,
    session?.classification.failure.id,
    "a reopen starts a new episode",
  );
});

test("each report type maps to a declared kind", () => {
  const classifier = new FailureClassifier();
  const cases = [
    [{ type: "task_parked", task: task("1") }, "task_parked"],
    [{ type: "task_faulted", task: task("2"), reason: "threw" }, "task_faulted"],
    [{ type: "task_error", task: task("3") }, "task_faulted"],
    [{ type: "migration_failed", task: task("4") }, "internal"],
    [{ type: "task_outdated", task: task("5"), reason: "missing_task" }, "internal"],
    [{ type: "extension_error", extension: "x" }, "extension_error"],
    [{ type: "extension_error", task: task("6") }, "extension_error"],
    [{ type: "host_error", callback: "now" }, "internal"],
    [{ type: "session_failed" }, "storage_failed"],
  ] as const;
  for (const [info, kind] of cases) {
    const minted = classifier.report(info as never);
    assert.equal(minted?.classification.failure.kind, kind, `${info.type} → ${kind}`);
    assert.equal(minted?.classification.failure.layer, "pi");
    assert.ok(minted?.classification.failure.id.startsWith("f_"));
    assert.ok(
      !JSON.stringify(minted.classification).includes("upstream"),
      "the report's own text never travels",
    );
  }
  const extension = classifier.report({ type: "extension_error", extension: "x" });
  assert.equal(extension?.minted, false, "a repeated extension error is the same episode");
});

test("a refused submit is not_admitted and its own episode", () => {
  const classifier = new FailureClassifier();
  const busy = classifier.refusedBusy();
  assert.equal(busy.classification.failure.kind, "limit_exceeded");
  assert.equal(busy.classification.failure.layer, "runtime");
  assert.equal(classifier.refusedBusy().minted, false);
  const failed = classifier.submitFailed(new Error("boom"));
  assert.equal(failed.classification.failure.kind, "internal");
  const session = classifier.submitFailed(Object.assign(new Error("x"), { name: "SessionFailed" }));
  assert.equal(session.classification.failure.kind, "storage_failed");
  assert.equal(
    session.classification.failure.layer,
    "pi",
    "a session failure belongs to the pi layer",
  );
  assert.equal(
    session.classification.failure.id,
    classifier.report({ type: "session_failed" })?.classification.failure.id,
    "the same session episode already reported is one identity",
  );
});
