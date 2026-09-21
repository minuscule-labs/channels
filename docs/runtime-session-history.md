# Runtime session history and recovery

**Status:** Proposed future work; not part of the current MVP implementation scope.

## BLUF

MinuChannels should retain a private lifecycle record for every Runtime session activation instead of storing only the session currently bound to a Conversation agent. The current binding remains the authoritative routing pointer. Session history preserves retired native session ids for cleanup, diagnostics, later resume or fork operations, and optional recovery through MinuSessionStore.

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

`conversation_agent_bindings` currently stores the native `runtimeSessionId` required to route work. **New session** replaces that value and increments the binding generation. The old Runtime is then stopped on a best-effort basis.

That is sufficient for current routing, but it has three limitations:

1. Replacing a binding overwrites the only durable reference to the previous native session before cleanup is guaranteed to finish.
2. A crash or failed stop can leave an owned Runtime process without enough durable metadata for later cleanup.
3. MinuChannels cannot later offer session inspection, resume, fork, or archive-assisted restoration because it no longer knows which native sessions belonged to the Conversation agent.

A durable history closes these gaps without changing the public Conversation model.

## Goals

- Preserve each native Runtime session id that has been activated for a Conversation agent.
- Keep the current binding as the fast, authoritative routing pointer.
- Record binding generations so stale output remains fenced after replacement or recovery.
- Make failed or interrupted retirement discoverable and retryable.
- Support repeated activation of the same native session without rewriting history.
- Preserve enough lineage to add explicit resume, fork, and restore actions later.
- Correlate a native session with MinuSessionStore without coupling Channels to S3 layout or credentials.
- Keep all Runtime identifiers and recovery metadata private to the agent host.

## Non-goals

- Storing a second copy of Conversation messages.
- Copying native harness transcripts into the Channels database.
- Replacing MinuSessionStore as the owner of snapshots, checksums, object versions, retention, or S3 restoration.
- Making an old harness session override the canonical Conversation transcript.
- Automatically resuming an old session because the current session is offline.
- Exposing native session ids, archive locations, local paths, or provider errors through public Conversation APIs, SSE, or audit values.
- Requiring caller-selected native session ids such as `minu-channels-<uuid>`.

## Terms

- **Native session id:** The identifier assigned or accepted by a harness, such as a Pi session id or Codex thread id.
- **Runtime session:** A harness-owned execution context identified by Runtime adapter plus native session id.
- **Binding:** The current `(workspaceId, conversationId, agentIdentityId)` routing record.
- **Activation:** One binding generation during which a Runtime session was selected for that Conversation agent.
- **Retirement:** Ending an activation and, for an owned live process, attempting to stop that process. Retirement does not delete the persisted native harness transcript.
- **Resume:** Reopen the same persisted native session when the adapter and harness support it.
- **Fork:** Create a new native session from an older session while preserving lineage.
- **Restore:** Recover native session material from an archive so an adapter can subsequently resume or fork it.

## Core invariants

1. A Conversation agent has at most one current binding.
2. A binding generation identifies exactly one activation.
3. Only the current binding generation may emit output into the Conversation.
4. Retiring or restoring a session never rewinds, edits, or replaces the Conversation transcript.
5. The native key is scoped by Runtime adapter and, when available, a stable harness/source installation id.
6. The same retired native session may be activated again, but each activation receives a new binding generation and history row.
7. A native session must not be active in two Conversation-agent routes at once unless a future adapter explicitly proves that sharing is safe. No current adapter does.
8. Cleanup failure is durable state, not a log-only event.
9. Direct resume and fork are explicit owner/admin actions and fail closed when support cannot be verified.

## Proposed data model

### Existing current binding

`conversation_agent_bindings` remains the current routing record and continues to contain:

- Workspace, Conversation, and agent identity ids;
- Runtime adapter and native Runtime session id;
- generation, state, wake policy, lease, and verification fields.

The binding is intentionally not the historical record. Relay should not scan history to discover where to send current work.

### New activation-history table

A future migration should add a private table named along the lines of `conversation_agent_session_history`:

| Field | Purpose |
| --- | --- |
| `id` | Stable Channels-owned history record id. |
| `workspace_id` | Restricted ownership and query scope. |
| `conversation_id` | Conversation route. |
| `agent_identity_id` | Agent route. |
| `workspace_agent_config_id` | Configuration owner at activation time. |
| `binding_id` | Binding whose generation created this activation. |
| `binding_generation` | Fencing generation for this activation. |
| `runtime_adapter` | Adapter that understands the native id. |
| `runtime_session_id` | Opaque native Pi session/Codex thread id. |
| `runtime_installation_id` | Optional stable harness installation scope when Runtime can supply one. |
| `origin` | `started`, `resumed`, `forked`, `restored`, `attached`, or `migrated`. |
| `source_history_id` | Optional lineage link for resume, fork, or restore. |
| `conversation_sequence_at_activation` | Conversation head when the activation became current. |
| `conversation_sequence_at_retirement` | Conversation head when it stopped being current, if known. |
| `activated_at` | Activation timestamp. |
| `retired_at` | Timestamp at which the activation stopped being current. |
| `retirement_reason` | `replaced`, `stopped`, `disabled`, `conversation_retired`, `recovered`, or another bounded value. |
| `cleanup_status` | `not_required`, `pending`, `succeeded`, `failed`, or `unknown`. |
| `cleanup_attempt_count` | Bounded retry/diagnostic counter. |
| `last_cleanup_attempt_at` | Last cleanup attempt timestamp. |
| `last_observed_runtime_status` | `idle`, `working`, `offline`, or `unknown`. |
| `last_verified_at` | Last bounded status verification time. |
| `created_at`, `updated_at` | Storage timestamps. |

Errors must be reduced to bounded internal categories. Raw provider errors, credentials, paths, prompts, and transcript content do not belong in this table.

Recommended constraints and indexes:

- unique `(binding_id, binding_generation)`;
- one unretired activation per `(workspace_id, conversation_id, agent_identity_id)`;
- one unretired activation per scoped `(runtime_adapter, runtime_installation_id, runtime_session_id)`;
- route-history index on `(conversation_id, agent_identity_id, activated_at)`;
- cleanup index on `(cleanup_status, updated_at)`; and
- lineage index on `source_history_id`.

SQLite nullable uniqueness needs deliberate handling. Until Runtime exposes a stable installation id, the local agent-host installation should supply a non-null local scope key rather than relying on `NULL` inside a uniqueness constraint.

### Optional later normalization

The first implementation may keep one row per activation. If multiple archive providers, cross-device imports, or richer session metadata become necessary, split native identity from activation history:

```text
runtime_sessions
  one row per adapter + installation + native session id

conversation_agent_session_activations
  one row per binding generation using a runtime_sessions row
```

Do not introduce that split before it solves a concrete integration need. The lifecycle semantics above should remain the same.

## Lifecycle behavior

### Start first session

1. Resolve and validate the Workspace agent configuration.
2. Start the Runtime and receive its native session id.
3. In one private-store transaction:
   - create the current binding at generation 1; and
   - insert the matching active history row.
4. Advance the Relay cursor to the intended Conversation boundary.
5. Lease, verify, and attach the binding.
6. If persistence fails after Runtime startup, best-effort stop the unbound owned Runtime and emit a bounded internal diagnostic.

### Replace with New session

1. Require the existing binding to be idle and verify the expected binding generation.
2. Start the replacement Runtime.
3. In one private-store transaction:
   - mark the old activation retired with cleanup `pending`;
   - compare-and-swap the binding to the new native id and increment its generation; and
   - insert the new active history row.
4. Attach and verify the new generation.
5. Stop the old owned Runtime.
6. Mark old-session cleanup `succeeded` or `failed` without changing the new current binding.

A crash after step 3 leaves a durable pending-cleanup record. Startup reconciliation can safely finish the retirement instead of losing the old native session id.

### Stop or retire an agent

1. Fence new work by incrementing/disabling the current binding according to the existing lifecycle contract.
2. Retire the active history row and mark cleanup pending when Channels owns a reachable process.
3. Attempt bounded Runtime stop.
4. Persist the cleanup result.

Stopping a process must not be represented as deleting the persisted harness session. A stopped Pi worker, for example, may still have a resumable session file or a Session Store archive.

### Startup reconciliation

On agent-host startup:

- restore only the current bindings through the existing lease and generation rules;
- scan a bounded batch of `pending` or retryable `failed` cleanup records;
- verify status with adapter timeouts;
- stop only sessions known to be owned and safe to stop;
- treat confirmed offline sessions as cleanup-complete for process retirement; and
- retain history even when the native process or local session material is unavailable.

Reconciliation must never reactivate a historical session automatically.

## Resume, fork, and restore

History enables these actions but does not by itself implement them. MinuRuntime will need explicit adapter contracts.

### Runtime contract direction

A future harness-neutral contract should distinguish:

- reconnecting to an already running process;
- resuming a persisted native session;
- forking a persisted native session; and
- importing or opening restored native session material.

