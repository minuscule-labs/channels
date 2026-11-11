# Workspace instructions and skills — published tickets and source drafts

**Publication:** seven child tickets created through the user-authorized MinuNotes MCP surface. T1–T4 are Done for their bounded engineering scope following independent closeout. T5 is In Progress with a backend-only preparation checkpoint; T6/T7 are Backlog. All seven are Type Task; the parent remains In Progress / Feature. T7 intended-use validation and feature/release acceptance remain pending. The earlier missing-configuration error belonged to the separate `minunotes_*` wrappers, not MCP.

**Destination:** Minuscule Labs → MinuChannels → Board (`folder_a209f5bda7ec46788ffa3d0fe833347a`). Re-read the current folder schema before setting board properties; do not reuse an old revision.

**Existing parent:** [Workspace instructions and channel/workspace skills — feature plan](https://notes.minusculelabs.com/notes/note_01a1a10fd15c74febb29cbfd90ddd96e).

Every child was created with the parent link shown below, and the parent now contains all seven child links plus the verifier handoff. Read-back verified the exact bodies/parent links for T1, T2, T4, T5, T6, and T7, and verified the complete parent index. T3 creation/classification succeeded; its initial read-back failed without an automatic retry. Later verifier and author MCP reads succeeded, resolving that gap. MCP does not expose an incoming-backlink listing tool, so the app's backlink display was not separately queried. Parent edits used its freshly read content hash and preserved the existing plan.

**Method:** [LEVVS v0.2](https://notes.minusculelabs.com/notes/note_7e85c790362a4ff6acd41c4b8499cceb), applied proportionately. No additional task-generation skill, framework, or evidence database is required.

**Execution target:** `feat/workspace-instructions-skills`, based on `1237214d0e9629fc4c263fd15859c5a9e446d067`, in `/Users/davidkennedy/Workspaces/minuscule-labs/worktrees/channels/workspace-instructions-skills`. Feature changes are uncommitted and unpushed. Do not review or edit the original `channels/` checkout on `feat/conversation-threads`.

**Canonical local evidence:** [Acceptance scenarios and execution record](../verification/workspace-instructions-and-skills.md). The current bounded author checkpoint is partial T5 private preparation: compilation, 14 new preparation tests and 15 adjacent regressions passed on fingerprint `0e49e4de8539ae50564fe9c6ded4bb653af4f80adf537ce0d4c333ec811556dd`. Actual Runtime delivery/linkage remains unimplemented. Prior independent T4a/T4b passes remain attached to `5a4328e0…`, not automatically this changed authorization target. The earlier 88+5 author results remain historical author evidence. Independent T2/T3 closeout on this same target reused prior unchanged-UI evidence and closed F1/F2; see the execution record for exact scope, target and limitations. No full-feature acceptance is claimed.

Tickets T1–T3 retrospectively organize work already implemented against the earlier parent/acceptance plan. This breakdown was not written before that implementation. T4 acceptance is independently closed under the owner-confirmed member-use policy. The first private T5 preparation slice is implemented; actual delivery/linkage/recovery and T6/T7 remain future work. T2/T3 are independently verified and Done for their engineering acceptance criteria; their original T7 validation deferral is preserved.

## Shared decisions and dependencies

- Implemented conservative policy: published standing instructions apply to newly created sessions; retained sessions/recovery preserve launch references. Stakeholder validation remains pending.
- Authored procedures are not standing instructions. The owner confirmed that active human workspace members with Conversation access may use published skills. The use-permission delta is In Review; no dispatcher/composer is enabled. Native harness skill behavior remains unchanged.
- Workspace/channel scopes only; cross-workspace global libraries, autonomous authored-skill activation, executable bundles, new tool permissions, and hot updates are excluded.
- **Confirmed D4 (owner message 63):** retired skills block new and queued-but-not-started uses, without restarting sessions, interrupting active turns or changing completed work/history. Flag unavailable and require an explicit alternative. Current access revocation remains independent; T5 will implement/test this delivery gate.
- Dependencies: T1 → T2 → T3; T1 + T2 → T4 → T5; T6 depends on T4's contract and T5's delivery behavior; T7 evaluates the assembled feature. T4/T5 may be separately reviewed but must not expose a usable invocation flow before delivery is safe.
- Human scope/exception acceptance is separate from the verifier's recommendation. Do not weaken criteria to fit code or turn a proposed check into a passing result.

---

## Published board index

| Ticket | Title | Status | Note |
| --- | --- | --- | --- |
| T1 | Versioned content and permissions | Done | <https://notes.minusculelabs.com/notes/note_01a1a4118d1c714da006c13e5593c6a5> |
| T2 | Apply standing instructions to sessions | Done | <https://notes.minusculelabs.com/notes/note_01a1a41189c1762d94afcb9095ba65c3> |
| T3 | Manage instructions and skills in Settings | Done | <https://notes.minusculelabs.com/notes/note_01a1a4118a7373fd930d37b36342f206> |
| T4 | Accept explicit skill invocations safely | Done | <https://notes.minusculelabs.com/notes/note_01a1a41189ce7753b86bf03eb9f2880c> |
| T5 | Deliver and recover skill invocations | Done — gated backend | <https://notes.minusculelabs.com/notes/note_01a1a4118a3b70adb6e8140fd3d0ff3a> |
| T6 | Add the `/skills` composer experience | Done — engineering; production default-off | <https://notes.minusculelabs.com/notes/note_01a1a41189a57118838f3d54e3aeac61> |
| T7 | Validate the assembled feature | In Progress | <https://notes.minusculelabs.com/notes/note_01a1a4118cfe700ebcec2c4a3acd51a4> |

MinuNotes work for these tickets uses registered `mcp__minunotes` tools, per the owner's instruction. No alternate transport or automatic mutating retry is authorized by this record.

## T1 — Versioned content and permissions

Parent: [Workspace instructions and channel/workspace skills](/notes/note_01a1a10fd15c74febb29cbfd90ddd96e)

### Intent and scope

Provide private instruction-only workspace/channel document drafts and immutable publications, using the existing active human owner/admin authority. Cover management APIs, persistence, conflict handling, and skill archival. Exclude agent execution, composer invocation, global sharing, and tool grants.

### Observable acceptance criteria

- Authorized owners/admins can create/read/save instruction or skill drafts in an owned workspace/channel; a channel cannot belong to another workspace.
- Draft saves do not change an existing publication. Publication atomically writes a new immutable revision, hash, and publisher provenance.
- Stale/concurrent writes do not overwrite accepted state or produce partial publications; uncertain outcomes are inspectable before another mutation.
- There is one instructions document per scope; empty publication clears future standing guidance. Skill archive retains history and blocks future edits/publication. Instruction archival is rejected rather than stranding its singleton document.
- Unauthorized/foreign-scope reads and mutations fail without protected bodies. Publication grants no capabilities; scripts/bundles and unknown permission fields are rejected.
- Migration/reopen preserves existing roots, notes-folder settings, personas, native skills, and sessions. Public collaboration data/audits do not gain private bodies or host paths.

### Verification and validation

Verify through authenticated HTTP and real disposable persistence, plus focused in-memory parity tests. Include unauthorized actors, revocation before requests, foreign IDs, stale tokens, competing publishers, transaction failure rollback, reopen, and legacy migration. Validate this foundation as part of T3/T7; storage tests alone do not demonstrate the user's workflow.

### Existing evidence, gaps, and disposition

Implementation exists in private Relay storage and `packages/control/src/{configuration,contracts,client,server}.ts`. Relevant tests: `packages/control/test/authored-documents.test.ts` and `packages/relay-storage-drizzle/test/authored-documents.test.ts`, with existing storage regression evidence linked in the execution record. Independent verification is pending. Creation is not an idempotent-retry API; clients must not automatically repeat uncertain creates. No release acceptance claimed.

**Verifier return:** requirement-to-observation links, concrete defects or gaps, and separate verification/validation sufficiency conclusions.

---

## T2 — Apply standing instructions to sessions

Parent: [Workspace instructions and channel/workspace skills](/notes/note_01a1a10fd15c74febb29cbfd90ddd96e)

Depends on T1.

### Intent and scope

Supply published workspace/channel defaults once at session launch and retain the selected revisions through lifecycle operations. Cover prompt composition, scoped manifests, durable activation, thread/Fresh inheritance, and recovery. Exclude skill-procedure invocation and live mutation of existing sessions.

### Observable acceptance criteria

- A new session receives the exact published workspace and channel instruction revisions alongside its existing persona/harness guidance, not unpublished drafts or all playbook procedures.
- Channel defaults specialize workspace defaults without granting access or overriding platform/project constraints. Other channels/workspaces receive no foreign instructions.
- Threads use their parent channel's scope. Fresh sessions omit inherited chat background but still receive current published instructions.
- Retained Start, host restore, and recovery preserve the pinned manifest. Explicit New session selects current publications.
- Known-empty manifests differ from legacy sessions without evidence. Legacy recovery does not adopt newly published guidance or claim it was previously applied.
- Manifest history survives reopen and caller mutation cannot alter stored references. Missing, corrupt, ambiguous, or wrong-scope pinned content fails clearly rather than substituting latest.

### Verification and validation

Use deterministic Runtime receipts through the real host/service boundary, backed by persistence where recovery is involved. Verify initial launch, draft/publication changes, retained resume, host restart, recovery-created replacement, explicit Fresh/New session, legacy records, and missing/corrupt publications. A receipt establishes delivery, not model obedience; genuine-agent intended-use validation belongs in T7.

### Existing evidence, gaps, and disposition

Implemented in `packages/relay/src/authored-context.ts`, private activation history/migration `0016_authored_session_context`, and `packages/control/src/agent-host.ts`. Relevant tests: `packages/relay/test/authored-context.test.ts`, private-store authored-content tests, `packages/control/test/agent-lifecycle-diagnostics.test.ts`, and thread integration regression. Author checks passed; independent verification and intended-use acceptance are pending.

**Verifier return:** distinguish exact delivery/persistence observations from assumptions about agent behavior; identify any stale/latest substitution or scope leakage.

---

## T3 — Manage instructions and skills in Settings

Parent: [Workspace instructions and channel/workspace skills](/notes/note_01a1a10fd15c74febb29cbfd90ddd96e)

Depends on T1 and T2.

### Intent and scope

Let an owner/admin author and publish instructions/playbooks in Workspace/Channel Settings, inspect history, and understand saved versus launch-applied revisions. Exclude `/skills` invocation UI and new agent lifecycle controls.

### Observable acceptance criteria

- Settings expose Markdown editing/preview, separate Save draft and Publish, immutable revision history, and skill archive.
- Creating a skill in a channel defaults to channel scope; selecting workspace scope is explicit. Existing document scope cannot silently change.
- The effective view shows inherited published instructions and per-agent Not started / Not verified (legacy) / Applied / Pending / Unavailable state without claiming model obedience.
- Draft-only edits do not create a pending publication. Existing agent menus remain responsible for New session.
- A stale save preserves the local draft. Reviewing latest does not overwrite or write it; adopting the new concurrency token requires an explicit action.
- Older read responses cannot downgrade an acknowledged publication; newer responses do not overwrite dirty drafts.
- Access-denied management requests stop/hide private editor state without replaying writes. Queries are actor-scoped and private text is not persisted in localStorage.
- Existing settings/folder behavior remains usable on representative layouts. No explanatory UI microcopy is added.

### Verification and validation

Verify effective-context API authorization/status transitions and representative real browser flows. Include rapid create→publish, conflict review/rebase, revision history, scope, archive, access denial, and existing Settings regression. Use human assessment of Applied/Pending usability in T7 rather than equating browser checks with intended-use acceptance.

### Existing evidence, gaps, and disposition

Implemented in `packages/web/src/components/authored-content.tsx`, workspace/channel Settings integration, and the private effective-context API. `packages/web/test-browser/authored-content.spec.ts` passed 3 scenarios after accessible-name and stale-publication-display fixes; 4 existing sidebar/folder scenarios also passed. Exact commands/artifacts and limitations are in the execution record. Independent verification and stakeholder usability validation are pending.

**Verifier return:** confirm observable UI behavior, preservation of dirty drafts, honest state labels, and private-state handling; do not count unimplemented invocation as covered.

---

## T4 — Accept explicit skill invocations safely

Parent: [Workspace instructions and channel/workspace skills](/notes/note_01a1a10fd15c74febb29cbfd90ddd96e)

Depends on T1 and T2; coordinate the interface with T5/T6.

### Intent and scope

Define and implement authenticated structured acceptance of an explicitly selected skill for the human's existing effective recipients. Freeze accepted intent and make uncertain submission recoverable. Exclude procedure execution and UI polish.

### Observable acceptance criteria

- Resolve skill source/ID/revision, never display name alone. Validate active publication, workspace/channel access, author authority, recipient membership, and availability in each targeted session's pinned manifest.
- Preserve the human's effective recipients. No new recipients, all-agents fallback, silent omission, partial group acceptance, automatic replacement session, or undocumented native command fallback.
- Freeze source, ID/revision, arguments, actor, recipient set, and linkage to the accepted message/operation before delivery can race ahead of its private intent.
- An exact retry after uncertainty resolves the same accepted intent/message; changed payload with the same request identity conflicts instead of rebinding to latest.
- Invalid, inaccessible, archived-at-acceptance, or unavailable references fail clearly without accepting work or revealing private procedure bodies.
- Raw public message metadata or copied reference strings cannot authorize private procedure loading.

### Verification and validation

Plan black-box authenticated submission tests with real service/store boundaries, multiple recipients, duplicate names, stale session selection, foreign IDs, payload mismatch, access loss, uncertain acceptance, and crash/restart at the private/public linkage boundary. No claim of exactly-once external side effects follows merely from idempotent acceptance. Validate the user interaction through T6/T7.

### Existing evidence, gaps, and disposition

Private acceptance mechanics are implemented and author-checked; see the current checkpoint below. The owner has now confirmed member invocation authority; its implementation delta awaits independent review; delivery/composer exposure and intended-use validation are not implemented. Acceptance records one private operation and creates no public message/Runtime turn. This is not independently shippable or accepted.

**Verifier return:** review the oracle and negative/fault scenarios before automation; later assess actual acceptance and idempotency observations separately from T5 execution.

---

## T5 — Deliver and recover skill invocations

Parent: [Workspace instructions and channel/workspace skills](/notes/note_01a1a10fd15c74febb29cbfd90ddd96e)

Depends on T4. Owner message 63 confirms D4: block new/queued unstarted use after retirement, without session restart or interruption of active work.

### Intent and scope

Resolve the accepted immutable procedure privately and deliver it only to the intended addressed agent turns. Preserve intent through retry/recovery and honor current access restrictions. Exclude executable bundles, new permissions, or arbitrary native installation.

### Observable acceptance criteria

- Delivery uses the accepted source/ID/revision, arguments, and recipients; it cannot switch to latest or a same-named procedure.
- Load only the selected procedure into the intended request assembly, not the whole library into standing prompts. Private bodies do not enter public messages, SSE, exports, or public thread snapshots.
- Recovery/retry retains frozen intent and never silently creates a second invocation, changes recipients, or repeats an uncertain Runtime send outside the existing safe delivery policy.
- Current membership/access revocation blocks new delivery; it cannot erase content already supplied to a running turn.
- **Confirmed D4:** retirement after acceptance blocks queued-but-not-started delivery as unavailable; do not substitute/bare-text fallback, restart sessions, interrupt active turns or rewrite completed work/history.
- Unsupported native harness invocation is unavailable rather than emulated through undocumented raw slash strings or host paths.
- Delivery failures are visible and cannot silently fall back to executing only the ordinary message text. Existing queue/cursor safeguards remain intact.

### Verification and validation

Use accepted-intent and Runtime receipt assertions with real durable recovery boundaries. Cover archive/access changes before dispatch, in-progress turns, exact revisions after newer publication, interrupted/uncertain sends, pending work across restart, cursor advancement, and recipient isolation in parent/thread scopes. Validate a representative actual playbook workflow in T7.

### Existing evidence, gaps, and disposition

Gated backend implementation and independent checkpoints 10–15 cover guarded delivery, publication/receipts, orderly recovery and one real process-loss/expired-lease case. Independent checkpoint 17 closes G1: compilation and 1/1 inherited-channel/thread case pass with live parent/thread/observer controls and measured authored starts 1/0/0. Original V1/IDs/session mappings, privacy and cursors pass. T5 is Done for gated-backend engineering; all seven criteria are covered by the accepted map plus unchanged prior evidence. Subsequent coherent T6 and I1 programmatic startup wiring are independently accepted on `3edad72f…`; default-off production activation and T7/CI/release acceptance remain unapproved. No blanket crash-matrix requirement is added.

**Verifier return:** identify missing dispatch/recovery oracles and later demonstrate the agreed failure-path outcomes without claiming exactly-once external actions.

---

## T6 — Add the `/skills` composer experience

Parent: [Workspace instructions and channel/workspace skills](/notes/note_01a1a10fd15c74febb29cbfd90ddd96e)

Depends on the T4 contract and T5 safe delivery behavior.

**I1 wiring complete:** optional `authoredSkillPublicationEnabled` forwards product → daemon → existing gate; omitted/false stays off. Independent compilation + six integration/two startup regression cases pass on `3edad72f…`. This is controlled startup integration, not approval to activate a live installation. Catalog presence/publication observation is not delivery/completion. T7 validation/release remain separate.

### Intent and scope

Offer explicit skill discovery/selection in the composer without changing a human's recipient selection. Cover available/unavailable/pending states, stable identity, arguments, and submission state. Exclude global libraries, autonomous authored-skill activation, and enabling unsupported native invocation.

### Observable acceptance criteria

- `/skills` opens a searchable picker with Channel / Workspace / Harness provenance and visibly distinguishable duplicate names.
- Selection retains stable identity and a published revision. The picker does not infer invocation capability merely from catalog presence.
- Validate availability for the actual selected recipients; pending/unavailable revisions are not silently substituted and sessions are not replaced automatically.
- Human selections in each conversation/thread remain independent. Picking a procedure, its body, or generated reply text cannot activate other agents or add recipients.
- Structured invocation and arguments survive the existing safe submission/uncertainty flow without automatic duplicate writes.
- Existing ordinary messages, attachments, mentions, reply targeting, and native harness selection/autonomy are not regressed.
- Use concise labels/controls only; no new explanatory helper microcopy.

### Verification and validation

Use focused state/parser checks plus representative browser tests wired to the supported acceptance/delivery boundary. Assert actual deliveries, not only recipient-chip highlighting. Include same-name entries, recipient changes after selection, pending revisions, unsupported harness entries, parent/thread routing, and uncertain submission. Use owner feedback on deterministic invocation in T7.

### Existing evidence, gaps, and disposition

T6 Done for bounded engineering after independent coherent-flow/F5/F6 and I1 startup acceptance. Current `3edad72f…` target (55 paths): compilation + six integration/two startup regression cases pass separately; all prior 52 hashes unchanged. Prior UI types/9 skills-browser/3 recipient-browser/2 original probes and backend evidence reused, not rerun. Explicit true startup opt-in works through real composition; omitted/false remains disabled. Production activation, unsupported Harness invocation, T7/CI/genuine-agent/authorized Notes/usability and release gates remain unapproved. Canonical current summary is authoritative; earlier failures/pending states stay historical.

**Verifier return:** review interaction oracles and later distinguish picker presentation from server acceptance and actual addressed execution.

---

## T7 — Validate the assembled feature

Parent: [Workspace instructions and channel/workspace skills](/notes/note_01a1a10fd15c74febb29cbfd90ddd96e)

Depends on the assembled T1–T6 feature and an explicitly authorized validation environment.

### Intent and scope

Establish that the complete feature both meets its agreed requirements and solves the shared-default/reusable-procedure need. Separate verification, intended-use validation, independent recommendations, human acceptance, and release authority.

### Observable acceptance criteria

- Reconcile the parent, child criteria, and local BB01–BB12 scenarios; retain material unresolved decisions rather than silently selecting an oracle.
- Evaluate interactions and relevant regressions against a pinned integrated target, not only a collection of local slice passes. Meet required repository/CI gates.
- With a genuine agent and an explicitly authorized disposable Notes destination, publish a workspace base-folder instruction once and ask for a note without repeating the destination. Inspect the actual created note's parent and content, not just an agent's success statement.
- Exercise a permitted channel override and a thread; observe correct actual destination behavior. Denied creation must not produce an unauthorized note, silent fallback destination, or false success.
- Execute a representative explicitly invoked playbook and observe correct procedure/result/recipient behavior.
- Obtain human feedback on scope, publication, Applied/Pending/New session, and whether the workflow removes repeated prompting.
- Record verification and validation independently as sufficient / gaps remain / blocked. Material exceptions require an explicit appropriate decision-maker's acceptance.

### Verification and validation

Reuse applicable target-matched evidence; execute the missing integrated, failure-path, browser, and genuine-agent workflows. Preserve exact revision/build, environment, expectations, actual observations, artifacts, and limitations. Do not rerun full suites after every slice or claim an unperformed check passed.

### Existing evidence, gaps, and disposition

**Historical preparation evidence:** the initial A–C record contained 70 affected backend tests and 7 browser scenarios plus type checks, with T4–T6/D4 then open. Those engineering/policy items are now closed; retained counts are not current whole-feature verification.

**Current:** T1–T6 engineering Done; T7 In Progress. Local integrated evidence/test wiring and BB01–BB12 scope/gap reconciliation accepted; exact BB12 probe closed on pinned Runtime. The owner-approved genuine MCP workflow is now independently verified for actual note destinations/content: workspace F1, channel F2, thread F2 and explicit workspace-r1 playbook F2. Three exact titles match; N4 retains the period in approved arguments, contrary to the separate title list—minor test-input observation, not silently passed/repaired or a demonstrated code bug. Six-turn budget exhausted (2 preflights + 4 tasks); one override folder created, resources retained. Native read-before-create traces, returned note bodies/actual parents, accepted invocation/link/session identities and screenshots inspected. No additional genuine turns or broad suites rerun by verifier. Hosted CI/platform/package gates, excluded/Blocked denial criterion, owner UX/title acknowledgement and release/activation acceptance remain pending. No cleanup/deletion, permission/credential or production changes approved. Detailed independent `t7-live-independent-*` evidence is in the enclosing review artifact directory; authoritative current summary: `docs/verification/workspace-instructions-and-skills.md`.

**Verifier return:** separate verification/validation sufficiency recommendations, concrete unmet expectations, unrun/blocked checks, and residual risks. The human owns final acceptance of material exceptions and release decisions.

---

## Initial verifier handoff — historical preparation

**Intended recipient:** @verifier, identity `identity_e6792a2e9abb44b1937848dbb4b659e1`.

**Delivery state:** the handoff is saved on the parent note and ready for the named verifier. No separate participant dispatch was sent; no registered participant-routing tool was found. A mention in an assistant reply does not activate this participant; do not substitute a differently identified delegated-review session.

**Requested work:**

1. Review the T1–T7 breakdown for clear intent/scope, observable criteria, dependencies, missing or contradictory oracles, and proportionate LEVVS methods. Return only concrete defects/gaps or required decisions, not extra process for its own sake.
2. Independently assess T1–T3 against the actual isolated working tree and existing author evidence. Pin the source target first; preserve all changes and make no source edits, commits, pushes, deployments, or live Notes mutations.
3. At this preparation checkpoint T4–T6 were planned work only. The current checkpoint below supersedes that state for T4; actor policy and D4 still require owner decisions.
4. Treat T7 as an assurance plan, not completed validation. Request explicit disposable-environment authorization before any genuine Notes creation; do not silently select production destinations.
5. Return per-ticket verification and validation conclusions, exact checks/observations, evidence references, limitations, and one recommended next action to the owner/coworker in this conversation.

**Not claimed at the initial preparation checkpoint:** a separately dispatched/activated verifier turn, T3 read-back completion, independently queried incoming-backlink display, independent verification, completed invocation, full CI, or release acceptance. The subsequent user-addressed verifier report and T3 read-back are recorded in the canonical execution record; this does not claim a routing tool was used.

## Current checkpoint — T4 mechanics and F1/F2 corrections

T1–T3 are Done after independent ticket-level closeout; F1/F2 remain closed. Owner message 63 settles invocation/discovery roles and D4. T4's member-use delta independently passed and T4 is Done. T5 is In Progress with a private preparation boundary ready for review; public-message/Runtime linkage and dispatch remain next. T6/T7 remain Backlog. Previous passes stay attached to their reviewed targets. T7 validation is not complete.

Current source/test target: `0e49e4de8539ae50564fe9c6ded4bb653af4f80adf537ce0d4c333ec811556dd` across 28 changed source/test/migration files, same branch/base/worktree above. Author checks: compilation, **14 new preparation tests + 15 adjacent regressions passed**. Exact commands and explicit limits are in the canonical execution record; raw log/file list are `artifacts/workspace-instructions-skills-author-20261104/chunk-07-t5-private-preparation.log` and `chunk-07-t5-preparation-target.json` in the enclosing workspace. The older 88+5 integration results remain historical evidence on `5a4328e0…`, not current/full-suite verification of this new preparation code.

T4 records immutable private acceptance, not a public message or Runtime turn. Exact retries resolve actor-scoped receipts; changed payload conflicts; scope/recipient/session/archive/commit and uncertainty/persistence cases are covered. T5 must still safely link/deliver accepted work and enforce Stop/access/lifecycle/archive policy before a composer/dispatcher is enabled.

F1/F2 are independently closed on `5a4328e0…`, and the verifier completed T2/T3 ticket-level acceptance with their original T7 validation deferral intact. Historical rework/checkpoint verdicts remain attached to their identified targets; neither defect is reopened here.

**Confirmed owner choices (message 63):** active human members with existing Conversation access may discover/invoke published skills. Retirement blocks new/waiting uses without restarting sessions or interrupting active/completed work. Draft/edit/publish authority and the separate New session rule for newly published content are unchanged in this use-only chunk.

T2/T3/T4 and the parent were updated through registered MinuNotes MCP with fresh content hashes/revisions; Type Task was retained. T3 read-back is resolved. Source work is frozen for the next `@verifier` handoff here; no recipient-routing call, live Notes validation, commit, push, deployment or release approval is claimed.

## Smaller execution checkpoints

Use the existing seven tickets; do not create another ticket hierarchy. Finish one bounded checkpoint, record focused evidence, and hand off before starting another. Existing saved code may need verification rather than reimplementation. Keep review-target source stable; each checkpoint is not independent release approval.

| Order | Ticket / checkpoint | Exit evidence |
| --- | --- | --- |
| Foundation closeout — Done | T1: management/storage ticket | Independently closed after 9 focused checks and compilation on its pinned target; original T7 validation deferral preserved. |
| 1 — Done | T2 / F1: corrupt-manifest recovery | F1 closed and T2 engineering ticket independently accepted; original T7 validation deferral preserved. |
| 2 — Done | T3 / F2: truthful applied status | F2 closed and T3 engineering ticket independently accepted using current API and unchanged-UI evidence. |
| 3 — independent mechanics PASS | T4a: identity, scope and recipients | 7 focused checks plus compilation independently passed. The owner subsequently confirmed member use; its new authorization delta is In Review; no delivery/composer exposure. |
| 4 — independent mechanics PASS | T4b: immutable acceptance and receipts | 9 focused checks plus compilation independently passed. The owner subsequently resolved both policies; T4 member-use alignment now awaits review before the next T5 chunk. No dispatcher is enabled. |
| 5a — independent bounded PASS | T5: private per-recipient preparation | 14 tests + compilation independently passed on `0e49e4de…`. Preparation alone is not a message link or send grant. |
| 5b — independent bounded PASS | T5: internal linkage and guarded Runtime delivery | F3/F4 closed on `3546a429…`: compilation, 41 focused tests and all 3 probes passed independently. Public producer/full host recovery remain unwired. |
| 5b follow-up — independent bounded PASS | T5: read-only publication uncertainty | `dc20938f…`: compilation + 50 tests passed independently. Original associations/current access preserved; observations never grant sends/retries. |
| 5c — independent bounded PASS | T5: authenticated read-only status wiring | `20014cb4…`: compilation and all 23 HTTP cases passed independently. GET remains read-only and actor scoped. |
| 5d — independent bounded PASS | T5: explicit authenticated publishing | `c89af975…`: compilation + all 89 tests passed independently in one run; original intent/association and wire-key/session fences verified. Default-off gate remains. |
| 5e — independent bounded PASS | T5: orderly host/service restart | `d93745f7…`: compilation and 9/9 orderly real-service/SQLite close/reopen cases passed independently with retained simulated Runtime. Not process-crash/provider recovery approval. |
| 5f — independent bounded PASS | T5: unclean death / expired lease | `3bcbf49c…`: compilation and 1/1 real host-child SIGKILL/clock-selected takeover case passed independently; zero duplicate starts/replies or blind publication. No production changes/enablement. |
| 5g — map accepted independently | T5: criteria/evidence/gap assessment | `3bcbf49c…`: G1 is the sole identified verification blocker; one real authenticated thread-invocation/isolation case confirmed as sufficient scope. I1 stays a separate T6/integration dependency. |
| 5h — independent PASS / G1 closed | T5: thread-authored delivery | `e8df4368…`: compilation + 1/1 case independently pass; live parent/thread Relays and observer liveness controls, measured authored selected/parent/observer=1/0/0, original V1/IDs/session mappings/privacy/cursors. All 42 previous files unchanged. |
| 5i — Done, gated backend only | T5: seven-criterion engineering closeout | Independent checkpoint 17 accepts original map plus G1 evidence. T5 marked Done; I1 activation explicitly transferred to T6/integration. T7/CI/release unwaived; producer default-off/composer disabled. |
| 6 — gated backend covered | T5b: submission/admission and revocation | Authenticated opt-in publication, current-access/retirement admission and uncertainty checks covered by checkpoints 10–13. Subsequent I1 startup integration is independently accepted under T6; actual production activation remains off/unapproved. |
| 7 — bounded recovery covered | T5c: retry/recovery | Checkpoints 14–15 preserve accepted intent/original IDs through orderly restart and one isolated process loss; daemon/provider and broader crash limitations remain explicit, not stronger guarantees. |
| 8a — independent catalog PASS | T6a: member-safe published authored metadata | `f525de02…`: compilation, 13 catalog cases + four adjacent regressions independently pass in two runs. Published metadata/provenance/thread/access/privacy/no-effect boundary accepted; T6 In Progress. Picker/Harness/availability/submission/I1 pending. |
| 8b — corrected gated-flow PASS | T6a: picker/selection | F5 closed on `1c4e7e19…`: slash/button entry and reload preserve both human-chosen recipients; both receive one turn/reply. Unsupported Harness disabled. |
| 9 — Done, controlled startup integration | T6: coherent flow and I1 | `3edad72f…`: fresh compilation + six integration/two startup regression cases independently pass separately. Prior corrected UI evidence reused; F5/F6 closed. T6 engineering Done; production default-off/activation unapproved. |
| 10 | T7: integrated verification, then intended-use validation | Separate technical results from authorized genuine-agent/MinuNotes and owner acceptance. |

**Checkpoint 1 result:** the failed turn's F1 correction was already saved. No source change was needed. Backend compilation and four focused recovery regressions passed freshly on `5a4328e0f61b129f362db693c68b9d60e690822c2689b4f885f678f9fcb32e1f`; the subsequent independent re-review passed and closed F1, with 6 focused checks. Subsequent independent ticket-level closeout completed; T2/T3 are Done for engineering scope, with original T7 validation still pending. Log: `artifacts/workspace-instructions-skills-author-20261104/chunk-01-t2-recovery.log` in the enclosing workspace. T3/T4 source remains unchanged; do not treat this checkpoint as their verification or acceptance.
