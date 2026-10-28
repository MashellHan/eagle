# Upstream checks and merge attempts

The macOS LaunchAgent runs one serialized tick at local 00/04/08/12/16/20.
Installation requires the host's UTC+08:00 timezone. Each tick checks the current
upstream/local/fork combination; 00/08/16 also attempts a merge. RunAtLoad catches
up once for the latest missed period. Failed attempts remain failed and do not
loop through missed periods.

[The driver](../scripts/upstream-sync.py) uses an OS flock for the complete run.
A surviving lockfile is not a live owner. The source checkout is read-only to
this script; all fetches, merges, checks and commits happen in isolated candidates.
Source HEAD and a dirty-content fingerprint accompany each report. Semantic
comparison uses a captured copy, not successive reads of the changing worktree.

Only the explicitly configured MashellHan/eagle feature/integration branch may
receive a normal push. The driver verifies that GitHub identity, installs project
hooks with prepare, preserves failed merge candidates, and stops on any failed
dependency install, root/browser/Bots/Swift gate, independent review or concurrent
target advancement. It never force-pushes, opens a PR or deploys. Missing pinned
dependencies and Xcode are failures, not reasons to skip gates.

Read-only comparison/review uses the configured Astra max CLI and cannot write
code. A successful unchanged comparison is cached by its exact evidence inputs.
Reports distinguish source/base/upstream/target/candidate commits, uncommitted
merge trees, attempted steps, downstream steps not run and actual push outcome.
Secret configuration is not copied into candidates or passed to tests.

Runtime configuration, logs, cadence markers and retained candidates live in the
user's private ~/Library/Application Support/Eagle/upstream-sync/ directory.
The installed job status and first-run evidence must be recorded in
[CHECKPOINTS.md](CHECKPOINTS.md); this contract alone is not enablement evidence.

The driver accepts status, run --mode check, run --mode merge, disable and enable.
Disable sets launchctl's persistent disabled state for this exact service and
boots it out; enable clears that state and bootstraps the retained plist. Status
reports both loaded and disabled. These commands do not target other jobs.
Interrupts stop the whole tick. Timeout cleanup is bounded; unconfirmed cleanup
prevents subsequent modes. Preparation saves fetched SHAs and step logs as it
progresses. Publication requires the gated, committed and reviewed trees to match,
including after commit hooks.
Push requires exactly one effective approved destination and disables automatic
tag following. Any interrupted/timed-out child step stops the entire tick;
reaping its direct child alone does not certify detached descendants have stopped.
The Lead uses the same flock for foreground publication and reconciles any
advanced fork branch before pushing local work. Do not delete the lockfile,
reset a retained candidate, or bypass hooks to recover a failed attempt.
