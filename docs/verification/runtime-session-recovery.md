# Manual Runtime recovery — implementation evidence

## Scope and source

- User-approved increment: distinct **Stop runtime** and **Restart runtime** actions, available for uncertain owner-scoped managed sessions, preserving the existing transcript and keeping Fresh session separate. Failed/unconfirmed shutdown must not authorize restart. Automatic recovery policy changes are deferred.
- Channels implementation: `fdd2483` over `6719e6d`, subsequently integrated with current `origin/main` (`caaad6a`) without source conflicts.
- Runtime implementation: `4af5154` over `accf23c`, integrated with current `origin/main` (`ec229f1`, including startup diagnostics and startup-timeout fixture stabilization). [Runtime PR #18](https://github.com/minuscule-labs/runtime/pull/18) merged as `86f81102db9ddacade58009d040a95253188992b`; `runtime-source.json` now pins that merged revision.
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

## Merge integration checkpoint

The user authorized integration with the current updates. Runtime `pnpm check` / `pnpm test` passed with **68 tests** after merging current main; Runtime PR #18 also passed its Ubuntu and macOS CI jobs before merging. Channels now pins that exact merged Runtime revision, rather than a dirty source checkout or an unpublished dependency commit. Official release packaging and installed-tarball smoke are additional integration gates; their outcomes are recorded on the Channels recovery PR after building the clean pinned commit.

## Delivery limitations

- Local results are author checks; GitHub CI is separately observed automation. Neither is independent review, live-provider acceptance or release approval.
- Disposable bundle verification alone is not a substitute for clean pinned release packaging and installed-tarball smoke.
- Signal fallback was exercised locally on macOS and by Runtime CI on Ubuntu/macOS. Unreachable Windows workers and unverifiable legacy descendants remain unconfirmed/fenced rather than receiving unsafe broad kills.
- Merging does not publish a release, update the installed application or restart existing agents.
