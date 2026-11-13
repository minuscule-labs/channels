# Authored workspace/channel instructions and playbooks

**Current source:** owner483 authorized turning on the existing Skill-send flow. Normal product and control-daemon startup now enable authored Skill publication by default; an explicit `authoredSkillPublicationEnabled: false` disables it. The lower-level `LocalControlService` remains fail-closed unless its host enables publication. No permission, recipient, session-pin, retirement or recovery safeguard is removed. Unsupported Harness invocation stays disabled. This source change does not patch/restart an existing installation: released v0.0.34 remains default-off until upgraded to a separately verified release containing this change. Prior bounded engineering/positive Notes evidence remains historical; outstanding denied-tool/Notes, owner-usefulness and exact-artifact acceptance are not silently declared complete or authorized for rerun.

See the [criteria and LEVVS evidence](verification/workspace-instructions-and-skills.md). Publications apply to newly created sessions/New session, never silently replace active guidance. Retirement blocks new/queued unstarted use without restarting sessions, interrupting active work or rewriting history. Instructions add no permissions; autonomous authored-skill activation and global libraries remain excluded. F1–F4 closures stand.

## Scope and authority

Settings authoring is Workspace-only: manage shared Instructions and Skills in Workspace Settings. Conversation settings contains no authored Instructions/Skills editors and does not automatically read their library, bodies or context. Presets supply task-specific instructions copied at creation, independently of the Workspace baseline; changing a preset does not rewrite existing Conversations. Global libraries are not introduced.

Existing channel-scoped documents, snapshots, pinned invocations and active sessions are preserved. Removing their editors does not silently delete, migrate or disable their instructions. The legacy backend contract below remains compatible; this presentation change does not remove explicit skill invocation or selected-agent status in Diagnostics.

Documents are either `instructions` or `skill`, and belong to one workspace with an optional `conversationId` for channel scope. Scope and kind cannot be changed by editing. Workspace-scoped documents omit `conversationId`. A channel must belong to the specified workspace; thread-local authoring is rejected, and thread sessions inherit parent-channel publications.

All management operations, including body/history reads, require an authenticated local browser session whose identity is an active human owner/admin of the workspace. The actor is derived from that session, never from request data. Management-body and authoring access is not expanded by the separate member-use permission. This is an administrative library, not an operational per-session skill-availability catalog.

Bodies and revision history live only in the private Relay database. No collaboration message, public schema, public SSE event, or Runtime session is created merely by authoring/publishing. Authorized owner/admin document lists include names and descriptions for the Skills management table but omit procedure content. This does not expand member/public access. Detail/history reads return bodies only through authenticated local control. Audit events include action/outcome and actor/scope IDs, never bodies or names/descriptions.

## Editor Save

Workspace Instructions and Skills use one **Save** action. The editor sends `action: "commit"` in a single create/update request; storage writes the complete head and its immutable active snapshot in one transaction. An insertion failure rolls back both. Skill saves require a name, description and nonblank instructions; empty instructions may be saved to clear standing guidance. Updates retain the existing expected-version conflict guard.

Preview and skill Archive remain. Draft/publish controls, history controls and revision badges are not shown. Internal snapshots remain private because existing sessions and already-accepted invocations retain exact pinned instructions. Saving does not hot-reload running sessions or grant permissions.

Existing unpublished drafts are not migrated or automatically activated. Opening/reloading an editor is read-only; only an explicit Save activates the submitted content. Legacy draft and publish API operations below remain compatible. New editor creates add `"action": "commit"` to POST; updates use `"action": "commit"` with complete fields and `expectedVersion` in PATCH. Creates without this action still create legacy unpublished drafts, and legacy `action: "save"` remains draft-only.

## API

```http
GET   /local/workspaces/:workspaceId/authored-documents
POST  /local/workspaces/:workspaceId/authored-documents
GET   /local/workspaces/:workspaceId/authored-documents/:documentId
PATCH /local/workspaces/:workspaceId/authored-documents/:documentId
GET   /local/workspaces/:workspaceId/authored-documents/:documentId/revisions
GET   /local/conversations/:conversationId/authored-context
POST  /local/conversations/:conversationId/skill-invocations
GET   /local/conversations/:conversationId/skill-invocations/:requestId
GET   /local/conversations/:conversationId/skill-invocation-publications?requestId=...
POST  /local/conversations/:conversationId/skill-invocation-publications
```

