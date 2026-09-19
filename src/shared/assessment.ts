import {
  type Evidence,
  type Pane,
  type Report,
  STATE_LABEL,
  type State,
} from "./schema.ts";

export function assessPane(
  pane: Pane,
  at: string,
): { state: State; reason: string; evidence: Evidence[] } {
  const latest = new Map<Evidence["kind"], Evidence>();
  for (const item of pane.evidence) {
    const age = Date.parse(at) - Date.parse(item.observedAt);
    if (item.taskId !== pane.task.id || age > 86_400_000 || age < -300_000)
      continue;
    const prior = latest.get(item.kind);
    const rank = { success: 0, unknown: 1, running: 2, waiting: 3, failure: 4 };
    if (
      !prior ||
      Date.parse(item.observedAt) > Date.parse(prior.observedAt) ||
      (Date.parse(item.observedAt) === Date.parse(prior.observedAt) &&
        rank[item.status] > rank[prior.status])
    )
      latest.set(item.kind, item);
  }
  const evidence = [...latest.values()];
  const attention = evidence.find(
    (e) => ["failure", "waiting"].includes(e.status) && e.kind !== "process",
  );
  if (attention)
    return { state: "attention", reason: attention.summary, evidence };
  const active = evidence.find(
    (e) =>
      e.status === "running" &&
      ["goal", "process", "test", "deployment"].includes(e.kind),
  );
  if (active) return { state: "active", reason: active.summary, evidence };
  const required: Evidence["kind"][] = [
    "summary",
    "goal",
    "git",
    "test",
    ...(pane.task.requiresDeployment ? ["deployment" as const] : []),
  ];
  const revision = latest.get("git")?.revision;
  const missing = required.filter((kind) => {
    const item = latest.get(kind);
    return (
      item?.status !== "success" ||
      (["git", "test", "deployment"].includes(kind) &&
        (!revision || item.revision !== revision))
    );
  });
  if (missing.length === 0)
    return {
      state: "verified",
      reason: latest.get("summary")?.summary ?? "完成证据一致",
      evidence,
    };
  const names = {
    summary: "最终总结",
    goal: "Goal",
    git: "Git",
    test: "测试",
    deployment: "线上验证",
    process: "进程",
  };
  return {
    state: "unverified",
    reason: `待补充或核对：${missing.map((k) => names[k]).join("、")}`,
    evidence,
  };
}

export function summarize(report: Report) {
  const counts: Record<State, number> = {
    verified: 0,
    active: 0,
    attention: 0,
    unverified: 0,
  };
  const spaces = report.spaces.map((space) => {
    const panes = space.tabs
      .flatMap((tab) => tab.panes)
      .map((pane) => ({ pane, ...assessPane(pane, report.capturedAt) }));
    for (const p of panes) counts[p.state]++;
    const state: State = panes.some((p) => p.state === "attention")
      ? "attention"
      : panes.some((p) => p.state === "active")
        ? "active"
        : panes.length && panes.every((p) => p.state === "verified")
          ? "verified"
          : "unverified";
    const lead = panes.find((p) => p.state === state);
    return { space, state, panes, summary: lead?.reason ?? "暂无任务证据" };
  });
  return { counts, spaces };
}

export function changesBetween(before: Report | null, after: Report): string[] {
  if (!before)
    return [
      `首次接入：${after.spaces.length} 个 Space，${after.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes)).length} 个 Pane`,
    ];
  const changes: string[] = [];
  const old = new Map(summarize(before).spaces.map((s) => [s.space.id, s]));
  for (const current of summarize(after).spaces) {
    const prev = old.get(current.space.id);
    old.delete(current.space.id);
    if (!prev) {
      changes.push(`${current.space.name}：新增 Space`);
      continue;
    }
    if (prev.state !== current.state)
      changes.push(
        `${current.space.name}：${STATE_LABEL[prev.state]} → ${STATE_LABEL[current.state]}`,
      );
    if (prev.space.objective !== current.space.objective)
      changes.push(
        `${current.space.name}：目标更新为 ${current.space.objective}`,
      );
    const previousPanes = new Map(prev.panes.map((p) => [p.pane.id, p]));
    for (const p of current.panes) {
      const previous = previousPanes.get(p.pane.id);
      previousPanes.delete(p.pane.id);
      if (!previous)
        changes.push(
          `${current.space.name}：新增 ${p.pane.agent || "终端"} ${p.pane.id}`,
        );
      else if (
        previous.pane.task.id !== p.pane.task.id ||
        previous.pane.task.title !== p.pane.task.title
      )
        changes.push(`${current.space.name}：${p.pane.task.title}`);
      else if (previous.reason !== p.reason)
        changes.push(`${current.space.name} / ${p.pane.agent}：${p.reason}`);
    }
    for (const p of previousPanes.values())
      changes.push(`${current.space.name}：Pane ${p.pane.id} 已关闭`);
    if (
      JSON.stringify(
        prev.space.tabs.map((t) => [t.id, t.panes.map((p) => [p.id, p.rect])]),
      ) !==
      JSON.stringify(
        current.space.tabs.map((t) => [
          t.id,
          t.panes.map((p) => [p.id, p.rect]),
        ]),
      )
    )
      changes.push(`${current.space.name}：拓扑布局更新`);
  }
  for (const closed of old.values())
    changes.push(`${closed.space.name}：Space 已关闭`);
  return changes.slice(0, 100);
}
