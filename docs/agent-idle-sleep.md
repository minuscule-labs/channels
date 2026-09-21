# Idle agent sleep and wake

**Status:** Proposed fast follow; documentation only

## Decision

MinuChannels should automatically sleep eligible, Runtime-owned agent sessions after a configurable idle period and wake the same logical session when new work addresses that agent.

Sleep is a process-lifecycle optimization, not a model-cost control. An idle Pi worker currently makes no model calls and uses effectively no CPU, but it still holds processes, listeners, file descriptors, registrations, and memory. The feature should preserve the agent's transcript, Conversation cursor, binding generation, and identity while removing those live resources.

This is intentionally deferred under the [product boundary](product-boundary.md) MVP guardrail. It should be implemented only after the Runtime can durably suspend and resume an owned session without turning sleep into **New session**.

## User model

Use these terms consistently:

- **Idle** — the Runtime process is alive and ready, but no turn is active.
- **Sleeping** — no Runtime worker is alive; MinuChannels can resume the same logical session.
- **Waking** — a transient state while that session is being resumed.
- **Offline** — the session was expected to be available but is unexpectedly unreachable or cannot be resumed.
- **Stopped** — the binding is disabled by an explicit user action. It does not wake automatically.

Sleeping must not be presented as Offline or Stopped. An addressed message may wake a sleeping agent, but it must never restart a stopped agent.

## Goals

1. Remove idle owned worker processes without losing the Runtime transcript or Conversation delivery position.
2. Wake only when a message is eligible under the binding's existing wake policy.
3. Preserve at-most-one active worker and at-most-one agent turn per binding across sleep, wake, crashes, and service restarts.
4. Keep Runtime identifiers, transcript paths, resume metadata, and credentials out of public Conversations data and browser responses.
5. Detect and safely clean up MinuChannels-owned orphan workers.
6. Make sleep and wake observable through sanitized state, audits, and diagnostics.

## Non-goals

- Reducing token use while an agent is already idle; idle workers do not call a model.
- Suspending an active turn, tool call, retry, or queued turn.
- Sleeping attached or externally owned Runtime sessions.
- Starting stopped or unbound agents on first mention.
- Replacing a failed session with a fresh transcript without explicit policy or user intent.
- OS-level process suspension such as `SIGSTOP`; sleep means a graceful Runtime shutdown with durable resume metadata.
- Changing Conversation snooze/archive semantics described in [conversation lifecycle](conversation-lifecycle.md).

## Policy

### Initial rollout

Ship the mechanism behind an opt-in Workspace policy first. After resume and recovery have proven reliable in normal use, make **30 minutes** the default for newly created Workspaces. Existing Workspaces remain opted out until an owner/admin selects a timeout.

Supported policy values:

- Off
- 15 minutes
- 30 minutes
- 1 hour
- 4 hours
- 24 hours

A Workspace provides the default. A Workspace agent may inherit it, choose another value, or choose **Never sleep**. Policy is restricted Workspace configuration, not public Conversation metadata.

### Eligibility

An agent may sleep only when all of the following are true:

- its binding is connected and leased by the current agent host;
- the adapter advertises durable suspend/resume support;
- the session is Runtime-owned by this MinuChannels installation;
- Runtime status is positively verified as idle;
- Relay reports no active turn, retry, cancellation, or queued eligible message;
- no start, replace, stop, reconnect, wake, Conversation lifecycle transition, or service quiesce is in progress;
- the configured idle deadline has elapsed.

Uncertain status must fail closed: keep the session awake and retry verification later. Never sleep merely because status timed out.

The idle clock starts when a session is first attached or when its most recent turn settles. Unaddressed Conversation activity does not reset it. Failed wake attempts do not advance the Conversation cursor.

## Required Runtime contract

The current Pi adapter can stop an owned worker, but it cannot relaunch that worker against the same session through the Runtime API. MinuRuntime must provide a durable owned-session lifecycle before Channels enables automatic sleep.

The exact API may evolve, but the contract must support:

```ts
type ManagedSessionState =
  | "active_idle"
  | "active_working"
  | "suspended"
  | "missing"
  | "uncertain";

interface SuspendableManagedRuntime {
  managedSessionState(sessionId: string): Promise<ManagedSessionState>;
  suspend(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<{ id: string }>;
  destroy(sessionId: string): Promise<void>;
}
```

Required semantics:

- `suspend` refuses a working session, gracefully stops its worker, and retains an owner-private resume descriptor.
- `resume` is idempotent and restores the same logical transcript and session id. It must not create an empty session.
- Concurrent `resume` calls produce at most one worker.
- `destroy` stops either an active or suspended session and removes its resume descriptor.
- A suspended session is distinguishable from a missing/crashed session.
- Resume restores the original working directory, prompt behavior, selected skills, model, and reasoning configuration. It must not duplicate append-only prompt content.
- Resume descriptors and registrations remain owner-only and never contain provider credentials.
- The adapter records an opaque installation owner reference so Channels can enumerate and clean up only sessions it owns.