Successful document responses include stable `id`, `workspaceId`, optional `conversationId`, `kind`, draft fields, `state`, edit `version`, optional `publishedRevision`, creator/updater and timestamps. The list returns summaries; history returns immutable published snapshots with a SHA-256 `contentHash`, publisher, and timestamp. Responses are `no-store`.

Create workspace instructions:

```json
{
  "kind": "instructions",
  "content": "Save MinuNotes beneath the permitted base-folder URL. Ask if unavailable."
}
```

Legacy API example for a channel playbook (no longer exposed by the Settings editors):

```json
{
  "kind": "skill",
  "conversationId": "conversation-example",
  "name": "Write a decision note",
  "description": "Capture an agreed decision and its rationale",
  "content": "Summarize the decision, alternatives, owner, and next action."
}
```

Creation produces an unpublished draft with `version: 1`. A skill requires a nonblank name; its draft description/procedure may be empty. Instruction names are generated from scope, not user-editable. There is one instructions document per workspace/channel scope, enforced by storage uniqueness, including concurrent creates.

Legacy API: save a complete replacement of the editable draft fields (the current editor uses `commit` instead):

```json
{
  "action": "save",
  "expectedVersion": 1,
  "name": "Write a decision note",
  "description": "Capture an agreed decision",
  "content": "Record the decision and the next action."
}
```

For skills, send the name and complete description/content to preserve them; omitting description clears it. For instructions, send only `action`, `expectedVersion`, and `content`.

Publish or archive a skill:

```json
{ "action": "publish", "expectedVersion": 2 }
```

```json
{ "action": "archive", "expectedVersion": 3 }
```

- Every successful save/commit/publish/archive advances the edit `version`; initial atomic creation starts at version 1 with snapshot 1.
- Publication atomically advances `publishedRevision` and writes an immutable snapshot. Hashing covers name, description, and procedure, not draft metadata.
- Saving a new draft leaves the old publication unchanged. Publication requires a skill description and nonblank procedure.
- Skill archival retains history and prevents further draft/publication changes. Restoration/deletion is not implemented in this slice.
- Clear standing instructions by publishing empty content; instruction archival is rejected so the singleton instructions document cannot become an uneditable scope.
- A stale token or competing SQLite writer returns conflict; no write is automatically replayed. After an uncertain publication, inspect the document/history to resolve its result before sending another mutation. An old token cannot produce a second publication.
- Creation is not an idempotent-retry API; clients must not automatically repeat an uncertain create.
- IDs/scope cannot be retargeted by a save. Unknown fields, executable-bundle fields, capability grants, and global scope inputs are rejected. Markdown can still describe legitimate use of existing tools; publishing grants no tool access.
- Content is limited to 64 KiB UTF-8, skill names to 200 bytes, and descriptions to 2000 bytes. These match the bounded private configuration approach, not an execution sandbox.

The browser-safe contracts and `LocalControlClient` expose typed methods for these endpoints. Existing harness skill discovery/selection is unchanged.

## Explicit invocation acceptance (T4 checkpoint)

This is private intent acceptance only, not a usable invocation/delivery flow. The owner confirmed that all active human workspace members with Conversation access may use published skills. Acceptance and own-receipt lookup require active human identity, active workspace membership and active participation, independent of owner/admin/member role. Draft/body/history/edit/publish management remains separate and unchanged. T6's separate member-visible catalog and gated picker/availability/submission flow are implemented, awaiting independent review; production activation is not included.

POST requires an `Idempotency-Key` (opaque, nonblank, at most 255 bytes) and this complete input:

```json
{
  "documentId": "skill-stable-id",
  "source": "workspace",
  "revision": 1,
  "arguments": "Capture the agreed decision.",
  "to": ["explicit-agent-identity-id"]
}
```

Only workspace/channel sources are supported. Each selected recipient must be an active agent/service member and participant with an exact available pinned publication and stable binding generation. Empty, duplicate, ambiguous, foreign, unsupported, or partially unavailable selections fail without accepting work. Arguments are limited to 64 KiB UTF-8; the backend uses the explicit submitted recipient set and never reparses argument mentions to change it. No implicit agent starts or replacement sessions occur.

