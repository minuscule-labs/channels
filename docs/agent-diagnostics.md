# Agent diagnostics and operation review

**Status:** Product direction and Phase 1 Close / View diagnostics interaction approved. Phase 1 and the multi-tab transport fix are implemented and automated checks pass; real Pi lifecycle acceptance remains pending. Phases 2–3 remain proposed and gated as below.

**Branch:** `fix/diagnostics-during-pending-actions`

**Scope:** Reachable inspection, lifecycle evidence, failure review, diagnostic reports, and progressively deeper session/log inspection.

## Purpose

Help an authorized user answer:

1. What is this agent doing, and how current is that information?
2. Which request or lifecycle operation is involved?
3. What is the last confirmed step, and what remains unknown?
4. Did work fail, or did delivery/recovery fail?
5. What can I safely do next, and what evidence can I share?

Inspection must remain available during pending operations without bypassing lifecycle safety guards. Diagnostics report observations; they do not infer successful interruption, session health, or safe recovery from a spinner, elapsed time, or absence of events.

## Existing behavior and evidence

These are confirmed implementation facts, not new features:

- `packages/control/src/contracts.ts` defines presentation-safe agent state, activity phase, triggering message, elapsed-start timestamp, exact/inexact queue counts, connection, verification time, and live capability states.
- Durable turn-failure projections include failure category, failure time, duration, attempt count, delivery outcome, and remediation. Minimal notices are visible to active Conversation participants; detailed failure records are restricted to active Workspace owners/admins.
- `participant-details-dialog.tsx` renders participant information, Runtime/activity information, triggering messages when loaded, connection/capability diagnostics, and failures.
- `participant-session-actions-menu.tsx` disables the whole trigger while pending or externally disabled. Its confirmation dialog cannot currently close while an operation is pending.
- `member-roster.tsx` also disables other participant triggers during individual operations and targeted participants during bulk operations.
- `docs/web-client-mvp.md` requires sanitized owner/admin diagnostics and details access in read-only Conversations.
- Existing lifecycle audit callbacks are not a durable, complete per-step operation timeline. Runtime activity events expose phases, not tool arguments or a general log/transcript feed.

Existing access, data, and refresh contracts are the starting point. Proposed additions below require explicit implementation; no new diagnostic API or event history is available merely because it is described here.

## Product boundaries

### In scope

- Read-only inspection during Start, Stop, Reconnect, Cancel current, New session with context, Fresh session, and bulk operations.
- Explicit pending-action timing and freshness/uncertainty labels.
- Structured lifecycle milestones and failure/turn correlation.
- Copyable, sanitized diagnostic snapshots.
- Safe current-session context-policy and launch-profile inspection.
- Bounded, scoped, sanitized log review, where supported.
- Explicit sensitive evidence export behind a separate security/capability gate.

### Not included

- Changes to Stop/Start/replacement safety semantics, automatic recovery, or new cancel-operation behavior.
- Session branching, selecting/resuming historical sessions, or image support.
- Automatically executing remediation, replaying failed work, or retrying mutations when opening diagnostics.
- Unrestricted file browsing, terminal execution, global installation log browsing, or automatic publication of private transcripts.
- A guarantee of diagnosing model reasoning, exposing hidden reasoning, or identifying root cause without supporting evidence.

## Experience and information architecture

Retain **Details & diagnostics** as the entry point in expanded desktop, minimized avatar rail, and mobile participants drawer. Do not add permanent lifecycle-action buttons to participant rows.

The details surface has progressively disclosed sections:

1. **Overview** — current state, activity, pending action, freshness, and safe capabilities.
2. **Operation history** — selected operation and its confirmed milestones.
3. **Turn issues** — existing failure records with triggering-message/event links where available.
4. **Session & context** — safe session policy and verified launch information.
5. **Recent logs** — capability-backed, bounded, sanitized evidence.

