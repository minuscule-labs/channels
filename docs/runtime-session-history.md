# Runtime session history and recovery

**Status:** Phase 1 implemented and verified. MinuRuntime's owner-scoped managed-session lifecycle is merged in PR #7; this work adds private Channels history and cleanup reconciliation. Historical resume/fork UI and MinuSessionStore integration remain out of scope.

## BLUF

MinuChannels should retain a private lifecycle record for every Runtime session activation instead of storing only the session currently bound to a Conversation agent. The current binding remains the authoritative routing pointer and stores a stable Runtime-managed session ID plus the installation's stable owner scope. New history does not store harness-native IDs. Unmappable legacy references remain explicitly `legacy_unmapped` and are never passed to owner-scoped managed-session operations.

Conversation messages remain the canonical shared transcript. Runtime session history is restricted execution metadata, not collaboration data, and MinuChannels must not copy harness transcripts or S3 objects into its database.

```text
Conversation + agent
        │
        ▼
current binding ──────────────► current Runtime session
        │
        └── activation history ├─ previous Pi session
                               ├─ previous Codex thread
                               └─ restored/forked session
                                          │
                                          └─ optional MinuSessionStore archive
```

## Motivation

`conversation_agent_bindings` stores the session reference required to route work. For Runtime-managed sessions, that value is a stable managed ID scoped by a persistent opaque Runtime owner ID; the harness-native ID stays private to the adapter and can change on resume. **New session** replaces the managed ID and increments the binding generation. A private activation history preserves the old reference and makes cleanup durable.

That is sufficient for current routing, but it has three limitations:

1. Replacing a binding overwrites the only durable reference to the previous managed session before cleanup is guaranteed to finish.
2. A crash or failed stop can leave an owned Runtime process without enough durable metadata for later cleanup.
3. MinuChannels cannot later offer session inspection, resume, fork, or archive-assisted restoration because it no longer knows which native sessions belonged to the Conversation agent.

A durable history closes these gaps without changing the public Conversation model.

## Goals

- Preserve each stable Runtime-managed session ID and owner scope activated for a Conversation agent.
- Preserve exact legacy binding references only as `legacy_unmapped`; never infer a managed identity from a legacy ID.
- Keep the current binding as the fast, authoritative routing pointer.
- Record binding generations so stale output remains fenced after replacement or recovery.
- Make failed or interrupted retirement discoverable and retryable.
- Support repeated activation of the same managed session without rewriting prior history.
- Preserve enough lineage to add explicit resume, fork, and restore actions later.
- Leave a future path to correlate sessions with MinuSessionStore without coupling Channels to S3 layout or credentials.
- Keep all Runtime identifiers and recovery metadata private to the agent host.

## Non-goals

- Storing a second copy of Conversation messages.
- Copying native harness transcripts into the Channels database.
- Replacing MinuSessionStore as the owner of snapshots, checksums, object versions, retention, or S3 restoration.
- Making an old harness session override the canonical Conversation transcript.
- Automatically reactivating a retired history entry. Opt-in startup resume of the existing current managed binding is a separate lifecycle operation.
- Exposing native session ids, archive locations, local paths, or provider errors through public Conversation APIs, SSE, or audit values.
- Requiring caller-selected native session ids such as `minu-channels-<uuid>`.

## Terms

- **Runtime-managed session ID:** A stable opaque Runtime-generated ID that remains stable across suspend/resume and is used as the Channels routing reference.
- **Runtime owner ID:** A stable opaque scope for the owning MinuChannels installation; it is required for managed-session enumeration, suspend, resume, and destroy.
- **Native session id:** A private identifier assigned or accepted by a harness, such as a Pi worker session id or Codex thread id. It may change on resume and is not the durable identity.
- **Runtime session:** A harness-owned execution context addressed by Runtime adapter, owner ID, and Runtime-managed session ID. Native IDs remain adapter-private.
- **Legacy unmapped reference:** An exact pre-managed binding value retained privately when Channels cannot prove a managed-ID/owner mapping. It is not a managed ID.
- **Binding:** The current `(workspaceId, conversationId, agentIdentityId)` routing record.
- **Activation:** One binding generation during which a Runtime session was selected for that Conversation agent.
- **Retirement:** Ending an activation and reconciling the requested owner-scoped worker cleanup. Runtime metadata destruction does not delete the persisted native harness transcript.
- **Resume:** Reopen the same persisted logical session under the same managed ID and owner scope; the native worker ID may change.
- **Fork:** Create a new managed session from an older session while preserving lineage.
- **Restore:** Recover native session material from an archive so an adapter can subsequently resume or fork it.