A 202 response acknowledges one immutable private operation, with actor, scope, skill identity/revision/name, arguments, explicit recipients, and acceptance time. It does not acknowledge dispatch or completion. Runtime/binding identifiers and procedure bodies are omitted. Requests are namespaced by Conversation + authenticated actor + request key; recipient order is normalized as a set, while arguments remain exact. A changed payload under an existing key conflicts.

After uncertainty, GET the URL-encoded request key using the same authenticated actor. An exact retry returns the same accepted intent; there is no automatic retry. Receipt lookup after archival is historical acknowledgment, not new acceptance or permission to dispatch an archived skill. Access revocation still blocks receipt access.

Intent acceptance creates no public message and starts no worker; the separate authenticated publication endpoint performs the explicit send. The lower-level service requires host enablement, and the composer observes rather than changes that capability. Normal product/control-daemon startup enables publication when the option is omitted or true; explicit false disables it. No CLI/environment/persisted toggle, implicit agent start or exactly-once external-effect claim is added.

## Published catalog and gated `/skills` composer (T6)

`GET /local/conversations/:conversationId/authored-skill-catalog` and typed `getConversationAuthoredSkillCatalog` expose a separate read-only member-use surface. Owner-only effective-context and draft/body/history/authoring endpoints are unchanged and are not reused for discovery.

Cookie-derived active human members must participate in the requested Conversation; access and browser session are rechecked after I/O. A thread uses its parent channel. Only active published workspace/channel skills appear, with ID/source/published revision/hash/name/description from the immutable publication—not current draft metadata. No procedure or instruction body, private paths/owners, Runtime discovery or mutation. Publication heads are observed once; concurrent publish/archive changes do not invalidate the whole catalog. Discovery grants no execution permission: acceptance and delivery revalidate use, including retirement and recipient pins. Valid older pinned revisions retain existing acceptance semantics. Each publication history is read once and identity/hash checked; missing/corrupt publications fail unavailable without a draft/partial fallback.

The DTO says `availability: "not_checked"`: discovery is not a send grant or completion. Optional agent hints contain public identity IDs, skill-only pinned references and sanitized configured Harness IDs; no binding/session IDs, owners, procedure/instruction bodies or Runtime calls. The endpoint is GET-only/no-store and accepts no query/actor/scope override.

A leading `/` opens the searchable skill list above the composer using the existing mention-popup interaction; `/skills` remains an alias. Type to filter, use arrows and Enter/Tab to select, or Escape to dismiss without changing the draft. Selection attaches one removable chip inside the composer and returns focus to typing. There is no separate Skills button or modal. Chip details show only the selected publication's existing name/description/source/revision metadata, not instruction bodies, drafts or private Harness paths. Channel/Workspace/Harness provenance, duplicates and revisions remain distinct. Authored selection retains ID/source/revision/hash; selection never sends work. Review verdicts apply to their recorded source targets. Availability checks every actual selected recipient against current participation/live state and exact session pins. Latest unpinned revisions are Pending; retired/missing/unsupported choices are Unavailable, never replaced by a same-name procedure or a new session. Harness entries remain disabled without a supported invocation contract.

Skill choice, arguments, explicit recipients and receipt state persist independently per human/conversation/thread. The composer has no recipient dropdown: skills use the ordinary mention and sticky-recipient rules. Active unquoted/non-code mentions select recipients; editing them updates the target set. With no active mentions, the human's existing sticky recipient applies. A single-recipient skill submission updates that sticky selection just like an ordinary submission; multi-recipient and broadcast messages do not replace it. Attaching/removing a skill preserves the current targets. Quoted/code context mentions stay inert, using the existing mention parser rather than a separate skill targeting system. Acceptance and publication use the existing safe APIs and persist original request/receipt identity and the publication-attempt marker before writes. Inspection is GET-only and never resends. `Publish accepted` requires a matching original draft/recipient set and current readiness; a publication attempt cannot be automatically repeated. Newer drafts survive inspection. Skill-plus-attachment/reply combinations block submission rather than silently dropping context.

