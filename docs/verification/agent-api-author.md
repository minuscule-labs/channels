# Channels Agent API — B5 author integration evidence

Status: implemented; coworker integration review and Q2 independent acceptance pending. Not release-ready approval.

## Target

- Worktree: `worktrees/channels/agent-api`, branch `feat/channels-agent-api`.
- Base/HEAD: `5708f7f8010167834bf615969c79536274b8c3f0`, with uncommitted B2–B5 changes.
- Environment: Node `v22.23.0`, local macOS; disposable HTTP/SQLite fixtures only.
- No production credentials/shared conversations, installed Pi/model calls, commits or pushes.

## Delivered first transport

`POST http://127.0.0.1:47411/api/agent/v1/conversation/inspect` (actual control origin/port configurable).

Bearer transport key + explicit JSON target; no browser cookie/selection, active agent turn or Runtime caller binding. Production daemon composes the accepted B2 credential service, B3 authorization and B4 bounded status projection. Current resource policy is active human Workspace owner/admin inspection entitlement; no separate private-thread ACL currently exists. Scope and parent checks remain independently enforced.

Input parsing shares B4's eight-slot admission and five-second deadline rather than occurring before either budget. The body is capped at 1 KiB, extra fields/queries and duplicate auth headers are denied, and client disconnects abort the operation. No other agent operation or transport is advertised/enabled; legacy service/human endpoints do not accept agent keys.

## Verification

### Build and HTTP/migration focused checks

`pnpm exec tsc -b packages/control` passed.

```sh
node --test \
  packages/relay-storage-drizzle/dist/test/account-library.test.js \
  packages/relay-storage-drizzle/dist/test/agent-account-skills.test.js \
  packages/control/dist/test/agent-inspection-http.test.js
```

**12/12 passed** after the fixture corrections described below. The six HTTP tests use the production daemon and real core HTTP/private SQLite. They cover headless round trips and future threads, indistinguishable target denial, strict transport/body handling, legacy/admin/lifecycle separation, in-flight rotation/revocation, client disconnect, and a slow incomplete body bounded by the whole deadline.

`git diff --check` passed.

### One broad backend run — NOT a full pass

`pnpm test` ran once against the combined backend: **858 tests; 849 passed, 5 failed, 4 skipped**. Log: `/tmp/channels-agent-api-backend-tests.log` (ephemeral; summarized here).

Two failures were introduced migration-fixture incompatibilities: the old account-library and agent-account-skills tests start from today's schema, rewind migration markers, and manually drop later tables. They did not drop the new `agent_credentials` table, so reopening attempted to recreate it. Corrected each fixture's schema rewind to drop that table too. Their focused rerun passed; the new actual-0028-to-0029 migration test also passed in the broad run. Production migration/schema were not changed to hide the failures.

Three remaining failures are environment/baseline Runtime-loader incompatibilities in unchanged `local-runtimes.test.ts`:

1. local runtime loading exposes all per-agent adapters without starting work;
2. bundled adapters keep isolated worker resources and Codex resumes the same history;
3. real Codex adapter serves per-agent Conversation turns across product-controller restart.

All fail constructing the external Codex adapter: `Codex Runtime only supports read-only or workspace-write sandboxing`. The local runtime loader requests the baseline's `danger-full-access` policy; the external built Runtime selected by that path does not support it. The stack identifies `worktrees/runtime/claude-full-runtime/.../client.js` (or its bundled copy), not the API implementation.

Baseline evidence: read the loader directly from commit `5708f7f...`, verified it byte-matches the unchanged worktree source, transpiled that committed loader into a temporary generated sibling module and invoked it with the same environment. It reproduced the identical constructor failure before product/API composition. Removed the generated probe afterward. No Runtime source/configuration or access policy was changed. Required integration/CI gates remain outstanding; do not describe the broad suite as green or infer a new total from focused reruns.

Early HTTP-test author failures were fixture-only: TypeScript disallowed an authorization-array object header; the replacement raw duplicate-header request initially omitted Host and was rejected by Node HTTP parsing. The final fixture sends a proper Host and verifies the handler's 401 duplicate-header denial.

### Real Runtime-owned-worker boundary

```sh
MINU_RUNTIME_ROOT=/absolute/path/to/runtime node scripts/smoke-agent-api.mjs
```

Final run **passed** through actual Channels daemon HTTP, private SQLite, Pi Runtime client, Runtime-owned worker and `/status` HTTP. Only the final Pi RPC harness is controlled; no installed Pi or model is invoked. A live fixture worker intentionally not attached to Relay is correctly projected as `disconnected` (the genuine Runtime status is `idle`).

Observed: **one real status call, zero capability calls**; public conversation/messages/cursor, private binding records, Runtime transcript and managed-worker identity/state were unchanged. The fixture's owned worker and all temporary data were cleaned up.

Actual Runtime evidence:

- HEAD: `b635afc09060be40db3d23a54d865bd972822f3e`; source checkout dirty.
- Compiled Pi/core JavaScript: 33 files; canonical path/content digest `c3de13d0042b854958551d96ce9dd36f4071ae3bb4d1b1302a74bcaff2274f42`.
- Channels Runtime pin: `8239db90896b5ffdff1150bf781d4fb62e90fade` — **does not match actual Runtime HEAD**.

The script computes this artifact identity on every run rather than pretending the pin identifies the loaded code. This is actual Runtime-boundary evidence for the identified compiled artifact, not proof of a clean pinned Runtime build or genuine installed-harness/workflow acceptance.

## Remaining gates

- Coworker integration review of the completed B5 changes, then verifier Q2 black-box acceptance on an identified integrated target.
- Q1's independent case catalog/preparation remains verifier-owned; do not substitute author tests for that acceptance.
- Required CI/full regression/build/release gates, including resolution or explicit disposition of the external Runtime-loader incompatibility. No repeated broad run was used to conceal the known failures.
- No UI, MCP/OAuth, search, messages, monitoring, management or lifecycle expansion is included.
