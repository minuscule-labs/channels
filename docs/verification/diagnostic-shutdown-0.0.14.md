# Diagnostic worker shutdown/reopen fix

## Observed failure

The v0.0.13 tag points to `9644460c0e5107844ef06d2547b7c66d1aee6a4c`. Its [release workflow](https://github.com/minuscule-labs/channels/actions/runs/39888673840) stopped before publication: 247/248 backend tests passed, while the real-worker lifecycle test raised `SQLITE_BUSY` reopening the diagnostic journal after `daemon.close()`.

The recorder previously returned after a journal `closed` acknowledgment, or immediately after requesting asynchronous termination. Neither proves physical worker exit. Callers could reopen/remove the native database while teardown was still in progress.

## Bounded fix

- Track the actual Worker `exit` event from construction.
- Keep the existing 500-ms flush budget, then wait at most another 500 ms for physical exit on both clean and failure/termination paths.
- If exit remains unresponsive, disclose a recording gap and request termination rather than hold optional shutdown indefinitely.
- Do not change lifecycle admission, Runtime calls, authority storage, journal permissions, schema, busy timeout, retry policy, or test/CI gates.
- This fixes the demonstrated early-return/exit race. It does **not** prove the cause or resolution of the earlier native Rust panic.

## Regression evidence

Two deterministic fake-worker regressions failed against the previous implementation: close returned before delayed exit; an acknowledged-but-never-exiting worker was not abandoned. After the fix both pass, including clean and already-failed worker modes.

A real-worker test requires the Worker exit event before immediately reopening the journal, without database-lock retries, then verifies the persisted successful operation. Existing shutdown-budget, outstanding-read rejection and lifecycle tests remain enabled.

Observed local checks:

- `pnpm check` — passed.
- Focused recorder and agent-lifecycle diagnostics files — 27 tests passed.
- `pnpm test` — 251 backend/storage tests passed.
- `git diff --check` — passed.

Linux/macOS PR CI, browser CI, release packaging/smoke and the immutable-tag release workflow must pass before publication. No claim of real-Pi acceptance is made. No real agent, existing service or real database was touched; `docs/image-support.md` is excluded.

## Release bookkeeping

No GitHub v0.0.13 release was created. Its tag is retained unchanged. The fix moves forward as v0.0.14 with the previously approved feature overview and known limitations.