## Core invariants

1. A Conversation agent has at most one current binding.
2. A binding generation identifies exactly one activation.
3. Only the current binding generation may emit output into the Conversation.
4. Retiring or restoring a session never rewinds, edits, or replaces the Conversation transcript.
5. A managed identity is scoped by Runtime adapter and the non-null Runtime owner ID for the owning Channels installation; a harness/source installation ID is a separate future correlation value.
6. The same retired managed session may be activated again, but each activation receives a new binding generation and history row.
7. A managed session must not be active in two Conversation-agent routes at once unless a future adapter explicitly proves that sharing is safe. No current adapter does.
8. Cleanup failure is durable state, not a log-only event.
9. Historical resume and fork are explicit owner/admin actions and fail closed when support cannot be verified.

## Phase 1 data model

### Existing current binding

`conversation_agent_bindings` remains the current routing record and continues to contain:

- Workspace, Conversation, and agent identity ids;
- Runtime adapter and session reference (stable managed ID plus owner scope for new Runtime-managed sessions; older unmapped references remain private and legacy);
- generation, state, wake policy, lease, and verification fields.

The binding is intentionally not the historical record. Relay should not scan history to discover where to send current work.

### Activation-history table

Migration `0011_runtime_session_history` adds the private `conversation_agent_session_history` table and persists one stable owner ID in `local_runtime_owners`:

| Field | Purpose |
| --- | --- |
| `id` | Stable Channels-owned history record id. |
| `workspace_id` | Restricted ownership and query scope. |
| `conversation_id` | Conversation route. |
| `agent_identity_id` | Agent route. |
| `workspace_agent_config_id` | Configuration owner at activation time. |
| `binding_id` | Binding whose generation created this activation. |
| `binding_generation` | Fencing generation for this activation. |
| `runtime_adapter` | Runtime adapter that owns or resolves the session reference. |
| `managed_session_id` | Stable Runtime-managed ID; non-null only for `mapping = managed`. |
| `runtime_owner_id` | Stable MinuChannels installation owner scope; required for managed IDs. |
| `legacy_runtime_session_ref` | Exact private pre-managed binding reference for `legacy_unmapped`; never treated as a managed ID. |
| `mapping` | `managed` or `legacy_unmapped`; selects which operations are safe. |
| `origin` | `started`, `resumed`, `forked`, `restored`, `attached`, or `migrated`. |
| `conversation_sequence_at_activation` | Conversation head when the activation became current. |
| `conversation_sequence_at_retirement` | Optional retirement boundary; Phase 1 leaves it unset, and historical recovery must not rely on it yet. |
| `activated_at` | Activation timestamp. |
| `retired_at` | Timestamp at which the activation stopped being current. |
| `retirement_reason` | `replaced`, `stopped`, `disabled`, `conversation_retired`, `recovered`, or another bounded value. |
| `cleanup_action` | `none`, `suspend`, or explicit `destroy` of Runtime resume metadata. |
| `cleanup_status` | Worker/Runtime cleanup state: `not_required`, `pending`, `succeeded`, `failed`, or `unknown`. |
| `retention_status` | `retained`, `destroy_pending`, or `destroyed`; retained history protects resume material. |
| `cleanup_attempt_count` | Retry counter; startup reconciliation retries failures at most five times. |
| `last_cleanup_attempt_at` | Last cleanup attempt timestamp. |
| `last_observed_runtime_status` | `idle`, `working`, `offline`, or `unknown`. |
| `last_verified_at` | Last bounded status verification time. |
| `last_cleanup_error_category` | Bounded internal category; raw provider errors are never stored. |
| `created_at`, `updated_at` | Storage timestamps. |

Errors must be reduced to bounded internal categories. Raw provider errors, credentials, paths, prompts, and transcript content do not belong in this table.

Recommended constraints and indexes:

- unique `(binding_id, binding_generation)`;
- one active activation per `(workspace_id, conversation_id, agent_identity_id)`;
- one active managed activation per `(runtime_adapter, runtime_owner_id, managed_session_id)`;
- route-history index on `(conversation_id, agent_identity_id, activated_at)`; and
- cleanup index on `(cleanup_status, updated_at)`.