Keep the initial overview compact. Unsupported later sections show a clear availability explanation, not an empty panel that implies nothing happened. Mobile uses the same information and permission model, with scrollable content and responsive section navigation.

### Pending confirmation behavior — proposed decision

Separate confirmation presentation from the in-flight mutation:

- Before submission, **Cancel** means cancel this confirmation; no operation has been requested.
- Once submitted, the confirmation can be dismissed. Replace the dismiss label with **Close** and explain: “Closing this dialog does not cancel the operation.”
- Provide **View diagnostics** while pending; it closes the confirmation presentation and opens the relevant participant details.
- Preserve the pending action and elapsed indicator on the participant after dismissal; do not hide, abort, or restart the request.
- Opening the participant menu remains possible. Conflicting lifecycle controls stay disabled, with a brief pending-operation explanation; **Details & diagnostics** stays enabled.
- Late success/failure belongs to the original operation and Conversation. It must not close a newly opened confirmation/details dialog, clear another error, or affect a different Conversation after navigation.
- Restore focus to the initiating control when possible, with a stable fallback. Avoid stacking competing confirmation/details modals or leaving the mobile drawer focus trap broken.

Closing inspection never cancels a request. No “cancel pending Stop/Start” action is introduced.

## Overview contract

| Field | Meaning / rule |
| --- | --- |
| Agent state | Existing safe state; preserve stopped, disabled, offline, disconnected, and uncertain distinctions. |
| Connection | Existing verified projection; an unavailable observation is not proof the worker is offline. |
| Activity | Existing running/using-tools/responding/retrying/canceling phase. Do not fabricate tool names or arguments from a phase event. |
| Trigger | Public Conversation message/sequence when authorized and available. Link to the message; explain when outside loaded history. |
| Elapsed turn time | Since the observed turn start, not proof of continuous progress. |
| Queue | Exact count, lower-bound/partial indication, or unavailable. Never render unverified absence as “0 queued.” |
| Pending action | Action label, request time, elapsed duration, and origin: this browser versus host-observed operation. |
| Freshness | Snapshot capture time, source observation/verification time where available, and refresh error. Do not conflate last binding verification with fresh turn progress. |
| Capabilities | Available / unavailable / not verified; absence of a capability is not support. |

Local pending timing survives closing/reopening the dialog but does not claim to be a durable server operation record. Before host acknowledgment, label it **Requested from this browser; host acceptance not yet confirmed**. Browser timeout/disconnection leaves outcome **unknown** until authoritative state is reconciled.

Manual **Refresh** is read-only. Phase 1 reuses existing Runtime-status polling rather than adding a second status poller. Its client snapshot records the actual successful response receipt time separately from optimistic cache updates. Snapshots older than 15 seconds (three normal idle poll intervals) receive a may-be-stale warning; failed reads warn immediately and preserve the previous snapshot. Later operation/log requests run only for the authorized open surface; cancellation of those reads does not cancel lifecycle work. Failed refresh retains the last snapshot with a visible stale/error indication.

## Structured operations and events

### Ownership

- Channels agent-host owns lifecycle operations and emits its own milestones.
- Relay owns turn-admission/drain/delivery observations.
- Runtime adapters own harness-specific status, acknowledgment, and optional diagnostic evidence.
- The private Relay store retains operation/event records. The public Conversation message store does not receive these records.
- The local-control server authenticates, authorizes, scopes, and projects safe records for the browser.

Do not move Pi transcript parsing or harness log discovery into the web client or generic Channels lifecycle code.

### Proposed record shape

Names and route shapes below are design targets, not existing contracts:

```ts
OperationSummary {
  operationId; // opaque diagnostic correlation ID, not a Runtime session ID
  conversationId;
  participantIdentityId;
  action; // start, resume, stop, reconnect, cancel_current, replace, replace_fresh
  requestedAt;
  acceptedAt?;
  finishedAt?;
  outcome; // pending, succeeded, failed, unknown
  lastConfirmedStage?;
  observedAt;
}

OperationEvent {
  eventId;
  operationId;
  sequence; // authoritative per-operation ordering
  observedAt;
  source; // agent_host, relay, runtime
  stage;
  result; // started, confirmed, failed, unknown, skipped
  reasonCode?; // allowlisted, presentation-safe
  triggerSequence?; // public Conversation sequence, when applicable
}
```

The browser renders curated labels from enums/reason codes, not arbitrary error strings. Runtime IDs, owner tokens, PIDs, native transcript paths, and credentials are excluded from these normal projections. Internal generation/session scoping must prevent events from one session being attributed to its replacement.

### Milestones

| Operation | Applicable confirmed milestones |
| --- | --- |
| Stop | Accepted → delivery fenced → interrupt requested/acknowledged when needed → active turn settled → boundary recorded and pause committed → route detached → completed. |
| Start/resume | Accepted → exact session verified → resume requested when suspended → Runtime availability verified → route attached → completed. |
| New session | Accepted → old route fenced/detached → handoff prepared or skipped → activation boundary captured → Runtime launch requested/verified → replacement committed → route attached → completed. |
| Fresh session | Same replacement path, with explicit handoff skipped and Fresh context boundary recorded. |
| Reconnect | Accepted → existing session verified → route reattached → completed. |
| Cancel current | Accepted → interruption requested/acknowledged → current-turn settlement verified → completed. |

Emit only steps actually executed. An idle/suspended Stop can skip interruption with a reason. Retired-session cleanup is separately identified background work; pending cleanup must not imply the new session failed to attach.

Bulk requests have a parent operation with per-participant child operations and outcomes; inspection does not wait for the whole batch to settle.

### Truthfulness and durability

- “Confirmed” means the corresponding authoritative operation/acknowledgment completed, not merely that the request was sent.
- Diagnostic events are not the source of lifecycle authority. Existing durable fences, state transitions, leases, and compare-and-swap rules remain authoritative.
- Recording is bounded and must not introduce a new blocking dependency into interruption or recovery. On recording failure, expose a diagnostic gap when possible rather than claiming complete history.
- A crash can leave a pending operation. On startup, reconcile only what authoritative state can prove; otherwise mark **unknown**, not succeeded or definitely failed. Do not execute recovery merely to complete a diagnostic timeline.
- Imported/current audit entries without correlation are labeled legacy/uncorrelated; never join unrelated operations solely by timestamp proximity.
- Use event sequence for order and monotonic elapsed durations while running. Wall-clock timestamps alone are insufficient if clocks change.

**Proposed bounded defaults:** retain terminal operation records for seven days; cap terminal operations at 1,000 per installation and events at 128 per operation; paginate history at 50 records per response. Protect active-operation summaries, preserve final outcomes, and expose truncation/expiry explicitly. Final storage/indexing details must be reviewed before Phase 2 implementation.

## Turn-failure review

Preserve existing categories, delivery outcomes, remediation, and permissions. Add stable safe correlation between a failure, its public trigger sequence, and related events; current minimal notices and detailed projections should not be matched by ambiguous timestamp heuristics.

A selected issue should answer:

- Which message triggered it?
- How long did the attempt run and how many attempts were recorded?
- Was the failure in Runtime execution/request handling, delivery, or cursor recovery?
- What outcome was subsequently confirmed, if any?
- Which actions are supported by current verified capabilities?

If execution success is not recorded, do not assert “the agent answered but delivery failed.” Preserve uncertainty and show the actual recorded category/outcome. Navigation to a message does not post, resend, retry, or acknowledge it.

## Session and context inspection

Expose a dedicated safe projection, not raw private history rows:

- Current activation's origin: created, resumed, attached, or unknown.
- Current context mode: with-context or Fresh, with its public activation sequence boundary.
- Latest Stop boundary where known, explaining that later addressed messages wait for explicit Start.
- Whether the latest observed Start resumed the same logical session or replacement created a different one, only when verified.
- Verified running-session launch profile versus settings saved for a future session. Never label current Workspace configuration as the live model/instructions without evidence.
- Adapter/provider/model/reasoning/skill metadata only where supported, authorized, and safe; show not verified otherwise.

Do not include full system prompts, tool payloads, or transcript content by default. A future per-turn “context supplied” inspector requires its own reviewed capture/redaction contract; reconstructing current context is not proof of what an earlier turn received.

## Recent logs and sensitive exports

### Sanitized recent logs

- Source selectors are server-defined and capability-backed; no arbitrary file paths, commands, or URLs.
- Enforce Workspace, Conversation, participant, owner, and exact-session scope before reading. Do not expose global/shared process logs merely because a user owns one Conversation.
- Present timestamps, severity when actually supplied, and source. Unstructured lines are labeled unstructured rather than assigned invented severities.
- Bound reads to a proposed default 256 KiB / maximum 1 MiB per request and 200 lines per page; expose clipping, pagination, unavailable timestamps, and partial sources.
- Escape all log content as text. Never interpret log text as HTML, shell commands, links to local files, or application instructions.
- Apply allowlisted structured fields and targeted redaction before returning/caching evidence. Automated redaction is risk reduction, not a guarantee arbitrary free-text logs are secret-free.
- Search/filter within bounded scoped evidence. No whole-filesystem or unbounded historical search, and no persistent background log stream while the panel is closed.
- Log reads cannot start/resume/wake a session, attach an interactive terminal, or change its transcript.

### Explicit raw log/transcript export — gated Phase 3 option

Raw evidence can contain confidential prompts, tool results, local paths, credentials, and content unrelated to the visible message. It is not part of the normal diagnostics response, sanitized report, or clipboard action.

A supported export requires:

1. Verified exact owned-session/source selection by an adapter, never a user-supplied filesystem path.
2. Fresh authorization and a clear source/content/privacy warning with explicit confirmation.
3. Safe file access: traversal/symlink rejection, permissions/ownership checks, bounded size, escaped filename, and an immutable/read-only source operation.
4. Short-lived local output with restrictive permissions; no bearer secrets in URLs, analytics, logs, or durable shared records.
5. Explicit expiry/cleanup and audited export metadata without recording exported content.
6. A reviewed delivery mechanism. Prefer an explicit local export initially; browser downloads are not approved by this specification alone and require a separate threat-model review.

Unsupported adapters display **Raw export unavailable**, not a nonfunctional button. Do not add a generic diagnostic file-reader endpoint. Export must not require mutating/resuming the source session.

## Diagnostic report

**Copy diagnostic report** creates a sanitized text or JSON snapshot containing:

- Report format version, app/control-protocol versions, and capture time.
- Authorized display labels, safe state/activity/queue/capability/freshness information.
- Pending action and last confirmed milestone, with uncertainty explicitly represented.
- Selected operation's bounded event timeline and relevant failure summaries.
- Optional safe session/context summary when available.
- Coverage notes: unavailable sources, recording gaps, truncation, expired history, and refresh errors.

Exclude message bodies, prompts, raw logs/transcripts, credentials, owner tokens, native IDs, absolute paths, and instructions by default. Snapshot selection is previewable; copying/exporting does not publish anything to the Conversation or a third party. Avoid caching sensitive reports in browser storage and clear privileged cached data on membership/session loss.

## Actions and authorization