`features.authoredSkillPublication` reports the host's publication capability; the composer cannot submit when it is false/absent. Normal product/control-daemon startup enables it by default, while an explicitly disabled host or an unconfigured lower-level service remains unavailable. Author checks: backend compilation/web types, 15 catalog cases, 21 focused web unit cases, eight assembled skills browser cases and three ordinary-recipient browser regressions passed in separate runs. See the [current status and evidence](verification/workspace-instructions-and-skills.md#current-status); independent verification, activation and intended-use/release acceptance remain pending.

## Private delivery preparation (T5 backend)

The backend-only `prepareAuthoredInvocationTurn` loads a privately accepted operation using trusted internal scope/target selectors. It checks active workspace/Conversation, current human and recipient membership/participation, active agent configuration, an existing connected/unmuted binding and its exact accepted generation/manifest. It resolves/hash-checks only the pinned procedure and rechecks availability after the private body read.

Its body-containing result is **server-private input**, never a public receipt/message. Missing/corrupt content, access loss, retirement or a stale/stopped target rejects with a sanitized error; preparation does not send bare arguments as a fallback, mutate the accepted intent, wake a worker, or restart a session.

Preparation alone is still not a durable message link or send grant. The restored Relay binding now calls it through a message-linked adapter only after waits, immediately before a new recoverable Runtime turn. No dispatcher may blindly drain accepted rows or trust copied public metadata.

## Trusted publication and guarded Relay (second partial T5 checkpoint)

The server-private `publishAuthoredInvocationMessage` resolves an accepted operation through its Conversation/actor/request selector. It preflights all frozen recipients and commits a unique immutable operation-to-message-ID link in private storage **before** calling Core. Core supports caller-stable message IDs with mandatory idempotency keys and an inert public `authoredInvocationId` reference. Both optional fields participate in exact-retry fingerprints; ordinary legacy fingerprints remain unchanged. A copied public reference cannot establish private authority.

The public message contains the exact accepted arguments, explicit recipients and opaque correlation ID—not the procedure, binding/session IDs, or private source paths. Blank arguments use a short playbook label. Ordinary browser posting rejects skill markers, so it cannot bypass the internal publisher or auto-start recipients through copied metadata.

`prepareLinkedAuthoredInvocationTurn` selects intent only through the private message-ID association and validates its public author, arguments, recipients, correlation ID and Conversation. Missing/copied/stripped/altered linkage fails closed. Restored bindings install this adapter; `all_messages` never broadens a skill's explicit recipient set.

For a new Runtime turn, Relay waits for idle and finishes public context/image work, resolves the pinned private input, then verifies its lease. Because renewal can wait while policy changes, Relay freshly repeats trusted private preparation **after the lease wait**, requiring an identical pinned input. Restored bindings supply their expected lease owner and the same clock used for lease management. Both current-state passes validate that owner, the frozen generation and a strictly live expiry, comparing time after validation I/O. Lease loss retains the existing fenced-turn outcome rather than publishing a stale-host failure. This is the last asynchronous admission step; synchronous early Stop/cancellation/active-participant/deadline checks follow before `startTurn`. Private preparation, including the final recheck, is bounded by the existing request/turn deadline. No stable-turn capability or resolver means unavailable, never a legacy `send`, bare arguments or native-command fallback.

Runtime turns already accepted under the stable Conversation/recipient/public-message turn ID are reconciled without sending another prompt or interrupting running work on retirement. Publication acknowledgment loss retains its link and stable Core key for explicit inspection/retry; no mutation is automatically replayed. Tested reopen covers private SQLite and Core acknowledgment loss, not an HTTP-host crash. Point-in-time checks are not a cross-service atomic transaction.

**Historical opt-in checkpoint:** T4 intent-only acceptance and T5/T6 product → daemon → service wiring were independently accepted while default-off. Owner483's follow-up enables that existing path in normal startup; it does not waive remaining provider/authorized Notes or release acceptance, add a CLI opt-in, or alter an already-running installation. Historical checkpoint `f525de0250f562efd08c00059f1d82d43f7952b2290d781f042dcc4b3f2822b1` introduced the catalog; the subsequent KISS cleanup changes only discovery, its tests and documentation, not acceptance/delivery safeguards.

## Read-only publication-uncertainty inspection (partial T5)

