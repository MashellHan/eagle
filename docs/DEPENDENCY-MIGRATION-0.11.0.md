# Website 0.11.0 dependency migration

This is local release preparation, not publication or deployment. The baseline
is `origin/main` at `94df39a` (website 0.10.3). Agent source stays at 0.8.3 and
published-Agent onboarding stays at 0.8.1.

## Basalt 2.2.0 to 3.2.0 (#56)

The installed 3.2.0 package supplies `README.md`, `ai/INTEGRATION.md`,
`ai/COMPATIBILITY.md`, `ai/DESIGN.md`, the component registry and declarations.
It does not include a CHANGELOG; release notes were inspected at upstream Git
tag `v3.2.0`, including the 3.0.0 and 3.1.0 changes.

- The existing Tailwind import order, React 19, Recharts 3, providers and granular
  imports already satisfy the package contract. No optional peer is added.
- The breaking Loader SVG/ref and IconPicker accessible-name APIs are unused.
- Basalt owns the updated surface hierarchy, typography, card insets, selection,
  hover and control geometry. No replacement component library or compatibility
  layer is introduced. Existing terminal rendering and product layout remain
  application-owned; this is not a whole-application design rewrite.
- Search and realtime controls use the public `sm` size instead of fixed-height
  repairs. Mobile page actions use native `lg` text buttons (`刷新`, `历史`,
  `总览`), retaining the existing 36px minimum target and 40px header budget.
- Workspace tabs keep their existing keyboard behavior and `aria-selected`, and
  expose `aria-current` for Basalt's persistent neutral selected surface. The
  additive browser assertion checks that state and rejects the old accent bar.

## Node types 25 to 26.6.5 (#9)

The manifest keeps caret style (`^26.6.5`) and the lock pins 26.6.5 with its
required `undici-types` 8.9.0. Strict typechecking initially reported TS7022 for
the summary lookup in `scripts/verify-summaries.ts`. Annotating the result with
the existing domain type, `PaneSummary | undefined`, resolves the inference
cycle without changing runtime behavior, assertion narrowing or TypeScript
settings. The live verification script was typechecked, not executed.

The repaired Node-types change passed `npm run check`: 180 tests, strict types,
check-only lint and build. No `any`, suppression or compatibility shim is added.

## Removed overrides

Use this list in a future PR body; this task does not create a PR.

| Selector or component | Removed rule | Reason |
| --- | --- | --- |
| `.board-search > svg` | Entire positioned search-icon rule and its icon | Avoid custom input-adornment positioning; the labelled native Input and placeholder identify search. |
| `.board-search input` | Left padding, 34px height and 11px font | Basalt `Input size="sm"` owns intrinsic geometry and text. |
| `.state-filters button` | Font, height, padding and gap; also the mobile padding/font rule | Restore native small Button geometry and readable default text. |
| `.live-actions > .live-theme-select[aria-label]` | Gap and font size | Use the native small SelectTrigger; retain the product's trigger width. |
| `.live-actions > button` | 32px height | Native small selects/buttons own the toolbar's height. The separate existing mobile padding rule remains. |
| `.live-navigation > button` | 32px height and font size | Native small SelectTrigger owns these; retain product flex/width constraints. |
| `.workspace-tab[aria-selected="true"]::before` | Entire accent bar | Basalt owns the persistent selected surface through `aria-current`. |
| `.workspace-tab[aria-selected="true"] > svg` | Accent color | Keep the native neutral navigation treatment rather than a second selected color system. |
| Evidence Buttons (`.evidence-item`) | `px-1 text-[10px] [&_svg]:size-3` | Native small controls retain the existing minimum-height gate without tiny text or icon overrides. |
| `SidebarHeader` | `gap-3 pr-3` everywhere; `pl-[22px]` when collapsed | Remove asymmetric collapsed padding so Basalt centers the logo. The existing expanded 22px brand inset remains to preserve its axis. |
| Sidebar toggle Button | Conditional `h-7 w-7 shrink-0` | Native icon sizing avoids constraining the new control geometry. |
| CardHelp Button | `size-6 shrink-0 text-basalt-muted-foreground` | Let the native icon button own its size and color. |
| Page action labels/icons | `hidden md:inline` labels and mobile-only navigation icon branch | Native large text actions preserve target size without an icon-size override. Desktop labels remain unchanged. |