Managed history rows require non-null managed ID and owner scope. The local Relay database creates and preserves the opaque owner ID. Partial uniqueness applies only to active managed IDs so a retired session can later receive a new activation row. Legacy rows have neither owner nor managed ID and are excluded from managed operations.

Phase 1 deliberately does not persist native IDs, source installation IDs, or lineage links; these are future archive/resume concerns, not routing identity.

### Optional later normalization

The first implementation may keep one row per activation. If multiple archive providers, cross-device imports, or richer session metadata become necessary, split native identity from activation history:

```text
runtime_sessions
  one row per adapter + Runtime owner ID + managed session ID

conversation_agent_session_activations
  one row per binding generation using a runtime_sessions row
```

Do not introduce that split before it solves a concrete integration need. The lifecycle semantics above should remain the same.

## Lifecycle behavior

### Start first session

1. Resolve and validate the Workspace agent configuration.
2. Start the Runtime with `startManaged(config, ownerId)` and receive its stable managed-session ID. The owner ID is generated and persisted by the local Relay store; the native harness ID remains private to Runtime.
3. Snapshot the Conversation head and advance the Relay cursor to that boundary.
4. In one private-store transaction, create the current binding at generation 1 and insert its matching active history row.
5. Lease, verify, and attach the binding.
6. If persistence fails after Runtime startup, best-effort destroy the unbound managed Runtime; when a binding/history row exists, persist cleanup outcome for retry.

### Replace with New session

1. Require the existing binding to be idle and verify the expected binding generation.
2. Start the replacement Runtime.
3. In one private-store transaction:
   - mark the old activation retired with cleanup `pending` and retention `destroy_pending` because **New session** explicitly discards its Runtime resume metadata;
   - compare-and-swap the binding to the new managed-session ID and increment its generation; and
   - insert the new active history row.
4. Attach and verify the new generation.
5. Destroy the old Runtime-managed registration through its exact owner scope. Runtime destruction preserves the harness transcript.
6. Mark old-session cleanup `succeeded` and retention `destroyed`, or leave it durably retryable on failure, without changing the new current binding.

A crash after step 3 leaves a durable `destroy_pending` record with the old managed ID and owner scope. Startup reconciliation can safely finish destruction without changing the new current binding.

### Stop or retire an agent

1. Fence new work by incrementing/disabling the current binding according to the existing lifecycle contract.
2. Retire the active history row transactionally and mark cleanup `pending` plus retention `destroy_pending` for explicit Stop.
3. Attempt owner-scoped Runtime `destroy`; this removes Runtime resume metadata but preserves the persisted harness transcript.
4. Persist the cleanup and retention result. A failed destroy remains `destroy_pending` for bounded retry.

### Startup reconciliation

On agent-host startup, queue a bounded cleanup batch in the background so current-binding restoration and the local control server are not held behind retirement work:

- restore only the current bindings through the existing lease and generation rules;
- scan a bounded batch of `pending` or retryable `failed` cleanup records;
- verify owner scope with adapter timeouts;
- suspend retained sessions and destroy only rows already marked `destroy_pending`;
- retry owner-scoped destroy when an explicit destroy intent lists an unavailable session, including Runtime metadata left mid-destroy by a crash;
- treat a confirmed absent or suspended session as worker-cleanup complete, marking retention destroyed only after explicit destroy intent is reconciled;
- retry bounded cleanup failures without changing the current binding; and
- retain history even when Runtime metadata or resume material is unavailable.

Reconciliation must never reactivate a historical session automatically.

## Resume, fork, and restore

History enables historical recovery actions but does not by itself implement them. Phase 1 uses MinuRuntime's owner-scoped managed-session contract for starts, current-session resume, retirement, and cleanup; historical-session fork/restore actions remain future work.

### Runtime contract direction

A future harness-neutral contract should distinguish:

- reconnecting to an already running process;
- resuming a persisted logical session under the same managed ID and owner scope;
- forking a persisted session into a new managed ID; and
- importing or opening restored native session material.

Illustrative API only:

```ts
interface RuntimeSessionRef {
  runtime: string;
  managedSessionId: string;
  runtimeOwnerId: string;
}

interface AgentRuntime {
  resume?(source: RuntimeSessionRef, config?: AgentStartConfig): Promise<AgentSession>;
  fork?(source: RuntimeSessionRef, config?: AgentStartConfig): Promise<AgentSession>;
}
```

