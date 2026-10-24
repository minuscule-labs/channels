# Safe recent-event inspection — source audit and agreed contract

**Status:** The user approved the structured-event slice, prioritizing what **Channels and Runtime** are doing over Pi/Codex internals. Runtime [PR #10](https://github.com/minuscule-labs/runtime/pull/10) passed Ubuntu/macOS CI and merged as `e92176054206d70e120d4b6641bda2a3d037eb84`. Channels pins that merged commit and locally implements the authorized API and disposable event view; Channels packaging/PR CI and merge remain pending. This feature is not released. Phases 1–3a shipped in v0.0.14; this is a separate follow-up to [agent diagnostics](agent-diagnostics.md).

## Agreed direction

Do **not** expose existing Pi diagnostic files, transcripts or the raw event stream through Channels. The available file is bounded raw stderr/error output, not sanitized evidence. Filename ownership, permissions, escaping and free-text redaction do not establish content safety.

The agreed slice adds a new Runtime source: a fixed-field, bounded, in-memory history of **structured Runtime bridge events**, read from the existing exact-owner managed worker. Reuse Channels' existing operation timeline for routing fences, resume/launch, route attachment, settlement and cleanup observations; do not duplicate that recorder or invent cross-service ordering. Runtime adds its own admission, dispatch, control-callback and result observations. No Pi/Codex tool activity or parse-error feed is needed. This is not stderr, root-cause evidence, proof of public response delivery or approval for raw logs/exports.

## Audited target and method

- Channels baseline: merged `origin/main` / v0.0.14, `e3fc1119a20479cb630c5fc31cd425d8578e9b86`.
- Runtime source: `638ca04cfafb35bfbd7b0eaf2e6a02b3259104ab` on `feat/session-profile-inspection`; its tracked tree matches merged `origin/main` `6cd4fd25605a6b6260c50efa91bbc94e2f25dc9d`, the Channels pin.
- Both remote main refs were checked with `git ls-remote`; no new dependency pin was made.
- Audit used source/test inspection only. Implementation verification uses temporary registrations/stores, isolated HTTP servers and the existing deterministic fake-RPC worker test; no real Pi/Codex agents, existing service restarts or real-data changes.
- Normal Channels branch: `feat/safe-recent-log-inspection`, created from verified `origin/main`. Runtime implementation branch: `feat/managed-session-event-inspection`, based on merged `6cd4fd25605a6b6260c50efa91bbc94e2f25dc9d`. No unmerged Runtime pin is used. Unrelated `docs/image-support.md` is excluded and untouched.

## Confirmed source audit

Runtime paths below are relative to the sibling Runtime repository.

| Source | Observed implementation | Decision |
| --- | --- | --- |
| Owned-worker `.launch-<uuid>.log` | `packages/pi/src/client.ts` allocates a new file per worker launch; `owned-worker.ts` passes Pi stderr directly to `BoundedDiagnosticLog`, and appends startup/shutdown error strings or stacks. Registration privately stores `logFile`. | Per-launch, not a safe structured log or complete logical-session history. May contain secrets, paths and arbitrary text. Do not read/project it. |
| File writer and opener | `diagnostic.ts` defaults to a 1-MiB rolling file with restrictive modes. It stores raw bytes, can clip mid-line/UTF-8, and has no record timestamps, severity, stable page cursor or redaction contract. `openLocalDiagnosticFile` follows `stat` then spawns a desktop opener. | Writer bounds are not a browser-read security contract. `openDiagnostic` is an action with process side effects, not a read capability. No reuse or generic file-reader endpoint. |
| Raw bridge events | `owned-worker.ts` publishes native session/call/operation IDs, message deltas, tool names and arbitrary error messages. `server.ts` `/events` is a live SSE feed, not retained paginated evidence. | Do not return or subscribe to this stream for logs. A new producer can independently record only curated event codes and worker observation times. No event-object spreading. |
| Messages/transcripts/manifests | `messages()`/`get_messages` returns message content; managed manifests retain private launch/resume material. | Not log sources or unavailable-read fallbacks. No prompt reconstruction or filesystem parsing in Channels. |
| Attached/legacy sessions | `extension.ts` registers attached sessions without managed owner scope or a diagnostic file/getter. | Unsupported in the first slice. No global discovery or inference from unrelated registrations. |
| Session-profile inspection | `client.ts` uses `inspectRegistration`, exact owner/session request headers, bounded decoding, cancellation, physical slots and registration revalidation; `server.ts` has a separate managed-worker read route. | Reuse the read-only boundary pattern, not the profile data as historical log evidence. |
| Registry reads | `readRegistration` can delete stale registrations; `listRegistrations` enumerates and cleans up. `inspectRegistration` is bounded, rejects unsafe registrations and returns only private identity/connection fields, not a log path. | Use the pure exact-registration peek. Do not call cleanup/discovery readers or extend it to expose file contents/paths. |

Existing Runtime tests in `packages/pi/test/runtime.test.ts` verify authenticated local opening and basic file size/mode behavior. `session-profile.test.ts` covers the existing optional profile boundary, including owner/worker isolation, unsafe registrations, replacement, redirects, cancellation and stalled physical slots. Neither establishes a safe log-content source.

## Runtime slice — merged

### Source and privacy

- Added optional `inspectSessionEvents(managedSessionId, ownerId, { signal? })` and `GET /session-events`, with a separately versioned `runtime_bridge` snapshot. Channels now pins the separately merged Runtime implementation; no Channels release is claimed.
- Only an already-running, exact-owner managed worker with the new source supports it. No start/resume/wake, attach, discovery, manifest/transcript/log access, local opener, cleanup or configuration writes. Do not probe launch capabilities.
- Record synchronously into a fixed-size worker-local ring at existing event observation points. No disk journal, background stream subscription, RPC calls or new lifecycle authority. Recording must not delay/fail a turn, interruption or shutdown.
- Construct each record from constants and validated fixed enums only: bounded sequence, worker-observed ISO timestamp and event code. Codes: `bridge_ready`; `turn_accepted`, `turn_reused`, `turn_rejected_conflict`; `turn_dispatch_requested`, `turn_dispatch_returned`, `turn_dispatch_failed`; `turn_completed`, `turn_failed`; `request_rejected_busy`; `steer_requested`, `steer_acknowledged`, `steer_failed`; `interrupt_requested`, `interrupt_acknowledged`, `interrupt_failed`; `stop_requested`. Requested/returned/acknowledged are distinct from settlement, physical exit and Channels delivery. Harness events do not enter this source.
- No free-text message/stack, arbitrary tool name, argument, output, prompt, model response, native/private ID, operation ID, path, token or arbitrary extra field. Failure codes identify Runtime boundary outcomes, not causes. Do not invent severity; timestamps mean worker observation, not native occurrence.
- Record only after the worker has verified its selected native session and bound its managed identity. No import of earlier events, reconstructed history or raw-file backfill.

### Bounds, identity and coverage

- Implemented fixed limits: latest **200 events**, **32 KiB UTF-8 total wire envelope**, **two-second read deadline** including registration and response decoding. No client-selectable source/path/command/URL, arbitrary size, filter or cursor in the first slice. This replaces, rather than silently adopts, the parent proposal's 256-KiB/1-MiB text-page defaults.
- Return capture time, recording-since time, ordered events and explicit eviction/partial-history coverage. An empty supported snapshot means zero retained observations in this recording window, not proof of health or a complete session history. A restarted/resumed worker begins a new window; sequence continuity is not promised across workers.
- Client and bridge enforce exact managed identity and owner. Recheck the private registration tuple (session/owner/endpoint/token/PID) after decoding, as the profile reader does; discard changed workers. Do not send that tuple to Channels/browser responses.
- Share one physical read slot per selected session and at most 16 reads per Runtime client across optional profile/event reads; retain slots until underlying work settles, even after timeout/cancellation. Consumers must tolerate contention without interpreting it as offline. Bridge snapshots are synchronous/bounded, with a response slot retained until finish/close and a two-second response deadline. Reject oversized, malformed and unsupported-version responses; no redirects or raw transport errors.
- Version-one session capabilities remain compatible. Support is established by the optional read contract, never by `openDiagnostic`. Missing optional method/old route, sleeping/offline/unreachable worker, legacy mapping, ambiguous identity and unsafe registration return unavailable/unsupported without waking anything. Failed reads do not prove the worker is offline.
- No persisted logical-session history, historical worker selection or pagination. The fixed ring already bounds producer retention and read work. Search, if later desired, can only filter an already-authorized bounded snapshot and requires a separate decision.

## Channels boundary and UI — implemented

- Dedicated authorized `GET /local/conversations/:conversationId/agents/:identityId/session-events`, separate from reports. Use the existing active-human, active-Workspace owner/admin and Conversation-participant predicate, including archived/read-only Conversations; validate the selected agent/service participant.
- Capture the exact current binding/activation tuple before reading; require matching Workspace, Conversation, participant, adapter, managed session, owner, binding ID/generation and activation. Reauthorize after Runtime content I/O, then revalidate the tuple as the final private read, with same-browser-session validation immediately before HTTP delivery. A replacement while authorization is delayed is fenced too. Discard changed snapshots rather than relabeling old events as the replacement's.
- Use the existing bounded exact activation lookup; no all-session enumeration or unbounded history scan. Preserve the session-profile exclusion of transitional/sleeping/offline/disabled bindings; an already-existing idle worker on a paused binding may be read without Start.
- Independently allowlist the Runtime response at Channels, enforce wire bounds, return `no-store`, propagate request cancellation and retain physical slots for unsettled work. No lifecycle locks or diagnostic writes in authoritative operations.
- Use disposable human/browser-session/Workspace/Conversation/participant ownership. Opening the section and explicit Refresh read the current bounded window; no polling or persistent stream for this section. Abort and clear on close, navigation, authorization/session loss and observed replacement; fence late results and clear previous events before refreshing.
- Render fixed curated event labels and observation times as text. Use concise headings, controls and status labels only: no new explanatory UI microcopy/helper text. Never treat content as HTML, commands, local links or instructions.
- Keep events out of normal member responses, shared caches, browser storage, the cross-tab SharedWorker, clipboard reports and downloads. Existing sanitized report behavior stays unchanged.
- Added structural contracts, an independent fixed-field projection and client route; shared local-control protocol is **21**. No schema migration. The event read shares the existing inspector's 16 physical metadata slots. The browser serializes event/profile/report reads instead of queuing optional work behind a busy resource; an unavailable read is never labeled offline.

The existing fencing and disposable-state implementations are references, not evidence that the new route automatically inherits every safeguard. See Channels `packages/control/src/{agent-session-inspection,agent-diagnostic-reads,server}.ts` and `packages/web/src/{lib/operation-diagnostics.ts,components/operation-diagnostics.tsx}`.

## Delivery order and verification gates

1. **Source/contract agreed:** structured events, focused on Channels/Runtime rather than harness internals, current-worker-only retention and fixed bounds. No raw export authorization follows from this choice.
2. **Runtime first (done):** producer/projection/client/bridge tests use temporary registrations, deterministic fake RPC and isolated servers. Author review found no unresolved actionable issue; PR #10 passed Ubuntu/macOS CI before merge. Channels pins only its merged commit.
3. **Channels API/state/UI (locally implemented):** exact-scoped API, disposable UI and compatibility behavior. Temporary stores only; no schema or lifecycle changes.
4. **Integration (in progress):** author code review against the agreed contract and full local regression/build checks pass as recorded below; clean-package verification and Channels PR CI/merge follow. Prior Phase 3a/release checks are not being substituted for this feature's tests.

Required negative cases:

- Cross-human/Workspace/Conversation/participant/session/owner reads; member denial; disabled/revoked identities and participation; browser-session expiry/rebinding before delivery.
- Replacement, stop/resume transition, owner/adapter/generation or worker-registration change during a read; stale/late responses after close, navigation or replacement.
- Arbitrary secret/prompt/tool-output/path/native-ID canaries in raw harness events, error messages, tool names and unknown fields never enter the producer's safe snapshot or any response/report/cache. No stderr source is consumed.
- Exact 200-entry retention, eviction coverage, bounded bytes and integer/time validation; malformed/oversized/trickling responses, unknown versions, redirects, cancellation and stalled physical slots.
- Old/unsupported/attached/sleeping workers; corrupt/stale/symlinked/unsafe registrations rejected without cleanup, migration, launch or discovery. No raw-log file access at all.
- New recording windows after worker replacement; empty is not healthy/complete; loss of optional recording does not change lifecycle outcomes or responsiveness.
- Browser role/session loss, no requests after close, no shared/persisted sensitive cache, mobile/keyboard access and literal-text rendering. Copy report remains a fresh independent authorized read with no event/log addition.

### Runtime author verification

Target: Runtime implementation `68fe19a661df2b52507e616fec9504c0d50bf075`, merged as `e92176054206d70e120d4b6641bda2a3d037eb84`, based on `6cd4fd25605a6b6260c50efa91bbc94e2f25dc9d`. New source/contracts: `packages/core/src/session-events.ts` and `packages/pi/src/session-events.ts`; integration: core optional port, Pi client/bridge, tests and README. No dependency/schema changes. The profile client shares its existing bounded-read implementation and budget with the new event read.

- Focused producer/projection/client/bridge and existing profile checks passed while building. An initial type check caught an incorrect test-helper overload type; it was corrected to Node's `RequestListener` before tests ran.
- Final `pnpm -C ../runtime check` and `pnpm -C ../runtime test` passed: **52 tests**, including the existing profile/lifecycle regressions. Node `v22.23.0`, pnpm `8.15.5`; Node emitted its existing experimental-SQLite advisory. The managed-worker test verifies actual owned-worker wiring, owner denial, no wakeup of suspended workers, privacy and a new event window after deterministic fake-RPC worker resume.
- `git diff --check` passed in both repositories; documentation relative links and all changed/new Runtime files' trailing whitespace passed. `docs/image-support.md` retains SHA-256 `5fe3cd095c3606b3da9551a39b46d730e29968231fa11c453ea43990ade257e7`.
- Exact reviewed/tested Runtime file set: `README.md`, `packages/core/src/{index,session-events}.ts`, `packages/pi/src/{client,server,session-events}.ts`, `packages/pi/test/{runtime,session-events}.test.ts`. SHA-256 of sorted relative filename + NUL + file bytes + NUL: `3854120e84a5704deb0aa348a7be3dbc852a1af3917f6c05e2977c48f5390e60`.
- Author source/diff review covers the complete Runtime working change, including new files, against this agreed scope. It caught a possible busy-read error being recorded as a control event; recording is now restricted to control/turn POST rejections, with a regression test. No unresolved change-related defect is known. This is not independent review, Ubuntu/macOS CI, real-Pi acceptance or release approval.
- Runtime PR #10 subsequently passed Ubuntu/macOS CI before merge; the reviewed file fingerprint is unchanged. CI run: [40135583889](https://github.com/minuscule-labs/runtime/actions/runs/40135583889).

### Channels author verification

Target: `feat/safe-recent-log-inspection` working change from Channels `e3fc1119a20479cb630c5fc31cd425d8578e9b86`, with merged Runtime pin `e92176054206d70e120d4b6641bda2a3d037eb84`.

- `pnpm check`, `pnpm web:check`, `pnpm test` (**260 backend/storage tests**), `pnpm web:test` (**151 tests**), `pnpm web:test:browser` (**107 Chromium tests**) and `pnpm web:build` passed. The production build retains its existing non-fatal chunk-size advisory.
- API checks include real Channels HTTP authentication with temporary stores, exact scope/owner/generation checks, fresh authorization and final metadata fencing, privacy, unsupported/unsafe sources, bounded retention, 16 physical slots surviving cancellation, response disconnects, deadline/late-result fencing and report exclusion. An initial check caught protocol-v20 test fixtures after the deliberate protocol bump; fixtures/expectations were updated before passing checks.
- Browser checks include explicit open/Refresh only, close/navigation cancellation, disabled-human/membership/Workspace/role/session/participation loss, observed replacement, safe errors, literal-text rendering, curated labels, empty/evicted windows, mobile/keyboard access and no member queries. Existing lifecycle/timeline/report regression tests remain enabled.
- Author source/diff review covers all changed/new production code and tests, including the independent Channels event allowlist and merged dependency. No unresolved change-related defect is known; this is not independent review or release approval.
- Clean-package integration and Channels PR CI/merge are pending at this checkpoint. No real Pi/Codex agent, existing service or real database was used.

Fresh real-Pi/clean-account acceptance still requires separate scoped approval. The unresolved native database panic is unchanged; see [v0.0.14 caveats](releases/v0.0.14.md) and [shutdown evidence](verification/diagnostic-shutdown-0.0.14.md).
