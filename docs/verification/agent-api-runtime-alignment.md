# I1 — clean pinned Runtime alignment

Implementation handoff; coworker review and verifier affected-gate confirmation pending. This supersedes the earlier Runtime-selection gap in `agent-api-author.md`, not its historical evidence or remaining CI/browser gates.

## Source and build

- Channels: `worktrees/channels/agent-api`, branch `feat/channels-agent-api`, base/HEAD `5708f7f8010167834bf615969c79536274b8c3f0`, uncommitted B2–B5 + I1.
- Assigned standalone Runtime clone: `artifacts/channels-agent-api-runtime-8239db9/runtime`.
- Detached HEAD exactly `8239db90896b5ffdff1150bf781d4fb62e90fade`, matching unchanged `runtime-source.json`.
- Runtime tracked/untracked source status clean before and after build/checks. Normal `.git` directory, no linked worktree/object alternates; local clone used `--no-local --no-hardlinks` and no dirty overlay.
- The pin object was not advertised by the source clone's refs: initial checkout could not read its tree. Fetching that exact existing SHA into the new clone resolved it; no source-repository ref was changed.
- No pinned AGENTS/CONTRIBUTING files exist; pinned README development instructions and package scripts were read.
- Node `v22.23.0`, pnpm `8.15.5`: `pnpm install --frozen-lockfile` and `pnpm build` passed without Runtime source patches. Install warned that first-build CLI targets did not exist yet; the build generated them.
- Shared `worktrees/channels/runtime` link remains unchanged, targeting `worktrees/runtime/claude-full-runtime`. Existing Runtime checkouts untouched.

## Bounded Channels delta

- `packages/control/src/local-runtimes.ts`: explicit per-adapter module > explicit `MINU_RUNTIME_ROOT` > packaged resource > existing development fallback. Missing/empty explicit roots fail clearly without borrowing another checkout. Existing access mappings are unchanged.
- `packages/control/test/local-runtimes.test.ts`: root/override/fail-closed tests, actual selected constructor identity, and bundle/restart fixtures using the same root. Without a root, packaged-resource identity is verified; with a root, explicit selection overrides packaged discovery.
- `packages/control/test/codex-cli-black-box.test.ts`: the native fixture root honors the same environment setting instead of hardcoding the sibling checkout.
- API setup docs and this evidence. No API/security code, pin, permissions or Runtime source modifications; no shared-link changes.

## Artifact identity

Full canonical path/content manifest: `artifacts/channels-agent-api-runtime-8239db9/runtime-artifacts.json`.

| Compiled JavaScript group | Files | SHA-256 of sorted path/NUL/content-hash/newline entries |
| --- | ---: | --- |
| Pi | 28 | `ba138c6a10d1348fcc67789096c2b64f0dd64f7113510dbca08ac22a036c13e4` |
| Codex | 55 | `004ffd827116ecbbac9a3d3d28f03e517e5e0b687db813263bd1a16e4b93a6d7` |
| Claude Code | 65 | `98076affaa0b9dd7fcf782c1e63ab8fe27f7591a344bf1f6e5aa9c67f60a7253` |
| Core | 7 | `ee134ce4a06462a4021cfe8c617c1d24a66143befc1b1032951780e1872fa3f6` |

Combined 155-file digest: `5fd7e1941436b308d112a8ab035746cf8c40ae0d5445a3b03d229ab42e3e301b`.

## Observed checks

Use the absolute assigned Runtime root for `MINU_RUNTIME_ROOT` in all commands below.

- `pnpm exec tsc -b packages/control --pretty false` — PASS.
- `node --test packages/control/dist/test/local-runtimes.test.js packages/control/dist/test/codex-cli-black-box.test.js` — **12/12 PASS** including nested CLI cases. All three formerly failing Runtime-loader/bundle/restart cases pass. Actual constructor identity assertions prove the selected modules came from the explicit root.
- `node scripts/smoke-agent-api.mjs` — PASS on the clean pinned Runtime. Pin match true; actual source clean. Pi/core smoke digest (35 JS files) `91f2f264919722053979a82119ffa5ef1e4c59f6321b39481a61dca3b81788ba`. One real Runtime status call, no capability calls, unchanged fixture data/transcript/worker identity; controlled final Pi RPC harness, no installed Pi/model.
- Whitespace and final source-scope checks passed.

### One corrected combined backend run — still not a full pass

`MINU_RUNTIME_ROOT=<assigned root> pnpm test` — **861 reported tests; 856 passed, 1 failed, 4 skipped**. Log: `/tmp/channels-agent-api-i1-backend-tests.log` (ephemeral). The three Runtime compatibility failures are gone, and the API/security assertions passed.

The remaining failure is a process-level **SIGSEGV** in unchanged `packages/storage-drizzle/dist/test/inbox.test.js` after both of its test assertions passed. The exact native/concurrency cause is unresolved; it is not relabeled as a passing broad run.

One bounded diagnostic run of that unchanged file alone passed **2/2**, testing the hypothesis that this is an intermittent/concurrent native-process failure rather than a deterministic assertion regression. `git diff HEAD -- packages/storage-drizzle/src packages/storage-drizzle/test/inbox.test.ts` is empty. No storage/native code was patched and no second broad run was used to hide the failure. Independent verification/CI must disposition this crash; no integration waiver is implied.

An early test-build TypeScript inference error in a dynamic module-identity assertion was corrected with an explicit `Record<string, unknown>` annotation. The recorded final build/checks passed.

## CLI child-root review correction

Coworker reproduced a gap in the initial CLI-fixture evidence: `MINU_TEST_RUNTIME_ROOT` selected native fixture imports, but the sanitized child environment omitted `MINU_RUNTIME_ROOT`. The unoverridden Claude adapter could still come from sibling discovery. The initial 12 passing cases did not prove that child selection.

The fixture now forwards both variables through one shared allowlisted environment helper, retaining its isolated HOME/registry/log roots. A new actual-CLI regression uses that same helper and a disposable root whose Claude constructor emits a unique failure marker; Pi/Codex retain their existing fixture overrides. It proves the otherwise-unoverridden Claude constructor resolves from the selected root, without adding a Claude override. The normal CLI/restart scenarios then pass with the clean pin.

Focused correction checks: TypeScript control build PASS; `codex-cli-black-box.test.js` **5/5 PASS**, including the root-selection regression and three nested normal CLI scenarios; whitespace PASS. No production loader, pinned Runtime artifact, access mapping, shared link or API implementation changed. No repeated broad/API matrix run; the SIGSEGV/CI/browser gates below remain open.

## Remaining gates

- Coworker review of I1; verifier rechecks affected Q2 Runtime/startup gates against this exact clean pinned build.
- Disposition of the single broad-run native crash; required CI and browser-state checks remain explicit, not waived.
- Publishing/PR/commit/release operations are not authorized by I1 and were not performed.
