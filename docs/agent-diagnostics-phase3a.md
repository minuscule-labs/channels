# Agent diagnostics Phase 3a — session and context inspection

**Status:** Runtime [PR #9](https://github.com/minuscule-labs/runtime/pull/9) is merged as `6cd4fd25605a6b6260c50efa91bbc94e2f25dc9d`, with Ubuntu and macOS CI passing. Channels now pins that merged commit. Integrated packaging, inspection and production-preview verification passed; the Channels change is ready for PR review. The Channels implementation is `37217d5d230319caabf235872167f1f3c6f8b1f3` on `feat/agent-diagnostics-phase3a`. Optional live evidence remains **Not verified** for unavailable, unsafe or older workers. This work is not shipped or deployed; no Phase 3a real-Pi acceptance has been authorized or run.

**Channels baseline:** `3c3da28` (merged PR #40). Working branch: `feat/agent-diagnostics-phase3a`.

**Runtime audit baseline:** `05b700a5e73e9031fe5dc5d67dc2d0f6922582fc`. **Integrated pin:** `6cd4fd25605a6b6260c50efa91bbc94e2f25dc9d` in `runtime-source.json`.

**References:** [Parent diagnostics specification](agent-diagnostics.md), [Phase 2 design and verification](agent-diagnostics-phase2.md), [Runtime session history](runtime-session-history.md).

## Recommendation and scope decision

For the complete live-profile part of 3a, add a small **optional, owner-scoped, read-only Runtime session-profile API first**, then consume it in Channels. Keep Channels' recorded context, Runtime-observed profile, and settings saved for future launches as three separate sources. Absence of the Runtime method or evidence must produce **Not verified**, never a launch-time probe or an inferred value.

An independently useful smaller first slice is possible without Runtime changes: current recorded activation/context metadata, separately labeled future-launch settings, and explicit unavailable/not-verified live-profile and Stop/Start evidence. This is not a claim to provide verified running model/reasoning/skill values.

Options considered (the user selected Runtime API plus Channels):

- **Channels-only first:** smaller, one-repository change; current live-profile fields remain not verified with an explanation.
- **Runtime API plus Channels (recommended for verified live profiles):** two ordered changes/PRs; merge/review the optional Runtime contract first, then update Channels' pin and integrate the compatible consumer. Do not publish an unmerged local Runtime dependency or silently broaden the adapter interface.

No new authoritative lifecycle metadata writes are proposed in either option. A persisted last-Stop boundary or last-Start-kind feature would require its own narrowly reviewed schema/write-path change; it is not fabricated in this read-only slice.

## Objective

Give an authorized owner/admin an honest answer to:

1. What current activation/context policy is actually recorded for this participant?
2. Which running-session profile values can the existing adapter actually verify now?
3. Which settings are only saved for a future new session?
4. What evidence is unavailable, stale, legacy, or changed during the read?

Do not reconstruct a prior turn's supplied prompt/context from present settings or session metadata.

## Capability audit — confirmed baseline repository evidence

| Question | Existing evidence | Consequence for 3a |
| --- | --- | --- |
| Which activation is current? | `RelayBindingStore` binding plus `RuntimeSessionHistoryRecord`; unique binding/generation and active-activation constraints. | Match the exact current binding, generation, Workspace, Conversation, participant, adapter and managed identity/owner privately before projecting any activation fields. Reject ambiguous/mismatched rows. No private IDs in the response. |
| Initial activation origin? | `RuntimeSessionHistoryRecord.origin`; host initial Start and replacement both persist `origin: started`. | Render **Recorded activation origin**. It is not the latest lifecycle action. Do not call `started` a replacement, nor an existing row proof of a later resume. |
| Fresh versus with-context? | `contextMode` and optional `conversationSequenceAtActivation`; current Relay uses this activation policy. | Show recorded policy and its available public sequence boundary, not the exact prompt supplied to any turn. Explicitly qualify migrated/backfilled or missing evidence. A missing boundary is not sequence zero. |
| Did the latest Start resume this logical session? | Stop/Start keeps the same active activation; its origin is not rewritten. Phase 2 journal has separate best-effort operations, but public summaries do not prove current private generation matching. | No inference from unchanged activation time, current ID, or nearest operation. Use a separately exact-scope observation if implemented later; otherwise **Not verified**. Existing operation inspection remains available. |
| Latest confirmed Stop boundary? | `pauseBinding` updates the binding and advances the delivery cursor with `max`; no distinct last-Stop sequence/time is retained on the active activation. Cursor continues to advance after resume. `conversationSequenceAtRetirement` is not a Stop/resume record. | Do not present `getCursor`, activation sequence, retirement sequence, `updatedAt`, or a nearby trigger as the latest Stop boundary, even while currently paused. Return **Not recorded** until there is explicit persisted evidence. |
| Saved future settings? | `WorkspaceAgentConfig` has provider/model/reasoning/skill selection and context limits; it is mutable after launch. | Project the launch profile as **Saved settings for future new sessions**, with source update time. Present saved host context limits separately: recent-message/token limits are copied when Relay attaches, so Stop/Start can refresh them without changing Runtime model/reasoning/skills. They are not verified currently applied limits. Defaults remain unresolved, not guessed. Never return `personaPrompt`, `personaRef`, roots or arbitrary configuration extensions. |
| Running model/reasoning? | `AgentRuntime` has no session-profile getter. Pi worker selects a model and reasoning level via RPC at startup, but does not expose those values through the Runtime bridge. | A new optional Runtime read is needed to return verified values; otherwise not verified. Startup request/configuration alone is not current live evidence. |
| Can launch discovery substitute? | `PiAgentRuntime.capabilities()` creates a separate `PiRpcProcess`, calls `get_available_models`, `get_state` and skill discovery, then stops it. | **No.** This describes a new discovery process, not the selected session, and starts a process. It must not be called by session inspection or as an unavailable-read fallback. |
| Running skills? | `sessionCapabilities()` returns booleans, not a profile; Pi bridge reports `liveSkillVerification: false`. Discovery maps `get_commands` skill entries, with native paths kept internal. | A capability boolean is not skill evidence. If a future read can prove currently loaded skill commands, label precisely that; do not claim skills were used in a turn or that instructions were supplied. Unsupported evidence stays not verified. |
| Can Channels read a Runtime manifest? | Private Pi manifests retain requested launch config, paths, prompts and native correlation. Defaults can be omitted; it is not a live verification response. | **No.** Do not teach Channels private manifest/transcript parsing or copy the manifest into an API/report. |
| Is current history lookup bounded? | `listSessionHistory(conversationId, agentIdentityId?)` returns all matching activations ordered by time. | Add an exact indexed current-activation lookup bounded to detect ambiguity, rather than scanning the participant's full history on every read. |

### Sources inspected

- `packages/relay/src/binding-store.ts`: binding/history contracts, activation creation, pause/cursor behavior.
- `packages/relay-storage-drizzle/src/storage.ts`: `insertSessionActivation`, `replaceBindingSession`, `pauseBinding`, `getCursor`, `listSessionHistory`.
- `packages/control/src/agent-host.ts`: initial Start, intentional resume, replacement, saved launch selection and activation policy use.
- `packages/control/src/configuration.ts`: saved agent configuration projection; this existing settings response includes instruction text and must not be reused wholesale for inspection.
- `packages/control/src/agent-diagnostic-reads.ts`, `server.ts`: Phase 2 authorization, scoped reads and same-session delivery checks.
- `packages/web/src/lib/operation-diagnostics.ts` and `components/operation-diagnostics.tsx`: disposable scope ownership, authorization monitoring, read cancellation and late-result fencing.
- `../runtime/packages/core/src/index.ts`: generic launch and session capability contracts; no current session-profile API.
- `../runtime/packages/pi/src/{client,owned-worker,managed-sessions,server}.ts`: separate discovery process, startup RPC selection, requested launch manifest and live capability booleans.

## Read-only contract

The following contract is implemented. Channels consumes a structural optional port and now pins the separately merged Runtime implementation. No unmerged dependency is used.

### Runtime optional API

Add an optional method such as `inspectSessionProfile(managedSessionId, ownerId, { signal? })` with a separately versioned, strictly allowlisted response:

- Existing exact owner-scoped managed session only; no global discovery, path input, attach, start, resume, recovery or cleanup.
- Read the currently reachable worker. Missing or suspended workers and legacy/unmapped or unsupported sources return unavailable/not verified; they are not woken to answer. A Channels-paused binding may still have an existing idle worker: querying that worker read-only does not imply Start/resume or active turn admission.
- Model provider/ID and reasoning come from the selected live Pi process, not a new discovery process or requested launch config. Include capture/source-observation times where actually known.
- Skills are field-specific: distinguish explicit saved selection, loaded skill commands, and actual turn usage. Only loaded-command evidence belongs here if it can be verified; turn usage/prompt contents are out of scope.
- No full RPC state, model credential/config objects, system prompts, tool payloads, native IDs, PIDs, paths, registration tokens or raw errors.
- Implemented bounds: two-second Runtime read deadline, including registration I/O and response decoding; 16-KiB UTF-8 transport; at most 64 skill identifiers. Physical per-session slots and a 16-read per-client limit survive caller timeout until underlying work settles. The bridge and RPC reader also retain physical slots. Identifiers are bounded and unsafe values are omitted with explicit incomplete/not-verified coverage.
- Caller cancellation covers request and body decoding; response success is not permission to accept a result after the selected binding or authenticated scope changes.
- The read path itself must not refresh credentials, migrate manifests, prune stale registrations, or alter stored configuration. Audit existing helper side effects rather than assuming registry/manifest readers are pure.
- Keep existing session-capability version-one consumers compatible; an optional method with its own response version must fail closed against older live workers that lack the route.

### Channels

Implemented route: `GET /local/conversations/:conversationId/agents/:identityId/session-inspection`. Channels bounds private metadata/profile work to two seconds with 16 physical resource-read slots; the required authorization reads occur before/after that work. The exact current-resource lookup returns at most two bindings and two activation rows, using existing indexes and no schema migration.

Return three clearly separated projections:

1. **Recorded current activation/context:** exact current row's origin, recorded context policy, available public activation boundary and source timestamps; explicit legacy/missing/change/ambiguity states. Binding/routing metadata is not fresh Runtime liveness evidence.
2. **Observed running profile:** per-field verification/source/time, or not verified/unavailable with a curated explanation. For the Channels-only option, these fields remain not verified rather than being filled from saved settings.
3. **Saved configuration:** bounded future-launch adapter/model/reasoning/skill selection with source update time, plus separately labeled saved host context limits. Recent-message/token limits apply on Relay attachment/re-attachment, not exclusively new Runtime sessions; handoff-summary budgets apply when a new activation requests a summary. Neither is verified as the currently applied budget. Unselected defaults mean **adapter defaults, not resolved by this read**. Stop/Start resume does not promise to apply changed launch settings; a future new session is a separate operation.

Latest Start behavior and last Stop boundary are explicitly not verified/not recorded unless exact evidence actually exists. Do not overload activation origin or delivery progress to fill those fields.

Authorization and races:

- Same active-human, active Workspace owner/admin membership and Conversation participation predicate as Phase 2, including archived/read-only Conversations.
- Authenticate/authorize before I/O, reauthorize after I/O, and revalidate the same browser session immediately before delivery; `no-store` responses.
- Capture and privately revalidate the exact current binding/activation tuple around all metadata/Runtime reads. A replacement, removal, conflicting row, resume/stop transition or adapter/owner change during the read invalidates the affected snapshot. Never deliver generation N's profile labeled as generation N+1.
- Use a bounded exact current-activation read; no unbounded installation/history dump, journal reconstruction or new lifecycle lock.
- No status/discovery call across all agents. Reuse existing Phase 1 status projection; the new read is scoped to the selected authorized open surface.

## UI and report integration

Add a **Session & context** section to Details & diagnostics:

- Separate headings for recorded activation/context, per-field live evidence, saved future-new-session settings, and saved host context limits. Do not claim recent-context limits require a new Runtime session.
- Clear source/capture times and **Not verified**, **Not recorded**, **Unavailable**, **Legacy/unmapped**, or **Changed during read** labels as appropriate.
- Explain that initial activation origin is not the most recent Start action, that Fresh mode is a host context policy, and that this view does not reconstruct earlier prompts or per-turn skill usage.
- Link only to authorized public sequence boundaries already available in loaded Conversation history; otherwise explain that the message is not loaded.
- Provide read-only Refresh. No remediation, lifecycle mutation, worker wakeup or automatic recovery in response to a missing value.
- Reuse Phase 2's human/Workspace/Conversation/participant-keyed disposable in-memory ownership. Closing, navigation, observed access/identity/session loss and generation-changing selection abort/fence reads and clear privileged projections. Do not introduce persisted or cross-tab private caches.
- Preserve pending-action inspection, current timeline/report selection, keyboard/mobile focus and read-only/member distinctions.

The additive optional `session` report section reuses this safe projection only after fresh authorization and generation checks. Its capture time is independent of the selected operation; it is not that operation’s historical profile. `running.status: available` means a profile envelope was observed; verification remains per field. Saved defaults remain unresolved. The combined view is a separately timed observation, not an atomic cross-service snapshot. Keep format-one compatibility explicit, bump local-control protocol **19 → 20** through the shared constant when implementing, and preserve the existing 64-KiB UTF-8 report bound. If metadata cannot fit or cannot be verified, omit/mark that optional section explicitly; never silently add raw evidence or mislabel old metadata as a fresh observation. Copy still performs a new authorized report read, never copying a cached session view.

## Non-goals and operational constraints

- No logs, raw export/download, transcript reading, prompt/context reconstruction, historical activation selection, branching, recovery or additional Runtime control capabilities.
- No new lifecycle admission locks, ordering changes, retries, duplicate interrupts, authority transactions or diagnostic writes in lifecycle paths. No database migration is needed for the initial read-only projection; schema-based Stop/Start evidence would be a separate decision.
- Do not start real agents, restart existing services, or modify real databases for this audit/implementation. Any new real-Pi acceptance package needs explicit scoped approval; the previous Phase 2 acceptance did not authorize ongoing live-agent testing.
- Preserve unrelated `docs/image-support.md`; no worktree is required. The user subsequently requested commits and continuation. Commit the two repositories separately; publishing, merging, dependency integration and real-Pi acceptance remain distinct steps.

## Delivery sequence and verification

1. **Audit/design (done):** recorded supported evidence; the user selected the optional Runtime dependency. Check documentation facts/relative links; do not call a process-launching capability probe to inspect existing sessions.
2. **Runtime contract, if chosen:** implement/test in a normal Runtime feature branch. Prove exact owner isolation, active-session-only access, pure read behavior, field allowlists, bounded work, old-worker/unsupported behavior, no raw-state/credential leakage, caller cancellation and no worker start/resume/registry cleanup. Review/merge separately before pinning it in Channels.
3. **Channels service/contracts:** exact bounded activation lookup, independently authorized safe inspection/report projections and protocol/client changes. Fake runtimes and temporary stores test all race/availability paths.
4. **Open-surface UI:** reusable cancellable inspection state, separate recorded/live/future labels, safe report integration and public-boundary navigation.
5. **Integration gate:** focused API/store/state tests while building; browser boundary tests for role/session loss, navigation and replacement/Stop/resume races; repository/web/full browser and package gates once on the integrated feature. Reuse Phase 2 evidence only for unchanged code and explicitly distinguish author checks, independent review, CI and real-adapter acceptance.

### Author verification — local working branches

The current source passes Runtime type checking and **37 Runtime tests**, Channels build/type checking and **248 backend/storage tests**, web type checking and **145 web unit tests**, **102 Chromium browser tests**, and the production web build. The web build emits a non-fatal chunk-size warning. An additional isolated compatibility check exercised the actual updated Runtime client/bridge and Channels HTTP inspection/report APIs through a temporary real SQLite store and deterministic fake RPC, without Pi or an LLM. Registration and logical store records remained unchanged; lifecycle/discovery/message methods were guarded against use. See [structured author evidence](verification/agent-diagnostics-phase3a-author.json).

An initial six-second stalled-reader test timeout was investigated with isolated/full reruns; the test now asserts the two-second read and responsive status/admission directly, independently of its HTTP fixture-cleanup allowance. The first full browser run exposed a fixture assumption that sequence #9 could not be loaded after earlier tests; the unavailable-boundary fixture now uses an absent sequence and a separate test verifies real loaded-boundary navigation. Final complete runs are green; these earlier failures are not hidden.

The initial evidence above is **author verification** predating dependency integration, not independent review, real-Pi acceptance or release approval. A subsequent [commit checkpoint](verification/agent-diagnostics-phase3a-commit-checkpoint.json) passed clean-clone release build/pack/smoke against the **existing older Runtime pin**, plus five production-web-preview browser cases with test fixtures. That proves current-pin packaging compatibility, not live-profile integration. The subsequent merged-pin verification below supersedes that packaging limitation. Real-Pi acceptance and release approval remain separate. Fresh explicit approval is required before any new real-Pi run. No real agents were started, existing services restarted, or real databases modified. The unrelated `docs/image-support.md` remains untouched.

### Integrated merged Runtime pin

[Integrated author evidence](verification/agent-diagnostics-phase3a-integrated.json) targets Channels `35872c28fe2f581b395f8e111660225f08faa1c8` and merged Runtime `6cd4fd25605a6b6260c50efa91bbc94e2f25dc9d`. Clean temporary clones passed Runtime type checks and 37 tests, Channels type checks and 248 tests, web type checks and 145 tests, release build/pack/smoke, and five production-web-preview cases. No dirty-build override was used.

The actual **packaged Runtime client** also passed owner-scoped inspection/report compatibility through Channels HTTP authorization and temporary SQLite, with deterministic fake RPC. It verified current/future divergence, the zero Fresh boundary, privacy, fresh report reads, unchanged registration/logical store, and absence of lifecycle/discovery/message calls. This is not real-Pi acceptance. Prior 102-case browser regression evidence is reused only because application/test hashes are unchanged; full browser CI is still required on the PR.

An initial clean-clone web type check ran before workspace build completed and could not resolve generated declarations. Correcting the verification order resolved it without code changes. Temporary clones and test data were removed; `docs/image-support.md` remains byte-for-byte unchanged. Channels CI/review, merge and release approval remain pending.

Required negative cases include: settings edited after launch; unset inherited defaults; same activation resumed without origin rewrite; delivery cursor advanced after Stop; legacy/backfilled with-context rows; Fresh missing its boundary; no binding/multiple bindings/mismatched activation; paused/sleeping/offline worker; unsupported optional Runtime read; change of owner/generation/adapter during profile fetch; denial/expiry before final delivery; raw prompt/path/token canaries and hostile labels; clipping/size limits; stale and late results after close or resource change; fresh report Copy despite an older preview; unchanged lifecycle outcomes with inspection unavailable.