For Pi, the likely implementation is to persist a restricted launch manifest and resume the recorded session file with Pi's explicit session option. The Runtime adapter—not Channels—owns the transcript path and process arguments. Channels stores only the existing opaque Runtime session id.

## Binding and storage model

Extend the private binding state machine:

```text
connected ──idle timeout──▶ sleeping ──eligible message──▶ waking ──success──▶ connected
    │                           │                              │
    ├──unexpected loss────────▶ offline ◀────missing/failure──┘
    │                           │
    └──explicit Stop──────────▶ disabled ◀────explicit Stop───┘
```

Add durable binding states `sleeping` and `waking`. Keep `connected`, `offline`, `replacing`, and `disabled` with their current meanings.

Add private timestamps sufficient for policy and diagnostics:

- `last_active_at` — last successful attach or settled turn used to calculate the idle deadline;
- `slept_at` — most recent completed sleep transition;
- `wake_requested_at` — most recent wake attempt, cleared or superseded after reconciliation.

All state transitions use binding id, generation, and lease-owner compare-and-swap. Sleep/wake does not increment the generation because it preserves the same logical Runtime session and transcript. **New session** continues to increment the generation and replace the Runtime session.

The Conversation cursor remains unchanged while sleeping or waking. Messages remain authoritative in Conversations; a wake failure must not consume, skip, or dead-letter the triggering message merely because process startup failed.

## Relay behavior

A sleeping binding must remain routable without a live Runtime worker. The preferred design is to retain one lightweight Conversation Relay subscription and attach a lazy binding that can request wake before delivery. Do not create one polling loop per sleeping agent.

On an incoming message:

1. Apply the existing wake policy (`mentions`, `direct_mentions`, `all_messages`, or `muted`).
2. Ignore ineligible messages without waking the agent.
3. Queue an eligible message durably by leaving it beyond the existing cursor.
4. Serialize wake through the binding lifecycle lock.
5. Resume and verify the Runtime session.
6. Compare-and-swap `waking` to `connected` and attach the live binding.
7. Drain from the durable Conversation cursor using the existing Relay path.

`muted` bindings never auto-wake. Multiple eligible messages received during wake produce one Runtime worker and are drained in sequence after attachment.

The Relay needs an atomic idle handoff so a timeout cannot race new work:

1. Close admission for that binding while retaining incoming messages beyond the cursor.
2. Confirm there is no active, retrying, canceling, or queued turn.
3. Positively verify Runtime idle.
4. Persist `sleeping` with generation/lease fencing.
5. Ask Runtime to suspend.
6. Reopen lazy admission for wake detection.

If persistence succeeds but suspension fails, reconciliation either completes suspension or returns the binding to `connected` after proving the worker is healthy. It must never launch a second worker to resolve uncertainty.

## Recovery and reconciliation

Agent-host startup reconciles durable binding state with Runtime managed-session state:

| Binding state | Runtime state | Action |
| --- | --- | --- |
| `sleeping` | `suspended` | Attach lazy wake routing; do not start a worker. |
| `sleeping` | active and idle | Complete suspension. |
| `sleeping` | active and working | Fence delivery, report uncertainty, and do not terminate active work automatically. |
| `waking` | active and idle/working | Complete attachment and mark `connected`. |
| `waking` | `suspended` | Retry the idempotent resume. |
| `connected` | `suspended` | Resume and reattach the same session; do not create a new one. |
| any enabled state | `missing` | Mark `offline`; preserve the cursor and require recovery or explicit **New session**. |
| `disabled` | active or suspended | Destroy it best-effort; never attach or wake it. |

Recovery retains the existing lease and generation fencing rules. A host that loses its lease cannot sleep, wake, attach, or deliver output for that binding.

Service quiesce waits for any already accepted sleep/wake transition, then leaves durable state for the next process to reconcile. It does not force active work to sleep.

## Conversation lifecycle interaction

Snooze and Archive continue to require idle or stopped agents and continue to fence managed-agent admission. Once an owned idle binding is retired for a successful Snooze or Archive transition, MinuChannels may immediately sleep it regardless of the normal timeout.

Reopening a Conversation does not eagerly wake its agents. It restores eligibility for lazy wake; the next addressed message wakes the preserved session. This is consistent with the current rule that reopen does not start or replace Runtime sessions.

## Explicit lifecycle actions

- **Stop** on a sleeping agent changes the binding to `disabled` and calls Runtime `destroy`; it never resumes merely to stop.
- **New session** on a sleeping agent starts a fresh session, generation-fences the old binding, commits replacement, and destroys the old suspended descriptor best-effort.
- **Reconnect** is not offered for sleeping agents because sleeping is healthy and intentional.
- A future explicit **Wake now** action may be added for diagnostics, but it is not required for the first rollout.
- Workspace/agent launch-configuration changes continue to apply only to a new session. Wake resumes the old session with its original launch manifest.

