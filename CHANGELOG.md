# Changelog

## v0.2.1 — 2026-09-19

- Compact machine headers combine freshness, inventory and sync status. CPU, memory, disk and watched ports sit above the activity column.
- Basalt buttons retain readable labels and padding in narrow layouts, including machine rename and evidence controls.
- Space columns follow available content width so an expanded sidebar cannot squeeze multi-Pane topology controls.
- Copying an onboarding prompt confirms success inside the button, keeps its width stable and resets automatically. Token copy has its own feedback.
- Onboarding is agent-neutral, recommends Hermes with an explicit command example and preserves each machine's existing model/provider/profile.

## Agent v0.4.1 — 2026-09-19

- Remove the implicit Cherry executable. Manager requires an explicit command for the machine's existing Agent; deterministic collection remains independent.
- Explain missing configuration and executable failures without exposing credentials. Preserve legacy Manager identity and state during upgrades.
- Document the stdin/stdout integration contract, verified Hermes example and equivalent adapters for other Agents.

## Agent v0.4.0 — 2026-09-19

- Independent deterministic collection and continuous Cherry semantic reporting with `manager-once` and `manager-watch`.
- Per-Pane summaries bind to tasks and evidence, with idempotent updates, freshness and UTC hourly history in each machine's Durable Object.
- Install `@nocoo/eagle-agent@0.4.0` from npm or the Tencent npm mirror.
