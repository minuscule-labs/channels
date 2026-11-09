# Diagnostic sidecar reopen race — issue #83

Status: local fix and independent coworker review passed. Current-main integration compilation, 45 focused tests, and an independent 30-cycle native macOS probe passed; required CI and verifier V&V remain pending. No tag, release, installation, or live restart performed.

## Scope

[Issue #83](https://github.com/minuscule-labs/channels/issues/83) reports an intermittent macOS `Unsafe diagnostic file` error while reopening the diagnostic journal. Its CI stack points to the pre-open optional-sidecar validation loop.

Changes are limited to:

- `packages/relay-storage-drizzle/src/diagnostics.ts`: handle a vanished optional sidecar safely.
- `packages/relay-storage-drizzle/test/diagnostics.test.ts`: deterministic unlink-race and fail-closed regressions.
- This evidence record.
- `CHANGELOG.md` and `docs/releases/v0.0.33.md`: record the correction in the prepared release notes.

The shared checkout remains on `00c289f4fd6856fc2fdb231001fdd0bade33db8a` with unrelated existing work preserved. Before this patch, the two diagnostic files matched that HEAD and the locally fetched `origin/main` versions. No branch switch, reset, or shared-file staging was performed. A scoped integration branch must exclude all unrelated edits.

## Confirmed mechanism and limits

A bounded native macOS/libSQL probe reproduced deferred cleanup unlinking the WAL after `open()` had acquired its descriptor but before `FileHandle.stat()` validated it:

- Descriptor: regular file, UID 501 (current owner), mode `0600`, `nlink=0`.
- Named WAL path: `ENOENT`.
- Original code: throws `Unsafe diagnostic file` because the descriptor no longer has one link.

The probe runs real journal close/reopen operations with `--expose-gc`; it triggers collection only after a sidecar descriptor has been acquired. This exposes the deferred native cleanup window without a production sleep, retry, or library modification. Script: `/tmp/sol-med-diagnostic-reopen-probe.mjs`, Node v22.23.0, Darwin 23.1.0, @libsql/client 0.17.4.

This confirms a mechanism matching the CI failure location. The original CI logs did not record descriptor metadata, so the exact historical CI stat condition cannot be proven retrospectively.

## Fix and safeguards

File type, owner, permissions, and `O_NOFOLLOW` protections remain enforced. For an optional sidecar only, a valid private descriptor with `nlink=0` now receives one `lstat()` of its named path:

- If the path is absent, use the existing optional-file `ENOENT` path.
- If any replacement exists, reject it; do not reopen, retry, follow it, or touch its contents.
- Other link counts still fail. An unlinked main database still fails.
- An unsafe descriptor still fails even if its path has disappeared.

The descriptor is closed through the existing `finally` block. No diagnostic schema, dependency, worker lifecycle, file mode, release gate, or CI configuration changes were made.

## Verification

Before the fix, all three deterministic optional-sidecar removal regressions failed with `Unsafe diagnostic file`. They intercept only the matching real file descriptor's stat call and unlink the actual fixture path before returning real descriptor metadata; no fabricated link count is used.

After the fix:

```bash
pnpm exec tsc -b packages/relay-storage-drizzle
node --test packages/relay-storage-drizzle/dist/test/diagnostics.test.js
pnpm exec tsc -b packages/control
node --test packages/relay-storage-drizzle/dist/test/delivery-diagnostics.test.js packages/control/dist/test/diagnostics-recorder.test.js
node --expose-gc /tmp/sol-med-diagnostic-reopen-probe.mjs
git diff --check
```

- Compilation: passed.
- Journal tests: **26 passed**, including the original CI-failing test and 13 new cases covering removal, symlink/hardlink replacement, permissive-descriptor removal for each sidecar, and main-database unlink rejection.
- Delivery-journal and recorder tests: **19 passed**, including real worker shutdown/immediate journal reopening and persisted evidence recovery.
- Native probe: **30 close/reopen cycles completed**, each observing the real WAL `nlink=0`/named-path `ENOENT` condition; original code failed on the first induced occurrence. This is a bounded race experiment, not repeated CI reruns until green.
- Whitespace checks: passed.

| File | Tested SHA-256 |
| --- | --- |
| `packages/relay-storage-drizzle/src/diagnostics.ts` | `37ff3e586dc23aa572c0b4bd1a39e5dffb9df7f2c6949c2acc771b4e4880ca8e` |
| `packages/relay-storage-drizzle/test/diagnostics.test.ts` | `9c7b1ffed9e0df95acc292a0350855d03d60d59f5aa9d8610ad37d1d76dd10cf` |

Required CI has not run against a scoped commit of this patch. Existing artifact-acceptance and connection-soak obligations remain separate.

## Independent review and scoped integration

Coworker reviewed the source change, deterministic race tests, existing privacy/authority tests, recorder callers, and native probe against main `02ac02513d9024ab83405069cf29faa7c394d661`. Verdict: APPROVE for PR/V&V; no actionable findings. This is not release acceptance.

Prepared branch: `fix/diagnostic-sidecar-reopen`, in the separate clean clone `/tmp/channels-network-lifecycle-pr.nTEr0I/repo`. The two implementation/test files match the tested hashes above byte-for-byte. The original shared branch, index, and all 52 modified/untracked files present at review start are preserved. Release-note-only updates list this correction without claiming a general native-library fix or retrospective certainty about the original CI stat condition.

Independently executed on the isolated integration target:

```bash
pnpm exec tsc -b packages/control
node --test packages/relay-storage-drizzle/dist/test/diagnostics.test.js packages/relay-storage-drizzle/dist/test/delivery-diagnostics.test.js packages/control/dist/test/diagnostics-recorder.test.js
node --expose-gc /tmp/channels-network-lifecycle-pr.nTEr0I/diagnostic-review-native.mjs
git diff --check
```

- Compilation: passed.
- Focused tests: **45 passed**, including all 13 new safety/race cases.
- Independent native probe: **30 completed reopens and 30 real unlinked private sidecars observed**, with an absent named path. The probe asserts completion, file type/owner/mode, and physical `ENOENT`; it does not treat an exit code alone as proof or fabricate descriptor metadata.
- Whitespace: passed.

Independent local logs: `/tmp/channels-network-lifecycle-pr.nTEr0I/diagnostic-review-focused.log` and `diagnostic-review-native.log`. Required PR/main CI and verifier V&V remain pending; no release gate was changed or bypassed.