Illustrative API only:

```ts
interface RuntimeSessionRef {
  runtime: string;
  sessionId: string;
  installationId?: string;
}

interface AgentRuntime {
  resume?(source: RuntimeSessionRef, config?: AgentStartConfig): Promise<AgentSession>;
  fork?(source: RuntimeSessionRef, config?: AgentStartConfig): Promise<AgentSession>;
}
```

The final Runtime design must define adapter capabilities, ownership, idempotency, startup failure behavior, and whether resume returns the same native id while fork returns a new one. An absent method or failed capability check means unavailable, not unsupported by inference.

### Conservative recovery policy

- Prefer **fork** when the Conversation has advanced since the old activation retired.
- Permit direct **resume** only after explicit confirmation and an adapter verification that the native session is available.
- Before activation, require current Conversation-agent work to be idle or stopped.
- Create a new binding generation even when direct resume reuses the same native id.
- Set `source_history_id` on the new activation.
- Advance the Relay cursor to the current Conversation head so historical messages are not replayed as new work.
- Provide a bounded handoff/current-context brief when the old harness context may be stale.
- Fence all output from prior generations.

The Conversation transcript wins if harness context and Conversation state disagree.

## MinuSessionStore integration

MinuSessionStore currently catalogs native sessions by owner, source installation, harness, and external session id, and stores immutable raw snapshots separately. Channels history can correlate with that catalog using:

- Runtime adapter/harness;
- native session id (`externalId` in Session Store); and
- source installation id when available.

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

Lifecycle metadata is small and should initially be retained for the lifetime of its Workspace or Conversation. Runtime transcript retention remains a harness and MinuSessionStore concern.

Future deletion policy must distinguish:

- removing a Channels history reference;
- deleting local harness session material;
- deleting Session Store catalog records; and
- deleting exact S3 object versions.

No Channels action should cascade into archive deletion without a separate, explicit, provider-owned confirmation flow.

## Rollout plan

### Phase 1 — Durable lifecycle history

- Add activation-history persistence and migrations.
- Transactionally dual-write binding changes and history.
- Add pending-retirement reconciliation.
- Keep all existing UI and public contracts unchanged.

### Phase 2 — Runtime resume and fork

- Define and version MinuRuntime capabilities and methods.
- Implement Pi support first if its native session contract remains stable.
- Implement native Codex support independently when a Codex Runtime adapter exists.
- Add owner/admin local actions with generation fencing and confirmation.

### Phase 3 — MinuSessionStore bridge

- Define a narrow locate/restore capability.
- Add source-installation correlation without exposing storage internals.
- Prove checksum-verified restore followed by adapter validation and fork/resume.

### Phase 4 — Recovery UI

- Show sanitized session history on the local agent/Conversation administration surface.
- Clearly distinguish current, local historical, archived, unavailable, and cleanup-failed sessions.
- Default stale-session recovery to fork rather than resume.

## Migration and compatibility

The Phase 1 migration should create one `migrated` active history row for every existing non-disabled current binding. Unknown activation sequence or verification data remains null/unknown; it must not be invented.

During a staged rollout, existing `runtime_adapter` and `runtime_session_id` binding columns remain the routing source of truth. History writes must occur in the same storage transaction as binding creation, replacement, or retirement. If the storage adapter cannot provide that transaction, it is not ready for the feature.

Older binaries must not run against a schema they cannot safely maintain. Normal product migration backup and compatibility rules continue to apply.

## Verification requirements

At minimum, automated tests must prove:

- first start creates exactly one current binding and matching generation-1 history row;
- concurrent replacement attempts allow only one generation transition;
- replacement retains the previous native session id before attempting stop;
- stop failure remains durably retryable after process restart;
- successful reconciliation never changes the current binding;
- reactivating the same retired native session creates a new generation and history row;
- stale generations cannot deliver messages after resume, fork, or restore;
- unsupported adapter operations fail without mutating the binding;
- migration backfills current bindings without exposing private ids;
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

1. Which stable installation identifier should MinuRuntime expose, and how should it align with MinuSessionStore's source installation id?
2. Should direct resume be allowed after any Conversation divergence, or should divergence always require fork?
3. Does restored native material keep its original native id or receive a new import id per adapter?
4. What bounded retry policy should pending cleanup use before requiring explicit operator action?
5. Should launch-profile snapshots be retained for display/reproducibility, or should recovered sessions always use current Workspace-agent configuration?
6. When should the one-table activation model be normalized into separate Runtime-session identity and activation tables?
7. What explicit user flow governs deletion of local session material or archived S3 versions?