## Presentation and controls

Add `sleeping` and transient `waking` to the presentation-safe local agent states. The browser may show:

- **Sleeping · wakes on mention** (or the applicable wake-policy label);
- **Waking…** while resume is in progress;
- last active/slept time when available.

Do not expose Runtime session ids, transcript paths, process ids, resume descriptors, leases, or raw adapter errors.

Workspace Agent settings should expose the inherited/effective idle timeout. Conversation controls retain Start, New session, and Stop with the semantics above.

## Orphan cleanup

Automatic sleep does not by itself solve workers left behind by old application versions or failed lifecycle transitions. Add owner-scoped reconciliation:

1. Assign each MinuChannels installation a stable opaque owner id in restricted local state.
2. Pass that owner id when creating Runtime-owned sessions.
3. On startup, list active and suspended sessions for only that owner.
4. Compare them with non-disabled private bindings after acquiring the product lock.
5. Destroy unreferenced sessions after a bounded grace period and record a sanitized audit outcome.

Never kill a process based only on its working directory, executable name, or absence from one Conversation. Never clean up attached sessions or sessions owned by another installation/data directory.

## Security and privacy

- Resume manifests use owner-only permissions and atomic writes.
- Runtime validates every persisted path before use and refuses redirected or malformed manifests.
- Browser contracts expose only sanitized lifecycle state and timestamps.
- Logs and audits omit Runtime ids, paths, prompts, tokens, and model credentials.
- Wake follows existing Conversation participant checks, binding generation, lease ownership, and wake policy; it is not an authorization bypass.
- A resumed worker receives no new instructions except the Conversation turn delivered through the normal Relay path.

## Observability

Emit sanitized lifecycle events:

- `agent.session.slept`
- `agent.session.wake-requested`
- `agent.session.woken`
- `agent.session.sleep-failed`
- `agent.session.wake-failed`
- `agent.session.orphan-cleaned`

Useful local metrics are counts of awake/sleeping workers, wake latency, transition failures, and orphan cleanup outcomes. Diagnostics may include bounded reason codes such as `busy`, `lease_changed`, `resume_missing`, `runtime_timeout`, or `policy_disabled`, but not raw Runtime errors.

## Delivery sequence

### Phase 1 — Runtime primitives

- Add suspend/resume/destroy and managed-session-state capabilities to MinuRuntime.
- Persist private owner-scoped resume manifests.
- Prove that Pi resumes the same transcript and session id after a full worker exit.
- Add idempotency and crash-recovery tests.

### Phase 2 — Agent-host state machine

- Add private storage migration for sleep states and timestamps.
- Add generation/lease-fenced sleep and wake transitions.
- Keep sleeping bindings lazily routable through Relay.
- Reconcile interrupted transitions on startup.
- Keep the policy disabled by default.

### Phase 3 — Policy and UI

- Add Workspace default and per-agent override.
- Add presentation-safe `sleeping`/`waking` states.
- Add sanitized audits, diagnostics, and user documentation.
- Enable the default only for newly created Workspaces after reliability review.

### Phase 4 — Owner-scoped orphan cleanup

- Add installation ownership metadata and Runtime enumeration.
- Clean only unreferenced sessions owned by the current installation.
- Report aggregate cleanup outcomes without exposing Runtime internals.

## Acceptance criteria

1. After the timeout, an eligible idle Pi agent has no worker or bridge listener, while its binding, cursor, and transcript remain intact.
2. The next eligible message resumes the same session and receives a normal response through Conversations.
3. An unaddressed message and a message excluded by wake policy do not wake it.
4. Two simultaneous eligible messages start at most one worker and are processed without duplicate responses.
5. Sleep never interrupts active, queued, retrying, canceling, replacing, or uncertain work.
6. Killing MinuChannels during either transition is repaired on restart without creating two workers or losing the triggering message.
7. Stop and New session retain their existing destructive/replacement semantics for sleeping bindings.
8. Snoozed or archived Conversations do not wake agents; reopening alone does not wake them.
9. Browser/API payloads and logs contain no Runtime resume metadata.
10. Orphan cleanup cannot affect attached sessions, another installation, or a worker inferred only from its current directory.
11. End-to-end tests verify cursor preservation, generation fencing, lease loss, wake failure, service restart, and exact transcript continuation.

## Open validation questions

These questions must be answered with a Runtime proof before implementation is enabled:

- Does Pi preserve the exact session id when resumed from its session file in RPC mode?
- Which launch inputs must be replayed so resumed skills, extensions, model selection, and system-prompt behavior are identical without duplicating prompt text?
- Can Runtime make suspend atomic enough to distinguish a completed suspension from a worker that exited before its resume manifest was committed?
- What wake-latency budget is acceptable on supported machines and models?
- Should a future hosted agent host use the same timeout policy, or delegate worker scale-to-zero to its execution platform?