- All users retain their existing participant-information access. Detailed diagnostics remain restricted to active Workspace owners/admins with the required Conversation access, including read-only Conversations.
- Enforce permissions server-side on every diagnostic read/export, not just by hiding UI controls. Scope each request independently; deny stale or revoked access.
- Initially support Refresh, navigate to triggering message, event filters, and Copy report. Phase 3 adds supported evidence selection/export.
- Recovery shortcuts, if added later, reuse existing authenticated lifecycle endpoints, capability checks, confirmations, pending guards, and read-only restrictions.
- Opening diagnostics never enables conflicting mutations or starts a retry. A client timeout does not itself authorize a replacement or another interrupt.
- No additional authority is created by an operation ID or copied report. Diagnostic IDs are correlation identifiers, not access tokens.

## Delivery phases and acceptance criteria

### Phase 1 — access, timing, and freshness

Small independently shippable UI package; no new lifecycle semantics or operation-history schema.

- Details open/close during every individual action and bulk operation, for both targeted and other participants.
- Busy confirmations support Close/View diagnostics without aborting the mutation or losing progress/errors.
- Conflicting session actions remain disabled; single activation/confirmation yields at most one mutation.
- Local pending timing and existing snapshot freshness are clearly labeled; incomplete queues and failed reads are not presented as healthy/exact.
- Existing status polling is reused; no extra background poller.
- Expanded/minimized/mobile layouts, keyboard navigation, focus restoration, read-only access, and role restrictions work.
- Delayed completion/failure after dismissal or Conversation navigation affects only its original operation/context.

### Phase 2 — lifecycle evidence and reports

Private storage migration, safe control projections, host/Relay event instrumentation, and UI/report integration.

- Independent operations, replacement generations, and bulk children have unambiguous scoped correlation.
- Confirmed versus requested/skipped/failed/unknown events are accurately labeled.
- Delayed interrupts, failed Stop, failed replacement, startup interruption, and cleanup retries do not create misleading success or new recovery behavior.
- Retention, pagination, truncation, and recording failures are bounded and visible.
- Failures link to the correct public trigger and operation only where evidence exists.
- Copy report is bounded, redacted, versioned, previewable, and permission-checked.
- Upgrade tests preserve existing identities, bindings, history, and lifecycle behavior; protocol changes use the shared version contract.

### Phase 3 — session/log inspection and gated export

Adapter contracts and source availability must be verified rather than assumed.

- Session/context summary distinguishes verified live configuration from future configuration and missing evidence.
- Log reads are bounded, scoped, read-only, permission-checked, and text-escaped; unsupported sources are explicit.
- Cross-Workspace/session leakage, path traversal, symlink redirection, hostile content, oversized inputs, and secret-containing fixtures are covered.
- Raw export remains disabled until its capability and delivery-security review are complete; sanitized reports never silently include it.

Each phase gets its own verification checkpoint and scoped commit/PR. Phase 1 is the next implementation target; approving the full direction does not require implementing all three phases in one change.

## Verification plan

- Browser: controllable delayed endpoints for every individual/bulk action; inspect self/others; busy-dialog dismissal; completion/failure; double-click/reopen; keyboard; minimized/mobile; archived/read-only; member versus owner; navigation during pending work.
- Control/Relay/storage: authorization and scope isolation; event ordering/correlation; terminal outcomes and unknown recovery; best-effort recording failure; normal schema upgrade and history preservation; retention/truncation; existing race regressions remain green.
- Runtime/adapter: optional evidence capability; read-only ownership/path/permission checks; supported/unsupported log and session sources; no transcript writes or worker wakeup from inspection.
- Reports/logs: escaped hostile content, bounded payloads, clipboard errors, missing metadata, redaction fixtures, permission revocation, and absence of privileged content from normal member responses.
- Live dev smoke: hold a slow Start/Stop/replacement and inspect diagnostics without disrupting it. Production services/data remain untouched unless separately authorized.

## Review gates / unresolved details

- Busy-confirmation **Close / View diagnostics** interaction approved; preserve pending guards and verify focus/late-response behavior in Phase 1.
- Review event retention limits and the storage/error-isolation design before Phase 2.
- Decide which adapters can actually supply safe current-session launch metadata and scoped logs before Phase 3; current phase-only activity events are insufficient for detailed tool review.
- Review a concrete raw-export threat model and delivery mechanism before enabling that capability.

