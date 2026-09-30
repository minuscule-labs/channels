# Idle sleep release checklist

Scope: an **opt-in** Channels release. Deployment alone does not enable automatic sleep; existing Workspaces stay Off. Default-on rollout and per-agent overrides are separate work.

## Code and review

- [x] Runtime managed-session primitives merged and pinned in `runtime-source.json` (`32b39c04`).
- [x] Phase 2 core committed locally (`c3bf2c0`); prior code review approved the core change.
- [x] Workspace policy is owner/admin writable, private, durable, Off by default, and can be changed for already-attached bindings.
- [x] Idle scheduler skips binding reads for Off Workspaces and caches policy per Workspace per pass. Policy failures, including a stalled read, fail closed for that Workspace without blocking sleeping reconciliation in another Workspace.
- [x] Regression coverage includes policy disable/wake, storage migration, queued work and restart, and unrelated failing/stalled Workspace policy reads.
- [x] Commit the Workspace policy change separately from the Phase 2 core.
- [ ] Review the final policy diff for unexpected privacy, ownership, cursor, lease, and migration changes. Resolve only concrete integration blockers; record deferred work separately.
- [x] Open [Phase 2 core PR #33](https://github.com/minuscule-labs/channels/pull/33) against `main` and [Workspace policy PR #34](https://github.com/minuscule-labs/channels/pull/34) stacked on the core branch. Retarget #34 to `main` after #33 merges.

## Verification and delivery

- [x] Local `pnpm check`, `pnpm test` (179 passing), `pnpm web:check`, `pnpm web:test` (33 passing), and focused browser settings test passed on the policy branch.
- [x] Local real-Pi smoke passed managed start, idle status, suspend, same-session resume, and destroy **without a model turn**.
- [ ] Confirm CI on both PRs, including macOS/Ubuntu Node checks, Chromium browser tests on Ubuntu, and release-package build/smoke with the exact pinned Runtime commit. The current local Runtime checkout is not at the pinned commit, so local release packaging cannot be treated as validated.
- [ ] Before recommending Workspace opt-in outside a controlled trial, exercise transcript continuation through a real Pi model turn in a disposable Workspace with appropriate credentials, cost approval, and cleanup.
- [ ] Keep the deployed default Off. Document how owners/admins opt in and how turning Off affects an already-sleeping agent.

## Later rollout (not an opt-in release gate)

- [ ] Measure worker resource savings, wake latency, and failure rates before considering a default-on policy.
- [ ] Consider per-agent overrides, distinct sleeping/waking UI states, and owner-scoped orphan cleanup as separate phases.