The server-private `inspectAuthoredInvocationPublication` accepts an authenticated Conversation/actor/request selector, not a public invocation ID. It requires current active human workspace membership and Conversation participation before private reads, verifies exact workspace/channel scope, then reads the existing operation/message-ID link and public message snapshot. Access is checked again after all inspection I/O; revocation during either private or public reads denies the result.

The result contains only the accepted operation ID and:
- `not_linked`: no private association was read; no public lookup is used to invent one.
- `not_observed`: the original linked message was not found in this snapshot; the same reserved message ID is retained.
- `observed`: that exact message matches the accepted author, arguments, recipients, correlation and scope.

These are observations, **not proof of non-publication, Runtime delivery/completion, or permission to retry/send**. Copied public references never establish an association. Mismatched messages, corrupt links and failed reads are unavailable, not inferred absence. Errors are sanitized; no procedure, arguments or private Runtime/binding identifiers appear in the result.

Retirement and recipient revocation do not erase historical publication. A currently authorized human can inspect it without resolving the retired procedure or requiring the old target to be available. Revoked human access still denies inspection; the immutable operation and original link remain untouched.

Inspection never publishes, reserves/replaces a link, loads procedure bodies, changes queues/sessions/leases, wakes agents or calls Runtime. The authenticated read-only receipt below uses this observer. Acceptance remains unwired to publication; the new explicit action uses the publisher's strict new-link mode. Inspection does not silently resume publication or drain accepted rows. SQLite close/reopen checks are not a host-crash recovery claim.

## Authenticated publication receipt HTTP (partial T5)

`GET /local/conversations/:conversationId/skill-invocation-publications?requestId=...` returns a separate `LocalAuthoredSkillInvocationPublicationReceipt`. The existing acceptance/own-intent receipt is unchanged. `LocalControlClient.getAuthoredSkillInvocationPublication` uses credentialed GET and `URLSearchParams`; opaque slash/query/Unicode and dot-only keys retain exact query identity without URL path normalization.

Exactly one nonblank request key of at most 255 UTF-8 bytes is required. With publication disabled, other methods return 405/Allow GET; an enabled host adds only the POST action described below. The actor comes only from the authenticated browser cookie, never query/header actor values. Current own-receipt authorization is reused; another active human's request is 404, even for managers, and current access denial is 403. Inspection failures or revocation during observation return a fixed unavailable response without an observation. The browser session/scope/identity is reauthenticated after the awaited read; an expired session cannot receive the result.

Responses are private `no-store` JSON and explicitly project only `requestId`, `invocationId`, observation `status` and, when linked, `messageId`. They expose no procedure, arguments, names, source hashes, bindings, Runtime/session/lease identifiers or new authoring permissions. `observed` still means publication only, never Runtime delivery/completion or retry permission.

This is an additive GET, not a public producer or retry endpoint. No publishing, reservation, queue/session/lease mutation, body resolution, wake/restart or Runtime call is added. The composer cannot submit on default-disabled hosts; explicit publishing remains opt-in as described below. Standard Idempotency-Key header whitespace normalization is unchanged; the raw-space stored-key GET test uses explicit private fixture setup rather than claiming that HTTP headers preserve outer whitespace.

## Explicit publication orchestration (gated partial T5)

`LocalProductAppOptions.authoredSkillPublicationEnabled` forwards through `LocalControlDaemonOptions` to the existing private `LocalControlServiceOptions` gate. The daemon supplies true when omitted, so normal product and standalone control-CLI startup enable supported sending without a hidden opt-in. Explicit false remains a host-level disable option. The lower-level service alone still defaults off. Owner483 authorizes this default change; no CLI flag, environment setting, persisted toggle or live configuration edit is introduced.

With `authoredSkillPublicationEnabled` explicitly true, `POST /local/conversations/:conversationId/skill-invocation-publications` accepts only `{ requestId, invocationId }`. It selects an existing own accepted operation; it cannot supply a new actor, source, revision, arguments, recipients or replacement identity. Both fields must exactly match the own acceptance receipt. `LocalControlClient.publishAuthoredSkillInvocation` takes the accepted receipt's `id` and `requestId` and projects only these two fields, preserving the accepted wire key without trimming or alias lookup.