## Phase 1 verification checkpoint

Observed on the current branch after implementation:

- `pnpm check` and `pnpm web:check` passed.
- `pnpm test`: 192 repository tests passed.
- `pnpm web:test`: 127 web tests passed, including browser-request attribution, snapshot-age helpers, curated status-error labels, shared-stream ownership/routing/cleanup, suspended-tab expiry, polling fallback, and reconnect catch-up fences.
- Full Chromium Playwright suite: 78 tests passed. The two shared-event regression tests also passed against the production-built web assets using the isolated fixture and Vite preview. Coverage includes all individual action types, stopped-session Start, individual/bulk inspection of self and others, synchronous duplicate activations, busy Close/View diagnostics, late failures, navigation, local elapsed timing, failed refresh preservation, inexact queues, keyboard focus, minimized/mobile layouts, read-only access, and owner/member visibility.
- `pnpm web:build` passed; Vite reports its large-chunk advisory.
- `git diff --check` passed.

The status-error follow-up distinguishes missing/expired local browser sessions, denied access, HTTP failures, and client timeouts without rendering raw transport errors. A failed refresh with retained data is labeled **Runtime status refresh failed**, rather than implying the last known agent state was lost.

No application backend API, migration, durable operation timeline, raw-log/export capability, or Runtime change is included. Fixture-only stream metrics support browser assertions. Real Pi Start/Stop/replacement smoke has not been performed: existing live agents were deliberately left untouched. A guarded live-dev UI check intercepted both Stop and New session with context before network delivery, held them pending, verified View diagnostics and read-only refresh, then returned simulated failures. Both real status snapshots remained Idle; zero lifecycle mutations reached the host.

### Multi-tab transport fix

The original three-tab dev reproduction exhausted six browser HTTP/1 connections with foreground/background event streams. Status requests timed out at about 3,001 ms before transmission, although direct control answered HTTP 200 in 7 ms. Raising the timeout would not release those connections.

Foreground and background logical subscriptions now use one SharedWorker-managed multiplexed SSE connection per browser origin and current-human identity. Tabs retain independent Query caches. Topic changes cancel and finish the old transport before opening the next; readiness reconciles each subscriber's snapshots and preserves pre-stream catch-up cursors even when live events overtake delayed history. No lifecycle controls, private Runtime details, browser credentials, or raw logs are sent through the worker protocol, and existing server authorization remains unchanged.

Port deliveries and client queues are capped at 128 events each. Slow/suspended subscribers reconcile snapshots instead of retaining unbounded history. Page unload/BFCache navigation releases ports; 30-second heartbeats and a 180-second expiry bound crashed/frozen subscriptions, with resumed expired subscribers reconnecting. Handshake/startup waits are bounded to ten seconds and reconnect delays to ten seconds. Unsupported/blocked workers use nominal five-second snapshot polling, never a per-tab persistent connection; the UI explicitly labels this fallback and its lack of notification sounds. Browsers may throttle background polling.

The six-tab Chromium regression verifies one physical stream, responsive status requests through normal poll deadlines, per-Conversation message routing, recovery after 150 messages while a tab is frozen, and continued delivery after the creating tab closes. Worker-unavailable fallback is tested as well. A repeat against the actual dev stack showed no banners or aborted status requests across three tabs; observed status responses on the third tab took 7–19 ms. Safari/Firefox-specific manual checks remain unperformed.

No production service/data changes or deployment were performed. The unrelated image-support draft remains untouched.

## Related sources

- [Web client contract](web-client-mvp.md)
- [Runtime session history and recovery](runtime-session-history.md)
- [Idle sleep and explicit lifecycle behavior](agent-idle-sleep.md)
- [Product boundary](product-boundary.md)
