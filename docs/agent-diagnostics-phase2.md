# Agent diagnostics Phase 2 — storage and failure-isolation review

**Status:** Merged in PR #40 as `3c3da28`; the checkpoints below preserve the implementation, review and acceptance evidence. Daemon-owned individual/bulk/Relay/cleanup recording and protocol-v19 authorized history/detail/report reads are implemented. Safe failure projections expose the public trigger sequence; selected-operation detail/report reads distinguish exact targeted-trigger evidence from uncorrelated failures. The privileged open-surface timeline/report UI and revocation-safe browser state are implemented. Author completed-feature security/integration review is recorded below with no actionable findings. User-approved isolated real-Pi acceptance passed; see the live acceptance record below.

**Baseline:** `a2e9dd3` (merged Phase 1, PR #39). Working branch: `feat/agent-diagnostics-phase2`.

**Parent specification:** [Agent diagnostics and operation review](agent-diagnostics.md).

## Approved placement and policy

Retain the seven-day / 1,000-terminal-operation / 128-event / 50-record-page defaults, with three clarifications:

1. Store diagnostic history in an **optional owner-private companion journal**, not in the SQLite connection/file used for lifecycle fences, leases, cursors, and session history. This changes the original proposal's physical storage placement, not lifecycle ownership or the public Conversation boundary.
2. Protect admitted active summaries, but cap diagnostic tracking and queued snapshots. When diagnostic capacity is exhausted, continue the lifecycle operation and disclose incomplete recording; never reject or delay Stop merely to preserve its timeline.
3. Treat command acceptance, Runtime acknowledgment, turn settlement, binding commit, and cleanup as different observations. In particular, Cancel's HTTP success is not cancellation completion.

The user approved this placement, bounded best-effort policy, and starting budgets. The remaining sections describe Phase 2 requirements; they do not imply that every capability has been implemented or activated.

## Evidence from current code

| Evidence | Design consequence |
| --- | --- |
| `DrizzleLibSqlRelayStorage.open` enables WAL and `busy_timeout = 5000` in `packages/relay-storage-drizzle/src/storage.ts`. This database owns binding CAS transitions, leases, cursors, session history, and failure finalization. | Merely not awaiting an extra write does not isolate SQLite contention or synchronous driver work. A failed optional journal must not prevent the authoritative store from opening. |
| `LocalAgentHost.startConversationAgent`, `replaceConversationAgent`, `reconnectConversationAgent`, and `stopConversationAgent` serialize transitions through `exclusive` in `packages/control/src/agent-host.ts`. | Instrument existing authoritative boundaries; do not add a second lock, reorder transitions, or use diagnostics to decide eligibility. |
| `ConversationRuntimeRelay.cancelCurrent` sets canceling state, invokes `requestRuntimeInterrupt`, and returns without waiting for acknowledgment or turn settlement (`packages/relay/src/relay.ts`). | The operation remains pending after HTTP success. Relay must emit acknowledgment and settlement observations for the exact targeted turn. |
| `stopConversationAgent` persists `beginStopBinding` before draining; an error can leave the same generation in stopping or paused state. | An HTTP error does not prove the operation had no effect. Keep confirmed fencing/commit evidence and distinguish unsuccessful request handling from unknown final lifecycle outcome. |
| Replacement commits a new binding before attaching it and cleaning up the retired session. | Preserve committed-generation evidence if later attachment fails. Retired-session cleanup is related work, not evidence that replacement attachment failed. |
| Existing audit events use accepted/rejected, often emitted at method return; existing host diagnostic callbacks have no operation ID. | Neither stream can be reinterpreted as a complete ordered operation journal. Preserve existing audit semantics and add an explicit observer context. |
| Failure records already retain private binding ID/generation plus public trigger identity/sequence, but detailed safe projections currently omit the trigger sequence. | Add an explicit safe trigger reference. Link an operation only where an exact observation/correlation exists; do not join by time or route alone. |
| `authorizeTurnFailureAccess` requires an active human, active Workspace membership and Conversation participation; detailed projections additionally require owner/admin. | Use equivalent server-side checks for every new history/detail/report read, including archived/read-only Conversations. Cookie authentication alone is insufficient. |

## Ownership and storage

- Agent-host owns lifecycle observations; Relay owns its admission, interruption, active-turn settlement, and delivery observations.
- Runtime adapter contracts remain generic. An agent-host observation that a Runtime call returned is not a Runtime-emitted event or proof that work settled.
- A small dedicated diagnostic store/recorder is separate from `RelayBindingStore`'s authoritative mutation contract. Existing failure persistence and its finalization/tombstone rules remain authoritative and unchanged.
- Journal file: `agent-diagnostics.db` beside the existing private Relay data, with an independent additive migration history. Local file only; no browser-supplied path or remote database URL.
- Create the private directory/files safely; reject redirected/symlinked journal paths, and enforce owner-only access including SQLite sidecars. If this cannot be done, diagnostics is unavailable, not a reason to fail product startup.
- Run diagnostic database work in a dedicated Node worker. The host-facing observer performs only bounded validation/copying and nonblocking enqueue; never open/read/migrate/prune the journal on the lifecycle event loop.
- The companion database avoids sharing Relay's SQLite writer lock. This is not a guarantee against shared disk exhaustion, CPU pressure, process crashes, or filesystem failures; payload/queue bounds and fault tests still matter.
- Journal failure, migration failure, incompatible schema, or worker startup failure must leave ordinary status, messaging, and all existing lifecycle safety paths available. Never fall back to writing diagnostic events into the authoritative database.
- No automatic import of historical audit messages and no reconstruction of old operations from binding timestamps. Pre-upgrade activity is explicitly unrecorded.

### Tables and indexes

Approved journal-only schema:

- **Recorder epochs:** random writer-instance identity and clean/incomplete shutdown state. These are diagnostic provenance, not Runtime owner tokens or lifecycle leases.
- **Operations:** opaque operation ID, durable insertion ordinal, Workspace/Conversation/participant scope, action/kind, optional bulk parent, optional explicitly related operation, request/acceptance observations, outcome, retention-close time, monotonic elapsed duration when known, last confirmed stage, and coverage counters.
- **Events:** operation ID, authoritative per-operation emission sequence, observation time, elapsed duration when measured, source, allowlisted stage/result/reason, and optional public trigger sequence. No arbitrary JSON/log/message payload.
- **Private correlations:** operation-scoped source/target binding ID and generation, exact trigger reference, and explicitly associated cleanup-job reference when available. No raw Runtime credentials, owner tokens, transcript paths, prompts, or tool arguments are needed.

Indexes:

- Unique operation ID; unique `(operation_id, sequence)`.
- History keyset index `(workspace_id, conversation_id, participant_identity_id, ordinal)`.
- Bulk-child lookup `(parent_operation_id, ordinal)`.
- Terminal pruning `(retention_closed_at, ordinal)` and pending-epoch lookup `(recorder_epoch, outcome)`.
- Private exact-scope correlation indexes, not timestamp-based association.

Events and their summary update commit atomically **within the journal only**. There is no cross-database transaction or foreign key to binding/session-history authority. Deleting diagnostic records must never delete, pause, restore, or otherwise mutate an agent or its history.

## Bounded recording and retention

| Item | Approved starting rule |
| --- | --- |
| Terminal history | Expire after seven days **or earlier** when the installation-wide 1,000-terminal-record cap is exceeded. Seven days is a maximum, not a promised minimum. Bulk parents/children and cleanup operations count toward the cap. |
| Active diagnostic tracking | At most 128 simultaneously tracked lifecycle/cleanup operations. Existing operations retain their summary slot. Additional operations still execute but may have no recorded timeline. |
| Pending write queue | At most 128 coalesced operation snapshots; retain at most one queued snapshot per operation. Bound serialized snapshot bytes as well as item count. Never accumulate an unbounded chain of promises or timed-out writes. |
| Events | At most 128 retained events per operation, with a slot reserved for its terminal observation. Preserve final outcome and latest confirmed-stage summary even when intermediate events are omitted. Keep emission-sequence gaps and dropped counts visible. |
| History pages | Default/max 50 summaries, using validated bounded keyset cursors. Reauthorize the requested scope on every page. No offset scans or unbounded installation dump. |
| Terminal pruning | Journal-worker batches, separate from recording/lifecycle transactions. Never prune pending summaries to make room for terminal history. |
| Read/report work | Two-second journal read budget, 64-KiB report maximum, and bounded selected-operation events/failure summaries. Cancellation affects reads only. |
| Shutdown | 500-ms diagnostic flush budget after lifecycle shutdown ownership is respected. Unflushed evidence may be lost; do not extend a Stop/close deadline to complete reporting. |

Additional requirements:

- Normal rejected/unauthorized requests remain covered by existing audit behavior. Do not create unlimited durable diagnostic operations before authorization and lifecycle admission.
- Queue/capacity failure changes **recording coverage**, not lifecycle admission. Return/disclose an unrecorded correlation ID where a request can carry it; an ID is not a promise that a record was persisted.
- Once the writer stalls, stop submitting further work to it. Do not implement repeated `Promise.race` timeouts that leave old database work running while new writes continue. Fence late worker replies by recorder epoch; restart only after the old worker is actually closed/terminated.
- A terminal coalesced snapshot supersedes earlier queued progress, not vice versa. Checkpoint/final summaries never regress because an older reply arrives late.
- Bulk parents retain observed totals and missing-child coverage when terminal children are pruned or could not be admitted. Do not pin all children indefinitely or cascade-delete active children.
- Do not add an unbounded tombstone per expired operation. A missing detail is described as unavailable/expired/not recorded unless exact expiry is known; never assert expiry just because lookup failed.
- Keep all fixed fields/IDs/labels bounded. Queue bounds expressed only as event counts are insufficient if an event can contain arbitrary text.

## Outcome and ordering contract

The base outcomes remain `pending`, `succeeded`, `failed`, and `unknown`; request disposition and recording coverage are separate fields.

- **Pending:** the responsible component is still observing an admitted operation, including Cancel awaiting its targeted turn's settlement.
- **Succeeded:** the action's actual completion predicate was observed. A successful HTTP response or interrupt request alone is insufficient.
- **Failed:** the relevant negative result was confirmed. Preserve any previously confirmed effects; this does not mean rollback occurred.
- **Unknown:** acknowledgments were ambiguous, some required completion evidence was lost, or the observing process ended. This is not permission to retry/recover automatically.

Assign operation IDs and event sequences in the responsible observer before enqueue. Sequence, not wall-clock timestamp or database completion order, determines event order. Persist measured monotonic elapsed durations; do not reconstruct a continuous elapsed duration across a process restart.

On journal startup, pending records from a previous recorder epoch become **unknown** with an observer-loss reason. Do not invent an actual finish time: keep observed closure/retention time distinct from lifecycle finish time. Do not call Runtime, resume a worker, attach a route, or retry cleanup merely to finish the diagnostic record.

### Instrumentation boundaries

- **Start/resume:** distinguish new launch from exact-session resume; report committed binding and successful attachment only after those respective calls confirm them.
- **Stop:** observe durable fencing, Relay drain/settlement, Runtime interrupt request/acknowledgment where actually needed, stop boundary/pause commit, and detach separately. Idle/sleeping interruption is explicitly skipped, not acknowledged.
- **Replacement/Fresh:** preserve source and committed target generations privately. Handoff skipped/prepared, activation boundary, launch, binding commit, attachment, and retired cleanup are distinct. A committed replacement with uncertain attachment cannot be collapsed to “nothing changed.”
- **Reconnect:** verify/reattach the existing exact session; never describe an unrelated new session as reconnect success.
- **Cancel current:** pass a diagnostic-only context into Relay for the captured binding generation and active trigger. Observe acknowledgment and actual settlement there without making the existing HTTP method wait or issuing another interrupt. Repeated requests during canceling do not become additional Runtime interrupts.
- **Bulk:** parent plus explicit per-target child context. Preserve the existing three-worker concurrency and target-snapshot guards. Parent labels/counts expose failures, skipped targets, and unknown children; aggregate HTTP acceptance must not mean every target succeeded.
- **Cleanup:** separate related operations/attempts for the retired exact generation. Persist the explicit cleanup relation in the journal when observed; after restart, missing correlation remains uncorrelated. Never find an origin by nearest timestamp or assume a missing source session belonged to the latest replacement.

Observer calls must not throw into lifecycle code. Runtime-adapter-specific parsing, recovery, transcript inspection, and new capabilities are outside this phase.

## Failure correlation

- Expose the already-recorded public trigger sequence in each safe detailed failure projection; use exact Conversation/participant/trigger scope to select the issue.
- Carry exact binding generation and active-turn correlation internally at the point of an observation. A shared session/route or nearby time alone does not prove that a failure belongs to an operation.
- Typed relations distinguish an operation's targeted trigger, an observation during an operation, and retired-session cleanup. Do not present correlation as causation.
- Existing failures without explicit operation evidence remain visible as **uncorrelated**. Preserve existing categories, delivery outcomes, remediation, finalization, retention, and minimal member-facing notices.
- New best-effort events must not enter or weaken the existing durable response/failure/cursor commit loop.

## Safe reads and reports

Implemented control protocol increment: **18 → 19**, using the shared constant and additive browser-safe contracts.

Implemented GET-only routes (the report requires an `operationId` query parameter):

```text
/local/conversations/:conversationId/agents/:identityId/operations
/local/conversations/:conversationId/agents/:identityId/operations/:operationId
/local/conversations/:conversationId/agents/:identityId/diagnostic-report
```

- Derive the actor from the authenticated browser session; require active human identity, active Workspace owner/admin membership, and active Conversation participation on **every** read. Archived/read-only Conversations remain inspectable.
- Validate Workspace/Conversation/participant/operation and bulk-child relationships server-side. An operation ID or cursor grants no authority. Wrong-scope and unauthorized detail lookups must not reveal record existence.
- Historic targets are selected from the authorized stored Conversation scope; their removal must not make an ID a cross-Workspace lookup capability. Label unavailable/historic display information honestly.
- Project allowlisted fields. Keep private generation/session correlation, native Runtime IDs, owner tokens, PIDs, filesystem paths, message bodies, prompts, raw errors, and logs out of normal responses.
- Query only while the privileged surface is open; reuse Phase 1 status reads instead of adding per-participant background polling. Poll pending history in a bounded way only for the authorized open surface. Read aborts must never cancel lifecycle work.
- Scope cache keys by current human and resource. On permission/session loss, abort outstanding diagnostic reads and remove privileged caches/report previews; fence late responses so they cannot repopulate a new scope.
- Reports use format version 1, protocol/app version where actually available, capture and source-observation times, one selected bounded timeline, relevant safe failures, and explicit coverage/refresh/uncertainty notes. Do not invent an app version when absent.
- Preview is local and escaped text/JSON. **Copy report** makes a fresh permission-checked read, then copies the returned sanitized snapshot. Report generation cannot launch a worker, retry a mutation, read raw evidence, or publish a Conversation message.
- Do not save reports in browser storage. Explain clipboard failures without logging report content. Previously copied/disclosed data cannot be retrospectively revoked; clearing caches is not a claim that it can.

## Delivery sequence after approval

1. Add a testable journal/recorder contract, independent journal migrations/worker lifecycle, bounded retention, gap/epoch handling, and fault tests. Do not modify production/development databases to test it.
2. Add typed host/Relay observer contexts at existing boundaries, exact failure/cleanup correlations, and bulk-child tests. Keep lifecycle tests green with diagnostics missing, rejecting, throwing, stalled, and over capacity.
3. Add protocol-v19 authorized history/report projections and safe client APIs; test scope isolation, role/session revocation, hostile fields, size bounds, pagination and missing history.
4. Add operation selection/timeline, issue links, report preview/copy, and open-surface refresh to participant details. Preserve Phase 1 pending guards, multi-tab transport, read-only/member/mobile/minimized/focus behavior.
5. Verify upgrades on temporary fixtures, complete repository/web/browser/build checks, and prepare a separately scoped Phase 2 PR with any manual acceptance gaps stated explicitly.

## Required verification

- Observer failures (including synchronous throws), queue overflow, writer death, locked/corrupt/unwritable journal, failed diagnostic migration, and slow reads do not change lifecycle outcomes or introduce an awaited recording dependency.
- No shared Relay SQLite connection/transaction; no extra lifecycle lock or recovery action; bound worker startup, outstanding writes, termination, reads and shutdown.
- Delayed/lost interrupt acknowledgment; Cancel HTTP return before settlement; Stop fenced but not confirmed; replacement committed but not attached; cleanup failure after successful attachment; repeated Cancel and competing Stop; exact generation/trigger isolation.
- Old-epoch pending records become unknown without Runtime calls. Normal and incomplete shutdown preserve truthful coverage. A delayed previous-epoch reply cannot overwrite newer state.
- Terminal retention boundaries, more than 1,000 terminal records, active protection/capacity exhaustion, more than 128 events, final-slot reservation, coalescing, bulk pruning, cursor stability and concurrent eviction.
- Fresh/legacy installation fixtures preserve existing identities, bindings, transcripts, session history, cursors and failure-finalization behavior. Optional journal failure does not make the product migration/startup fail.
- Owner/admin/member and cross-Workspace/Conversation/participant tests; selected operation/bulk-child isolation; revocation while reads and copy are pending; late-response cache cleanup.
- Report secret/path/prompt/raw-error canaries, hostile text, byte-size clipping, unavailable sources, explicit gaps, unknown outcomes, clipboard rejection, and no network publication.
- Browser operation history/report access during delayed individual/bulk requests, read-only Conversations, keyboard/minimized/mobile layouts, and multiple tabs.

## Checkpoint 1 — journal/recorder foundation

Implemented as an isolated first package:

- Shared allowlisted diagnostic records, request disposition separate from lifecycle outcome, and safe summary/detail projections.
- `DiagnosticJournal` in `packages/relay-storage-drizzle/src/diagnostics.ts`: independent transactional version-one schema and migration ledger, owner-private file/sidecar checks, exact private binding/generation/trigger/cleanup correlations, scoped keyset reads, seven-day expiry, and the installation-wide terminal cap. Existing non-journal databases are rejected before persistent PRAGMAs or migration.
- `DiagnosticRecorder` and `diagnostics-worker.ts` in `packages/control/src`: bounded admission and coalescing, terminal-event reservation, monotonic durations, epoch-fenced acknowledgments, bounded reads/shutdown, and fail-closed optional worker handling. Epoch loss closes pending evidence as unknown without inventing a lifecycle finish or making Runtime calls.
- Release packaging includes the worker; the release smoke script checks its isolated startup/read/shutdown.

At this foundation-only checkpoint, the daemon did not instantiate the recorder and there were no lifecycle observer calls, HTTP routes, protocol increment, browser queries, or report UI. Lifecycle integration is covered by the following checkpoint; authorized reads and UI remain future work. A journal fixture passing alone does not establish lifecycle integration correctness.

Verification observed for this package:

- `pnpm check`, `pnpm web:check`, and `git diff --check` passed.
- `pnpm test`: **213 repository tests passed**, including **21 new journal/recorder tests**. Coverage includes independent migrations, refusal to migrate authority files, private paths/sidecars, exact correlations, retention/capacity, coalescing, stale replies, startup/crash/stall faults, monotonic timing, and bounded shutdown/read cleanup.
- `pnpm web:test`: **127 web tests passed**. No browser behavior has changed; the full Playwright suite has not been rerun for this package.
- `MINU_ALLOW_DIRTY_RELEASE=1 pnpm release:build` passed, including the web build and release-content checks. The existing Vite large-chunk advisory remains.
- A freshly packed tarball passed `scripts/smoke-release-package.mjs`, including the installed bundled diagnostic worker and fresh/reopened/browser-first application startup on temporary data. No agent was started.

All database changes during verification are confined to temporary test fixtures. Existing dev/production databases, services, agents, bindings, transcripts, and the unrelated image-support draft are untouched. This is not an independent/child-session review.

## Checkpoint 2 — daemon and lifecycle connection

- `daemon.ts` starts the optional recorder without awaiting its readiness. It uses `agent-diagnostics.db` beside `relay.db` (a basename-qualified companion for custom Relay filenames). Product startup never falls back to journaling into Relay authority. The recorder flushes after host lifecycle shutdown, with its existing 500-ms budget; startup-failure cleanup also closes it. Process-local health is available to the daemon owner, not through an unauthenticated HTTP endpoint. `recordAgentDiagnostics: false` disables recording.
- `lifecycle-diagnostics.ts` and Relay's safe observer adapter isolate synchronous factory/observer exceptions. Lifecycle methods never await a diagnostic write, and diagnostic outcomes never determine lifecycle decisions.
- Start/resume, replacement/Fresh, reconnect, and Stop observe existing admission and authoritative boundaries. Source/target binding generations remain private. Binding commit, attachment, pause commit, interruption, and detach are distinct observations. Idle/sleeping interruption is skipped, never fabricated as an acknowledgment. Failures after effects preserve those confirmed effects and conservatively close as unknown.
- Cancel creates its observation only after Relay admission. Relay captures the exact binding generation and active public trigger. Its host handler may return while the operation remains pending. Acknowledgment and committed terminal settlement are separate; lost acknowledgment is unknown. Repeated Cancel gets an explicitly skipped/unknown observation without another interrupt or an unbounded observer list. A competing Stop observes the existing interruption but owns its own final pause outcome.
- Retired-session cleanup is a separate explicitly related operation for the retired generation; transport ambiguity does not turn replacement attachment into failure. Existing startup cleanup retries use the exact loaded cleanup-history ID and generation, with no origin reconstructed from time or the current binding. Owned sessions retained by the host also carry explicit shutdown-cleanup scope. Temporary handoff-summarizer internals are not reconstructed as agent operations.
- A fast terminal record can receive its later host-handler disposition through bounded re-admission, without regressing the outcome or retaining unbounded completed handles.

Verification:

- Eight new lifecycle integration tests cover exact generations, stopped-session reuse, reconnect without launch, uncertain Stop fencing, replacement committed but not attached, cleanup failure and exact-job retry, Cancel acknowledgment/settlement and competing Stop, observer factory/callback failures, stalled/saturated recording, and healthy/corrupt journals through authenticated daemon Start/Stop. All use fake runtimes and temporary stores. The lifecycle suite also passed ten consecutive runs (**80 test executions**).
- `pnpm check`, `pnpm web:check`, `pnpm web:test` (**127 passed**), and `git diff --check` passed. The full repository rerun passed **221 tests**.
- One earlier full run exposed the existing stale-directory-lock arbitration race (`local-paths.ts`, two winners instead of one). Its implementation and test are unmodified. The isolated check and full rerun passed; this remains a separate concurrency follow-up, not a weakened assertion or a claimed diagnostics fix.
- Release build/content checks and the installed-tarball smoke passed, including the bundled diagnostic worker and temporary fresh/reopened/browser-first application startup. No agent was started by the release smoke.

At this checkpoint, bulk parent/child totals and missing-child coverage remained outstanding; these are covered below. A subsequent delegated contextual review approved this bounded checkpoint with no actionable findings; that approval does not include the newer bulk work.

Still required: authorized history/detail/report projections and exact failure links, protocol-v19 contracts, privileged open-surface timeline/report UI, revocation/report/browser verification, and the separately acknowledged real-Pi acceptance gap. The running dev service and existing agents/databases were not restarted or modified; this wiring activates on a normal subsequent daemon start.

## Checkpoint 3 — bulk parent/target observations

- A parent is admitted only after the existing bulk discovery/Workspace owner-or-admin authorization succeeds. It records the original target total and incremental results without storing an unbounded target-ID list. The existing three-worker limit, result ordering, per-target admission, and exact binding snapshot guards are unchanged.
- Aggregate journal scope uses the initiating human's identity as its subject; every child keeps its own agent target scope and explicit parent ID. This is provenance, not read authorization. Future reads must authorize the current human against the stored Workspace/Conversation and validate any child-to-parent relation, never treat the stored initiator or an operation ID as a capability.
- Actual Start/resume/Stop observations are the target children, not additional duplicate timelines. Skips and pre-admission failures get explicit assessed children. Internal child handlers use `not_applicable` request disposition because they are not independent HTTP requests.
- `bulkTarget` is the allowlisted handler result (`started`, `stopped`, `skipped`, or `failed`, plus a finite reason). It must be displayed as such, not as an invented launch/interrupt. The lifecycle outcome remains separate: for example, a failed Start handler can leave an unknown lifecycle outcome. Known already-running/idle no-op targets are distinguished from uncertain/offline skips and confirmed missing-configuration/replacement-required negatives.
- Parent counters retain `targets`, `completed`, `started`, `stopped`, `skipped`, `failed`, `unknown`, and `childrenUnrecorded`. The four handler-result counts sum to completed; unknown is an overlapping count of observed lifecycle uncertainty. Incomplete observer-loss parents preserve partial counts, not invented results for unassessed targets. HTTP acceptance is separate from overall success, partial failure, or uncertainty.
- Recorder and journal reject counter regression or target-total reassignment. Target results are immutable once set. A late target assessment can add its bounded summary after the underlying child terminal snapshot was acknowledged, without reopening its lifecycle outcome.
- Read-time `childrenUnavailable` counts completed target results without a currently retained, same-Workspace/Conversation child result. It is computed, not accepted from snapshots. Unavailable can mean unrecorded, expired/pruned, or not yet persisted; it is not asserted expiry. Parent counts survive child pruning. Pruning a parent does not cascade into pending children, and children are not pinned indefinitely.
- All added payloads are fixed counters/enums. No authoritative schema, HTTP response, control protocol version, lifecycle lock, retry, or Runtime capability was changed.

Verification for this checkpoint:

- Five bulk integration tests cover three-worker concurrency, stable ordering, exact-session resume, idle skips, mixed failed/skipped/unknown results, rejected authorization without recording, empty snapshots, a competing individual Start that invalidates the bulk snapshot, and partial diagnostic capacity with successful target starts. Existing missing/throwing/stalled/saturated observer tests now also exercise bulk Stop/Start.
- Two storage tests cover strict projections and malformed values, immutable/monotonic metadata, scoped missing-child counts, exact partial-progress retention across an observer epoch change, child expiry, and non-cascading parent pruning. A real-worker recorder test covers late target metadata and counter-regression rejection.
- `pnpm check`, `pnpm web:check`, `pnpm web:test` (**127 passed**), and the final repository suite (**229 passed**) passed. The focused diagnostics suite passed **37 tests**; lifecycle/bulk integration passed five consecutive runs (**65 executions**).
- A fresh release build, package/content checks, and installed-tarball smoke passed, including bundled-worker startup/read/shutdown. Browser tests and real-Pi acceptance were not rerun for this backend-only checkpoint. No existing service, agent, or authoritative database was restarted or changed.

Work-review scope: bulk observation bookkeeping and its recorder/journal contracts, on top of the previously reviewed but uncommitted checkpoint. Existing observer isolation, scoped projections, three-worker concurrency, snapshot guards, and queue limits remain required. **Gate: PASS** for this bounded bookkeeping package; no required findings remain. This is not approval of the unfinished Phase 2 API/UI or a new delegated review. Before integration, review the completed feature and its authorization/compatibility contracts. At this checkpoint, protocol-v19 authorized reads and exact failure links remained outstanding; those are covered below.

## Current checkpoint — authorized history/detail/report APIs

- `agent-diagnostic-reads.ts` is a read-only service with no lifecycle mutation or raw-evidence capability. It shares the existing failure-access predicate: current active human, active Workspace owner/admin membership, and active Conversation participation. It authorizes before I/O and again before returning privileged data. Settled/read-only Conversations remain inspectable. HTTP routes additionally reauthenticate the same browser session/scope immediately before releasing a response; responses are `no-store`.
- The three GET routes above are daemon-wired even when recording is disabled/unavailable. Missing/corrupt journals return explicit unavailable coverage, not lifecycle errors or fallback writes. Detail misses are described as unavailable/unrecorded/pruned/expired/not-yet-persisted, never asserted expiry. Wrong-scope IDs disclose no foreign record. Targets are selected only by exact persisted Workspace/Conversation/subject scope; removed targets use an honest historical/unavailable label rather than a global identity lookup.
- History remains a maximum 50-record keyset page with a fixed insertion high-water mark; syntax and safe-integer cursor validation precede journal submission, after authorization. Every page reauthorizes. Parent links require a retained same-Workspace/Conversation bulk parent and matching action; reading that parent through an agent route requires an exact retained child for that target. Cleanup-origin links require the same stored Workspace/Conversation/target scope. Typed detail relations distinguish bulk parents from retired-session cleanup.
- Existing detailed turn-failure responses now expose `triggerSequence` without exposing private message/binding references. Selected detail/report reads include at most 16 relevant safe failures from up to 100 retained Conversation failures. Exact binding generation plus trigger identity/sequence determine `targeted_trigger`; same public trigger without exact evidence stays `uncorrelated`. Lookup faults are `unavailable`, not absence. Exact selection is included in the journal correlation query, so an older selected operation is not lost behind the ordinary 50-link lookup bound. Correlation is not causation.
- Format-one reports include protocol version, capture/source-observation times, an authorized bounded label, the selected timeline, safe current state/diagnostics when available, and explicit uncertainty/gap/coverage notes. App version is omitted when unavailable. Current status reuses the Phase 1 projection for only the selected target, without querying every other participant's Runtime. UTF-8 JSON is capped at 64 KiB; clipping is explicit and preserves first/final timeline observations where possible. No raw logs, native/session/owner IDs, paths, prompts, raw errors, transcript bodies, publication, or retry is included.
- The whole selected journal/failure read block has a two-second budget on top of the recorder's bounded serialized worker reads. A late result cannot submit follow-up correlation reads after the block deadline. Browser client methods accept abort signals, retain cancellation through body decoding, and never invoke a lifecycle endpoint. No browser queries, cache, persistence, preview, or clipboard behavior have been added yet; each future Copy must call the report API afresh.

Verification for this bounded API package:

- **10 new API/client tests** cover authenticated GET-only access, active human/role/membership/participation checks, read-only inspection, historic targets, exact/wrong-generation failure evidence (including more than 50 related operations), wrong Workspace/Conversation/target IDs, forged relations, missing/unavailable journal coverage, stable pagination, cursor validation, bulk parent/cleanup relations, revocation and session expiry during report reads, hostile label/secret canaries, UTF-8 clipping, deadline/late-result isolation, and caller cancellation through body decoding.
- Existing real-worker tests now exercise exact correlation over the worker boundary; healthy/corrupt-journal daemon tests exercise the authenticated APIs and report path while retaining fake-runtime Start/Stop assertions. No real agent was started.
- Final repository suite: **239 passed**. Focused API/recorder/lifecycle/journal suite: **47 passed**. `pnpm check`, `pnpm web:check`, `pnpm web:test` (**127 passed**), and `git diff --check` passed. Protocol fixtures were advanced to 19. A fresh release build/content check and installed-tarball smoke passed; the existing Vite large-chunk advisory remains.
- Author security/integration inspection covered this API package and its immediate authorization, worker, persistence-read, and client boundaries. This is not a new delegated review, nor approval of the unfinished Phase 2 UI. Browser/Playwright and real-Pi acceptance were not performed for this backend-only package. Existing services/agents and real databases were not restarted or modified.

Work-review **Gate: PASS** for the bounded authorized-read package, with no remaining required findings found by the author. At this checkpoint the UI and browser verification remained outstanding; these are covered below. The subsequent explicitly requested delegated API review approved this bounded backend checkpoint with no actionable findings; that approval does not cover later UI changes.

## Current checkpoint — open-surface timeline and reports

- Privileged agent details now support bounded history pages, latest/older navigation, explicit operation selection, source/capture times, local result filters that do not change report contents or invent sequence gaps, request handling separate from lifecycle outcome, last-confirmed milestones, measured elapsed times, sequence gaps, and retained-event coverage. Missing details are not labeled definitely expired. Bulk handler results, overlapping unknown counts, missing children, and the initiating-human subject remain distinct. Only server-projected bulk/cleanup relations are navigable; no timestamp/session reconstruction is performed.
- Existing issue notices carry their exact public trigger and failure time into selection. Detailed issue selection additionally requires the same participant; a coincident timestamp cannot select another trigger. Loaded trigger links close inspection, close the mobile drawer when needed, scroll to the public message, and move keyboard focus. Unloaded messages are explicitly unavailable; navigation does not retry, send, or acknowledge anything.
- History/detail/report projections use disposable in-memory ownership keyed by current human, Workspace, Conversation, and target, not shared Query caches, local/session storage, or cross-tab messages. Each read lane has its own abort controller plus a late-result fence. Closing, navigation, observed identity/session/permission loss, or diagnostic access/resource denial clears the owned projections; selection also aborts old detail/report work. Shared authorization inputs refresh every five seconds only while the privileged surface is mounted. This is observation of access changes, not instantaneous server-pushed revocation or retrospective revocation of already disclosed/copied data.
- Existing status reads are reused without a new Runtime-status poller. Pending history/detail refresh is bounded to five-second reads for at most one minute per open/explicit refresh, using a monotonic browser deadline; read errors stop automatic refresh. A pending browser request also keeps this bounded refresh active before its first journal snapshot persists, without claiming host acceptance or synthesizing an operation. Diagnostic read cancellation never cancels lifecycle work. Older Phase 1 privileged cache projections are canceled/removed on observed access/identity loss and relevant navigation.
- Report previews render escaped JSON locally. Formatting preserves the 64-KiB UTF-8 report budget, falling back to compact JSON rather than silently expanding a near-limit snapshot; oversized responses are rejected before preview/copy. Every Copy performs another permission-checked report read and copies that fresh snapshot, not preview data. Clipboard/read failures expose curated messages without report/error logging. No browser persistence, publication, raw-log export, lifecycle retry, or recovery capability is introduced. The surface explicitly states that previously copied data cannot be revoked.

Verification for this bounded browser package:

- `pnpm test`: **239 passed**; `pnpm check`, `pnpm web:check`, relative documentation links, and `git diff --check` passed. Final `pnpm web:test`: **141 passed**, including **14 new ownership/report tests** for scoped memory, aborted/late history/detail/report results, HTTP denial, fresh-read Copy, clipboard faults, stale/missing evidence, disposal, and UTF-8 formatting limits.
- Full isolated Chromium suite: **97 passed**, including **19 new diagnostics browser cases**. Coverage includes role revocation during pending history/detail/Copy, session/identity/membership/participation/Workspace loss, exact trigger issue selection despite matching timestamps, pagination/relations/bulk labels, unknown/gapped/unavailable history, escaped previews, fresh Copy/faults, no publication/storage, navigation, delayed individual/bulk Stop, minimized keyboard focus, read-only mobile navigation, multi-tab isolation, and bounded open-only pending refresh.
- After that full pass, the final delta added browser-pending refresh before first journal persistence and a monotonic refresh deadline. The **six affected browser cases passed** (timeline/report/filter/pagination, identity loss, mobile message focus, individual/bulk pending actions, and bounded polling). The 97-case evidence is reused for the unchanged behavior, not represented as a new full run after that small delta. Web type/unit checks and release build/pack/smoke were rerun against the final source.
- The broad run exposed a real mobile focus-restoration race. Message navigation now hands focus from details-close to drawer-close callbacks rather than racing them with frame delays. Its regression passed **five consecutive runs**, the subsequent full suite, and the final focused run. The public-trigger privacy test now requires the supported public message link while still forbidding private trigger references, binding/session data, and the secret canary. Earlier command-timeout/browser-stall attempts are not counted as successful runs.
- Production-built Vite preview passed the timeline/report and read-only mobile-focus cases (**two tests**). Final fresh `MINU_ALLOW_DIRTY_RELEASE=1 pnpm release:build`, npm pack, and installed-tarball smoke passed, including temporary fresh/reopened/browser-first data and bundled diagnostic-worker startup/read/shutdown. The existing Vite large-chunk advisory remains.

Author work-review **Gate: PASS** for the bounded browser package; no known required implementation finding remains in this scope. This is not a delegated review or completed-feature security approval. Backend delegated approval remains limited to its earlier checkpoint.

Artifacts: `/tmp/diagnostics-ui-tests.log`, `/tmp/diagnostics-ui-web-tests-final.log`, `/tmp/diagnostics-ui-browser-verified.log`, `/tmp/diagnostics-ui-browser-polling-final.log`, `/tmp/diagnostics-ui-browser-production.log`, `/tmp/diagnostics-ui-mobile-focus.log`, `/tmp/diagnostics-ui-release-{build,pack,smoke}-final.log`, and `/tmp/channels-diagnostics-ui-package/minu-channels-0.0.12.tgz`. Do not reproduce temporary authentication/bootstrap material from test logs.

This implementation checkpoint was prepared on `feat/agent-diagnostics-phase2` from baseline `a2e9dd3`; the user has authorized committing it and continuing review. No existing dev/production service or agent was restarted, no real database was modified, and no real agent was started. The running dev backend may still predate protocol 19; this is source/package verification, not a deployment claim. At this pre-acceptance checkpoint, real-Pi acceptance and separately authorized publication/PR preparation were outstanding. The subsequent author completed-feature review and approved live acceptance are recorded below.

## Completed-feature author security/integration review

**Verdict: APPROVE for the reviewed source integration, with no actionable findings.** This is an author review, not an independent/delegated approval, production deployment, or real-Pi acceptance.

- **Target:** implementation commit `a96fa5b` on `feat/agent-diagnostics-phase2`; baseline `a2e9dd3` (merged Phase 1). Review comparison: `git diff a2e9dd3...a96fa5b`. The unrelated `docs/image-support.md` draft is excluded and remains untracked. No application source was changed during this review.
- **Intent and standards:** approved Phase 2 requirements in this document and the parent diagnostics specification, existing lifecycle/ownership contracts, browser query/session ownership, and repository CI/release commands. Phase 3 session/log inspection, raw export, automatic recovery, and existing-service changes remain out of scope.
- **Boundaries inspected:** diagnostic admission after authorization/lifecycle guards; synchronous failure-isolated observer wrappers; bounded/coalesced recorder/worker I/O and shutdown; independent owner-private journal schema, epoch reconciliation, retention and exact-scope relations; GET-only server authorization before/after reads and same-session delivery checks; sanitized report projection/UTF-8 budget; open-surface human/resource ownership, read aborts plus late-result fences, revocation cleanup, fresh-read Copy, escaped preview, and mobile close-focus handoff. Individual/bulk lifecycle diffs preserve admission locks, existing concurrency/snapshot guards, and Runtime capabilities.
- **Tests inspected:** API scope/role/session denial and canaries; recorder worker failures/capacity/deadlines/late replies; journal permissions, authoritative-file refusal, retention and independent-lock behavior; uncertain Stop, committed replacement/failed attachment, delayed/lost Cancel acknowledgment, cleanup and bulk results; browser-state disposal/selection/Copy failures and browser revocation/navigation/focus coverage. `.github/workflows/ci.yml` runs repository/web tests on Linux/macOS, Chromium on Linux, and packaged build/smoke on Linux; those remote CI jobs have not been run by this local review.
- **Fresh checks at the reviewed commit:** `pnpm check`; the focused Node suite (`agent-diagnostic-reads`, `agent-lifecycle-diagnostics`, `diagnostics-recorder`, and storage `diagnostics`) **47 passed**; `pnpm web:check`; focused web `operation-diagnostics.test.ts` **14 passed**; `git diff a2e9dd3...a96fa5b --check`. All passed.
- **Evidence reused:** the preceding **239 repository / 141 web unit / 97 full Chromium / six final-delta browser / two production-preview** results and fresh release build/pack/installed-tarball smoke. Commit `a96fa5b` preserves that verified application source; the pre-commit documentation edit only records user authorization to commit. The earlier 97-case run still precedes the documented final polling delta; its six affected cases were rerun, rather than claiming another complete browser run.
- **Confidence: Medium.** Local fake-runtime, temporary-journal, browser-fixture and packaging evidence covers the reviewed boundaries. It is not evidence of real Pi adapter behavior, another browser engine, Linux execution, or an independent review. Browser access-loss cleanup is observational; already disclosed/copied data cannot be revoked. The existing Vite chunk advisory and separately observed pre-existing directory-lock arbitration race remain follow-ups, not fixes claimed by this feature.

Review logs: `/tmp/diagnostics-feature-review-focused.log` and `/tmp/diagnostics-feature-review-web.log`. No existing service, agent, binding/history, real database, or unrelated draft was changed; nothing was pushed and no PR was created.

### Acceptance authorization — resolved

The user explicitly approved **new temporary Pi agents in an isolated disposable Workspace/data directory only**, leaving existing services, identities, bindings and history untouched. That approval enabled the acceptance package below; it did not authorize restarting an existing service, altering existing agents/data, publishing, or creating a PR. No verification-gap waiver was used.

## Approved real-Pi acceptance — passed

**Result: all nine bounded acceptance checks passed.** This closes the previously recorded real-Pi gate for the tested Phase 2 flows. The implementation is ready for separately authorized publication/PR preparation, not claimed deployed or release-approved.

- **Tested source:** `74bd372` (application implementation remains `a96fa5b`); Runtime `05b700a5e73e9031fe5dc5d67dc2d0f6922582fc`, matching `runtime-source.json`; installed Pi **0.99.1**; `openai-codex/gpt-6.1-sol` with the model-verified **minimal** reasoning level. Runtime and Channels were built before the run. No application or Runtime source changes were needed.
- **Real boundaries:** fresh disposable Conversation service, private Relay database and companion journal, daemon, production-built web server and Chromium, plus actual Runtime-owned Pi workers and real provider replies. All private data, working directories, Runtime registrations, Pi configuration and credentials were isolated under an owned temporary root. Unrelated secret environment variables, normal Pi extensions/skills/configuration and global session/registry paths were not supplied to the workers.

| Check | Observed result |
| --- | --- |
| Isolated setup | Private services/stores and diagnostic worker ready; temporary Runtime registry initially empty. |
| Start and inspection | Actual managed Pi session launched; journal confirmed binding commit and route attachment; timeline/selected report available through the real UI/APIs. |
| Real provider turn | Synthetic acknowledgment reached Pi and returned an agent response to the temporary Conversation. |
| Stop → Start | Intentional pause followed by explicit Start preserved the exact managed-session ID, binding ID and generation; a subsequent real reply succeeded. This was logical-session reuse, not a forced cold-worker restart. |
| Cancel active turn | Pi executed a short wait tool; real interruption acknowledgment and targeted turn settlement were recorded separately and in that sequence, followed by a succeeded Cancel outcome. |
| Stop active turn | Real work was interrupted; delivery fencing, interruption acknowledgment, settlement and pause commit were confirmed separately; the binding was held paused. |
| New session with context | New managed ID and incremented generation; handoff preparation and replacement attachment confirmed; retired-generation cleanup independently succeeded and the old managed registration was absent. |
| Fresh session | Another new managed ID/incremented generation; private history recorded Fresh context policy; handoff was explicitly skipped with `fresh_context`; related retired cleanup independently succeeded. |
| Final generation | Fresh generation 3 returned a real response; only its current managed session remained before final teardown. |

**Report/UI checks:** operation selection, local preview and Copy were exercised against the real production-built UI and authorized report APIs during the lifecycle package. Each preview/Copy pair required two fresh report GETs; the copied snapshot matched the selected operation, used format 1/protocol 19, stayed within 64 KiB UTF-8, and omitted the temporary root plus private binding/owner/managed-session identifiers. An isolated **in-memory clipboard sink** avoided altering the user clipboard; this is not a claim of native OS clipboard testing. Real requests were not delayed or mocked to manufacture pending states; deterministic long-pending, denial/late-result, clipboard rejection, and failure-injection behavior retains the preceding browser/unit evidence.

**Earlier attempts are not counted as passes:** the initially selected API-key provider rejected inference with HTTP 401 after worker Start/report checks. A subsequent Codex fixture requested unsupported reasoning `off`; startup was correctly rejected and diagnostics remained unknown rather than inventing success. An RPC capability probe confirmed this model supports `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; the corrected fixture selected `minimal`. Both earlier attempts cleaned up completely. The final Codex run used a private copy of an already-valid access token **without a usable refresh token**, so it could not rotate credentials used by existing sessions. No original credential/configuration file was written.

**Cleanup:** all three observed managed-worker PIDs exited; no temporary Runtime registrations or acceptance worker/Pi processes remained; the temporary root, databases, native transcripts/logs and copied credentials were removed. Existing product/dev listening endpoints and PIDs matched the pre-run baseline; the acceptance web listener was gone. The Runtime working tree remained clean, and unrelated `docs/image-support.md` was untouched. No existing service/agent was restarted or existing real database modified; nothing was pushed and no PR was created.

**Limits:** one local Chromium platform, Pi version, provider/model and supported launch profile. No cold-worker reopen, crash recovery, lost-ack transport fault, remote Linux CI, other browser engine or native OS clipboard was newly tested here. Prior fake-runtime/fault tests are still distinguished from this positive real-Pi acceptance; this is not an independent/delegated review or deployment evidence.

Durable sanitized evidence: [nine-check real-Pi acceptance result](verification/agent-diagnostics-phase2-real-pi.json). The one-off harness and sanitized console log are `/tmp/channels-pi-acceptance.mjs` and `/tmp/channels-pi-acceptance.log`; neither contains copied credential values. These temporary harness files are not part of the product or a new CI dependency.