**Normal product/control-daemon startup enables publication by default; explicit false disables it. Composer wiring only observes this capability.** Existing acceptance stays intent-only and GET stays read-only. Disabled POST remains 405/Allow GET; enabled hosts permit only GET/POST. All current actor/scope/recipient/pin/retirement checks remain authoritative.

The explicit action authorizes the browser actor and accepted identity, then inspects the original association:
- Already `observed`: acknowledge that original message with no repost, even after retirement if current human access remains.
- Linked but `not_observed`: return unavailable/409, retaining the original association. Absence does not authorize a resend, even from another ordinary publish call.
- `not_linked`: preflight the frozen recipients/publication and attempt strict new-link reservation. Only the caller whose proposed message ID won that CAS can make a Core post; losing/concurrent writers do not reuse a link to resend.

The publisher's new `requireNewLink` mode is used by this action; existing server-private exact-retry semantics remain unchanged for their explicit internal callers. No automatic retry, accepted-row draining, replacement link or new session is introduced.

Publication shares existing Conversation send ordering; Stop/cancellation remain outside that queue. A synchronous browser-session assertion runs after queue waits, before link reservation, after reservation immediately before Core post, and before returning a receipt. Expiry before a write blocks it; expiry after reservation preserves an unresolved link with no Core send. If Core committed before session/acknowledgment loss, a later authorized explicit action can acknowledge the same observed message without posting again.

Success returns the existing minimal publication receipt (`observed`), **not Runtime completion**. Unresolved link/transport outcomes remain blocked for a separate reviewed recovery action; this POST never treats an observation as retry authority. Current retirement/access/session gates and the existing lease-aware addressed Runtime admission still apply. No implicit agent start/restart or native fallback.

This boundary is tested through real local Control/Core HTTP/private SQLite, competing store writers and a restored Relay feeding one selected simulated Runtime turn while an unselected `all_messages` observer receives none. It is not genuine provider/Notes validation or full host-crash recovery.

## Bounded host/service restart evidence (partial T5)

`packages/control/test/authored-invocation-recovery.test.ts` closes the real Control HTTP server and LocalAgentHost, closes both Core/private SQLite connections and Core HTTP, then opens fresh server/client/configuration/host/store instances over the same files with a new host lease owner and fresh browser session. The retained external Runtime is simulated; no production code change or gate enablement was needed.

Nine cases establish:
- Accepted-only and linked-but-unobserved requests retain their original identities and remain unsent; recovery does not reserve or publish another trigger.
- An observed but unstarted message catches up using its original message/turn IDs and pinned procedure revision, even after a newer publication exists. Retirement or actor revocation before dispatch blocks the queued turn.
- A Runtime turn accepted before a lost start acknowledgment is queried/reconciled without a second start after restart, including retirement/revocation while already running. It is not interrupted or forced to reload a procedure.
- Completed turns with uncommitted responses are mirrored once; committed-response acknowledgment loss preserves the original response ID and produces no duplicate public reply.

All cases retain the accepted operation/link, binding generation, managed session/owner and authored manifest. No new managed session, legacy send, interrupt/suspend, private-body leak or recovery publication is observed. The replacement Control service keeps the producer default-off.

**Limits:** orderly in-process close/reopen, not SIGKILL/OS-process failure, daemon-wrapper shutdown, provider/Runtime restart, persisted provider transcripts, lease-expiry takeover after an unclean death, or thread/multi-agent recovery acceptance. The simulated Runtime's state survives only as an independent in-memory fixture. These nine author checks do not close full T5 recovery or T7 validation.

## Isolated unclean host-process loss evidence (partial T5)

One additional integration case forks a real LocalAgentHost/Control HTTP/private-store child, accepts a stable-ID Runtime turn through IPC, withholds its acknowledgment, then kills that exact child with `SIGKILL` without cleanup. Core and the simulated Runtime remain outside it. The saved owner/lease survives reopening the private store: a replacement host is denied before expiry and acquires ownership only after clock-selected expiry.

Recovery preserves the accepted operation, original message/link, generation, Runtime session/owner and manifest, queries the original turn, then mirrors one reply with no additional start. Unpublished and linked/unobserved controls remain unsent, with zero recovery publication/reservation attempts. The child HTTP producer and replacement Control service remain default-off.