MinuRuntime now defines owner-scoped `startManaged`, `listManagedSessions`, `resume`, `suspend`, and `destroy`. Resume returns the same managed ID even when the native worker ID changes. Historical-session fork remains future work. An absent method or failed owner-scope check means unavailable, not permission to fall back to an unscoped managed operation.

### Conservative recovery policy

- Prefer **fork** when the Conversation has advanced since the old activation retired.
- Permit direct **resume** only after explicit confirmation and an adapter verification that the native session is available.
- Before activation, require current Conversation-agent work to be idle or stopped.
- Create a new binding generation even when direct resume reuses the same managed ID. Retirement-sequence capture remains a Phase 1 limitation.
- Set `source_history_id` on the new activation.
- Advance the Relay cursor to the current Conversation head so historical messages are not replayed as new work.
- Provide a bounded handoff/current-context brief when the old harness context may be stale.
- Fence all output from prior generations.

The Conversation transcript wins if harness context and Conversation state disagree.

## MinuSessionStore integration

MinuSessionStore currently catalogs native sessions by owner, source installation, harness, and external session id, and stores immutable raw snapshots separately. A future Channels integration may correlate with that catalog using:

- Runtime adapter/harness;
- a verified native session reference made available through a narrow Runtime capability; and
- source installation id when available. This is separate from the Runtime owner scope.

Phase 1 does not store native IDs or source-installation IDs and does not query MinuSessionStore.

Channels should integrate through an authenticated local capability or narrow service interface, not by reading Session Store tables or constructing S3 keys directly.

A future archive-assisted flow is:

1. An owner/admin selects a retired activation.
2. Channels checks whether the native session is still locally available.
3. If absent, Channels asks MinuSessionStore to locate the matching archived session.
4. The user selects an archive version when more than one valid snapshot exists.
5. MinuSessionStore restores exact native bytes to a controlled destination or returns an opaque restore result.
6. The Runtime adapter validates and resumes or forks the restored session.
7. Channels creates a new fenced activation and records lineage to the historical row.

Integration rules:

- MinuSessionStore owns S3 credentials, checksums, object versions, and restoration safety.
- Channels stores no S3 URI, object key, auth token, raw transcript, or restored absolute path in public data.
- A Session Store catalog id may be retained as an opaque private archive reference if a stable API guarantees it.
- Missing archives, unsupported harness formats, and checksum failures fail closed.
- Pi support may arrive before Codex archival support; capability checks must remain adapter-specific.

## Authorization and presentation

Session history is internal execution state under the existing product boundary.

- Public Conversations APIs and SSE never include history rows or native ids.
- Owner/admin local APIs may expose a sanitized list: harness label, activation time, lifecycle state, archive availability, and allowed actions.
- Raw native ids should remain hidden unless a dedicated local diagnostic explicitly requires them.
- Resume, fork, restore, and destructive deletion require explicit confirmation.
- Audit events include action, actor, target Conversation/agent, and bounded outcome only—not native ids, archive locators, paths, or provider errors.

## Retention and deletion

Lifecycle metadata is small and should initially be retained for the lifetime of its Workspace or Conversation. Retained history is never orphan-cleaned or deleted by Phase 1; only explicit `destroy_pending` intent removes Runtime resume metadata. Runtime transcript retention remains a harness and MinuSessionStore concern.

Future deletion policy must distinguish:

- removing a Channels history reference;
- deleting local harness session material;
- deleting Session Store catalog records; and
- deleting exact S3 object versions.

No Channels action should cascade into archive deletion without a separate, explicit, provider-owned confirmation flow.

## Delivery order and prerequisite

1. **Runtime managed-session proof — complete:** stable managed IDs, exact owner scope, same-ID resume, suspend, and metadata-only destruction are implemented in MinuRuntime PR #7.
2. **History Phase 1 — implemented and verified:** private transactional activation/retirement records, managed-ID and owner persistence, explicit `legacy_unmapped` migration, and durable cleanup reconciliation. Restore UI and MinuSessionStore integration remain out of scope.
3. **Opt-in idle sleep/wake — deferred:** begin only after Phase 1 history persistence and cleanup behavior are verified; Workspaces remain opted out initially.

