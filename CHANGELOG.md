# Changelog

## v0.2.2 — 2026-09-19

- Sidebar machine items show glowing online, stale-snapshot and offline indicators in expanded, collapsed and mobile layouts.
- A Basalt settings page reuses next-ai provider configuration and a fixed seven-section Chinese report template. API keys can be saved, replaced, tested and cleared in the UI; authenticated encryption protects them in a separate DO configuration record, with the wrapping key in Worker secrets.
- Hourly Cron combines each machine's independent factual and semantic streams, defaults to a one-hour cadence and skips unconfigured AI.
- Durable leases, protected pending results, late-input revisions and a unique machine/hour D1 archive prevent duplicate reports and preserve failed writes for retry.
- History supports machine/hour queries, chronological pagination and detailed report expansion without remounting during refresh.

## v0.2.1 — 2026-09-19

- Compact machine headers combine freshness, inventory and sync status. CPU, memory, disk and watched ports sit above the activity column.
- Basalt buttons retain readable labels and padding in narrow layouts, including machine rename and evidence controls.
- Space columns follow available content width so an expanded sidebar cannot squeeze multi-Pane topology controls.
- Copying an onboarding prompt confirms success inside the button, keeps its width stable and resets automatically. Token copy has its own feedback.
- Onboarding is agent-neutral, recommends Hermes with an explicit command example and preserves each machine's existing model/provider/profile.

## Agent v0.4.1 — prepared, npm publication pending

- Remove the implicit Cherry executable. Manager requires an explicit command for the machine's existing Agent; deterministic collection remains independent.
- Explain missing configuration and executable failures without exposing credentials. Preserve legacy Manager identity and state during upgrades.
- Document the stdin/stdout integration contract, verified Hermes example and equivalent adapters for other Agents.

## Agent v0.4.0 — 2026-09-19

- Independent deterministic collection and continuous Cherry semantic reporting with `manager-once` and `manager-watch`.
- Per-Pane summaries bind to tasks and evidence, with idempotent updates, freshness and UTC hourly history in each machine's Durable Object.
- Install `@nocoo/eagle-agent@0.4.0` from npm or the Tencent npm mirror.