**Limits:** one accepted-turn crash checkpoint; injected host clock/manual restore, retained in-memory simulated Runtime and live external Core, not every crash window, whole-daemon/provider/Core restart, provider transcript persistence, automatic retry timing, thread/multi-recipient recovery or release approval. Compilation and the isolated case passed independently. Whole-ticket closeout remains pending the thread-authored-delivery/isolation evidence gap mapped at verification checkpoint 16; no additional crash matrix is automatically required.

## Persistence

Private migration `0018_authored_documents` adds document heads and publication history without rewriting existing workspace roots, notes-folder settings, personas, harness skills, or session records. Draft changes use compare-and-swap versions. Head/publication writes share a transaction; an insertion failure rolls back the head. The in-memory store implements the same transitions for fixtures.

Private migration `0019_authored_session_context` adds a nullable launch manifest to session history. Known-empty manifests are distinct from legacy sessions without evidence. Manifests are committed with the binding generation, contain immutable publication references, and survive persistent reopen. A stored publication alone is not evidence that an agent received or followed it. Stored manifests are decoded explicitly: only SQL NULL means legacy; JSON null/falsy, malformed or structurally invalid data is unavailable, never normalized to legacy.

Private migration `0020_authored_skill_invocations` adds immutable accepted-operation metadata and frozen recipient binding/generation references. Private migration `0021_authored_invocation_message_links` adds the one-to-one immutable publication link. Core migration `0012_authored_invocation_messages` adds a nullable public correlation column, without procedure bodies or changing historical ordinary messages. These follow main’s existing conversation-preset, conversation-settings and creation-folder-preparation migrations.

## Session behavior

- New sessions capture the current published workspace/channel instructions and scoped playbook references.
- Retirement requires no New session: it prevents new acceptance without changing retained bindings. The internal T5 Relay gate blocks accepted-but-not-started delivery while leaving running/completed work untouched; broader daemon/provider and assembled-flow validation remains separate, not an unnamed T5 blocker. Already supplied procedure knowledge cannot be erased from a transcript. Activation rules for newly published skills/revisions are unchanged in this chunk.
- Standing instructions are appended alongside the existing persona/harness guidance; channel defaults specialize workspace defaults without granting access or overriding platform/project constraints.
- Draft content and complete playbook procedures are not injected as standing instructions.
- Retained Start, host restore, idle wake, and recovery keep the original manifest. Recovery-created workers resolve the pinned instruction revisions, not latest. Legacy recovery does not adopt new guidance.
- Explicit New session/Fresh session use current publications. Fresh thread sessions inherit current instructions while omitting inherited chat background.
- Missing, corrupt, wrong-scope, or unavailable pinned instruction publications block recovery rather than falling back silently.
- The effective-context endpoint is owner/admin-only. It returns current published instructions and separate per-agent launch references/status: Not started, Not verified (legacy), Applied, Pending, or Unavailable. Pinned standing instructions are resolved and integrity-checked before Applied/Pending is reported; missing or corrupt pinned content is Unavailable. It does not claim a model obeyed or used the guidance.

## Management UI

Workspace Settings and channel Settings provide Markdown editing/preview, one Save action, explicit skill scope at creation, and skill archive. Revision numbers and history controls stay out of Settings; internal snapshots and conflict checks remain. Channel Settings keep the shared instruction editor without duplicating saved instruction bodies or displaying session state. Each agent's Inspect → Diagnostics view shows only that agent's instruction status; instruction bodies and other agents' references are not retained in its query cache. Existing agent menus still own New session actions.

Stale writes preserve the local draft. Review latest shows current saved content; Keep draft on latest revision explicitly adopts its concurrency token without writing or replacing the local draft. Newer saved responses update only pristine editors, avoiding stale publication badges without overwriting unsaved work. Access-denied reads/writes stop management and remove private editor state. Private document queries are actor-scoped, ephemeral, and not persisted to browser storage.

Private acceptance/guarded delivery and the capability-aware `/skills` composer are described above. The T6/I1 engineering path is retained, with owner483's normal-startup enablement as a separate source change requiring verification/release. T7's bounded positive Notes outcomes remain independently verified; outstanding denial/owner/CI and new exact-artifact gates are not waived. Existing native harness skill selection/autonomous behavior is unchanged.