The search wrapper's obsolete positioning is also removed. Two application
layout values, not Basalt control styles, change: the search flex basis becomes
160px to leave room for native filter buttons, and the compact Space grouping
uses `--basalt-space-md` rather than a hardcoded 10px gap. No new Basalt override
selector, token redefinition or type escape is added.

The follow-up repair changes the existing application-owned `.workspace-columns`
boundary from `overflow: hidden` to `overflow: clip`. This split-panel viewport
must clip its translated, closed inspector without becoming a scroll container.
The removed Basalt-override list above is unchanged; no control sizing, Basalt
selector, token or adaptation layer is added by this repair.

## Visual evidence

The existing browser suite writes screenshots to ignored directories:

- Before: `.local/deps-major/before/` at Basalt 2.2.0.
- After: `.local/deps-major/after/` at Basalt 3.2.0.

The same fixtures cover desktop and mobile, including 1280px dark page captures,
390px dark and 320px light page captures, both-theme desktop workspaces and
terminal views, and mobile workspace navigation. They are local synthetic
fixtures, not production or installed-Agent screenshots.

Expected differences include clearer card/selected surfaces, native typography
and sidebar spacing, wider page insets, larger evidence/filter text, segmented
multicolor resource meters in place of the former solid bars, a plain
search field, neutral workspace selection without the accent rail, and short
text page actions on mobile. At narrow widths filters can wrap and long machine
titles truncate; the application header retains the full machine name. Removing
the asymmetric collapsed-header override keeps the logo on its original axis.

## Validation record

Logs and traces are under `.local/deps-major/`. The baseline browser suite passed
187 tests with 11 pre-existing viewport-specific skips. The dependency-only
upgrade first failed 10 browser checks, establishing the migration's red phase.
No existing threshold, timeout, test skip, snapshot or gate is weakened.

An initial Node run overlapped the browser suite and hit the pre-existing 100ms
Manager lock race assertion (179/180 passed). Its unchanged six-test focused
rerun passed; subsequent complete gates run serially. Consult `CHECKPOINTS.md`
and the final controller signoff for final gate results and review status.

The new tooltip exit lifecycle also exposed a test race: the suite tried to open
the next tooltip before the previous one had unmounted. The browser check now
asserts complete tooltip dismissal after Escape before proceeding, retaining
both pointer/touch and keyboard-open checks without sleeps or larger timeouts.

### Follow-up: terminal viewport displacement

Independent bot verification disproved the original APPROVE at `2b3691a`:
Node checks passed, but the mobile terminal lost Ctrl+C from the viewport after
the selection/release sequence (five failures in five bot repeats). The trace
shows horizontal displacement, not oversized controls pushing the key row down.
Controller reproduction failed twice in five unchanged runs; instrumentation
captured `.workspace-columns.scrollLeft === 70` in another failing run. The
closed translated inspector expands this `overflow: hidden` container's scroll
area, allowing the whole workspace detail to pan while its header stays fixed.

Using `overflow: clip` preserves clipping without permitting this non-scrolling
layout boundary to pan. The unchanged terminal test passed 20 repeats in each
project. An additive regression then requests horizontal scrolling at that
boundary and requires zero displacement before all original viewport assertions.
It failed five of five mobile runs under the old rule. No viewport ratio,
timeout, selection, input, disabled-state or key-count assertion is weakened.

Red logs/traces and the bot screenshot are in `.local/deps-major/followup-red/`;
unchanged-test verification is `followup-candidate.log`, and the strengthened
test's repeated verification/screenshots are `followup-green.log` and
`followup-green/`. All evidence remains local and fixture-driven. Full clean
gate results and independent re-review are recorded in `CHECKPOINTS.md` and
the updated controller signoff; the original approval is superseded.
