# Manual Runtime recovery — implementation evidence

## Scope and source

- User-approved increment: distinct **Stop runtime** and **Restart runtime** actions, available for uncertain owner-scoped managed sessions, preserving the existing transcript and keeping Fresh session separate. Failed/unconfirmed shutdown must not authorize restart. Automatic recovery policy changes are deferred.
- Channels: `feat/runtime-session-recovery`, working-tree changes over `6719e6d`.
- Runtime: adjacent `../runtime`, `feat/runtime-session-recovery`, working-tree changes over `accf23c`. That baseline already includes the separate startup-diagnostics change; it is not the currently pinned release source.
- No authoritative schema migration, installed-app update, real-provider agent run, existing service restart, or real-data mutation was performed.

## Implementation

Local-control v24 adds `stop-runtime` / `restart-runtime` receipt actions and an optional managed-binding recovery capability. Existing browser authentication, owner/admin checks, participant admission, pending guards and archived read-only controls apply. Both roster layouts require explicit confirmation and retain inspection while recovery is pending.

The host fences delivery before stopping the exact owner/session worker, retires the previous route, waits for physical shutdown and old routing settlement, then commits the pause boundary. Restart rechecks authority and the original binding generation/Runtime identity before reopening the same transcript. It does not create a replacement or change activation/context settings. Failures retain the stopping/paused fence; explicit retries never reacquire delivery until recovery succeeds.

Runtime adds `forceStopManaged` with a persisted explicit-resume fence. Stale automatic resumes cannot undo a manual stop; explicit Start/Restart passes `allowStopped`. New POSIX workers have dedicated process groups and a controller-authorized startup handoff. Signal fallback verifies the worker executable, exact session/owner flags, unambiguous arguments and process group before escalation. Legacy shared-group workers receive only targeted TERM and require observed descendant exit. Missing legacy exit evidence fails closed. Native shutdown waits for exit rather than merely delivering KILL.

## Observed checks

- Channels `pnpm check`, `pnpm web:check`; Runtime `pnpm check`: passed on final source.
- Channels `pnpm test`: **339 passed**. After the final expected-binding filter adjustment, affected host/Relay tests: **76 passed**.
- Channels `pnpm web:test`: **178 passed**. `pnpm web:build`: passed, with the existing large-chunk warning.
- Runtime `pnpm test`: **66 passed** at the integration checkpoint. Subsequent signal-identity hardening and dead-legacy-writer guard: **6 focused recovery cases passed** on final source.
- Runtime client and owned worker were bundled into disposable ESM artifacts using the release bundler's Node 22/esbuild settings. The final **6 recovery cases also passed against those bundles**, with controlled fake Pi RPC, not real provider agents.
- Browser coverage: **127 distinct cases passed across two invocations**. The initial full invocation reached 110 successful cases before the 300-second shell budget expired; only its identified orphaned test fixtures were terminated. The remaining 17 cases plus the strengthened archived/read-only case passed in an 18-case completion invocation. No browser assertion failed.
- `git diff --check`: passed in both repositories.

Focused cases cover busy turns, a frozen bridge/process group, owner denial, same-transcript restart, duplicate resume serialization, persistent manual-stop fencing, invalid transcript preservation, legacy shutdown, dead legacy bridge uncertainty, unrelated/reused PIDs, owner-prefix/argument spoofing, host restart after unconfirmed shutdown, authorization loss, generation changes, SQLite and memory storage, receipt deduplication/authentication, and uncertain/minimized/read-only UI controls.

One bundled test initially failed because its test-only expected executable path had not resolved macOS's temporary-directory symlink. The fixture was corrected to use the real path; final bundled checks above passed without relaxing production identity checks.

## Delivery limitations

- These are author checks, not independent review, live-provider acceptance or release approval.
- `runtime-source.json` remains pinned to `7bd8a689dec0776d0b1fd5642d1a97353c9b251b`. The new Runtime implementation must be committed/integrated and Channels pinned to that reviewed revision before reproducible release packaging. No fabricated or dirty-source release pin was added.
- Official `release:pack` / installed-tarball smoke were not run: both source trees are intentionally uncommitted and the release Runtime pin has not been integrated. Disposable bundle verification is not a substitute for those release gates.
- Signal fallback was exercised on macOS. Unreachable Windows workers and unverifiable legacy descendants remain unconfirmed/fenced rather than receiving unsafe broad kills.