Do not use legacy native references as managed IDs or pass them to owner-scoped Runtime operations. Cleanup that destroys Runtime metadata must be represented as durable `destroy_pending` intent, distinct from history retention or transcript deletion.

## Rollout plan

### Phase 1 — Durable lifecycle history

- Add private activation-history persistence and migrations.
- Transactionally dual-write binding creation, replacement, and retirement with history.
- Persist a stable local Runtime owner scope and use stable managed IDs for Pi production sessions; adapters without the managed contract remain explicitly `legacy_unmapped`.
- Mark old unmappable references `legacy_unmapped`, preserving their exact private value without inferring owner scope.
- Reconcile pending suspend/destroy work in a bounded startup batch, without changing current bindings.
- Keep all existing UI and public contracts unchanged.

### Phase 2 — Historical resume and fork

- Build on the owner-scoped MinuRuntime lifecycle contract proven in PR #7 and used by Phase 1.
- Add owner/admin actions for retired history with generation fencing and confirmation.
- Implement historical Pi recovery first if its native session contract remains stable.
- Implement Codex support independently when a Codex Runtime adapter exists.

### Phase 3 — MinuSessionStore bridge

- Define a narrow locate/restore capability.
- Add source-installation correlation without exposing storage internals.
- Prove checksum-verified restore followed by adapter validation and fork/resume.

### Phase 4 — Recovery UI

- Show sanitized session history on the local agent/Conversation administration surface.
- Clearly distinguish current, local historical, archived, unavailable, and cleanup-failed sessions.
- Default stale-session recovery to fork rather than resume.

## Migration and compatibility

Migration `0011_runtime_session_history` creates one `migrated` history row per existing binding. It marks every pre-managed reference `legacy_unmapped`, copies that exact value only to the private `legacy_runtime_session_ref`, and leaves managed ID and owner scope null. Unknown activation sequence, ownership, and verification data remains null; no mapping is invented. Legacy rows are excluded from managed-session listing, resume, suspend, and destroy.

For new Runtime-managed sessions, `runtime_session_id` in the current binding is the stable managed ID and `runtime_owner_id` records the local installation scope. History writes occur in the same SQLite transaction as binding creation, replacement, disablement, or deletion. The database keeps history after current binding deletion; only the current binding routes Relay work.

Older binaries must not run against a schema they cannot safely maintain. Normal product migration backup and compatibility rules continue to apply.

## Verification requirements

At minimum, automated tests must prove:

- first start creates exactly one current binding and matching generation-1 history row;
- concurrent replacement attempts allow only one generation transition;
- replacement retains the previous managed ID and owner scope before attempting owner-scoped destroy;
- stop/destroy failure remains durably retryable after process restart;
- successful reconciliation never changes the current binding;
- resuming the existing managed binding preserves its managed ID and owner scope; historical reactivation creates a distinct generation/history row;
- stale generations cannot deliver messages after resume, fork, or restore;
- unsupported adapter operations fail without mutating the binding;
- migration preserves unmappable legacy references as `legacy_unmapped` without inferring managed IDs or owner scope;
- private history and native/runtime identifiers are absent from public APIs, SSE, and audit values;
- sanitized APIs and audit events contain no native ids, source ids, paths, transcript data, archive keys, or raw errors; and
- archive restore failure cannot create a partially active binding.

A genuine integration proof should cover:

1. run a Pi session from a Conversation;
2. replace and retire it;
3. archive it with MinuSessionStore;
4. remove or make local session material unavailable;
5. locate and restore a verified snapshot;
6. fork or resume it through Runtime; and
7. produce a response only from the new binding generation.

## Open decisions

Resolve these only when the corresponding phase is promoted:

1. Which optional source-installation identifier should be used for MinuSessionStore correlation? It remains distinct from the already-required Runtime owner ID.
2. Should direct resume be allowed after any Conversation divergence, or should divergence always require fork?
3. Does restored native material keep its original native id or receive a new import id per adapter?
4. What operator action should be available after the bounded five-attempt cleanup retry budget is exhausted?
5. Should launch-profile snapshots be retained for display/reproducibility, or should recovered sessions always use current Workspace-agent configuration?
6. When should the one-table activation model be normalized into separate Runtime-session identity and activation tables?
7. What explicit user flow governs deletion of local session material or archived S3 versions?
