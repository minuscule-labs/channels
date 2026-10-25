# Advanced message-delivery diagnostics

**Status:** Implemented locally on `feat/message-delivery-diagnostics`; not merged or released. The user approved advanced-diagnostics-only presentation and the retention defaults below. This is a follow-up to the shipped [recent Runtime events](agent-diagnostics-recent-logs.md), not unfinished v0.0.15 work.

## Agreed scope

Help an authorized advanced user follow one public Conversation message through Channels/Relay and distinguish execution from response delivery. Keep the experience inside existing **Details & diagnostics** modal/screens, progressively disclosed and read-only.

- No new chat notices, normal participant badges, everyday progress indicators or permanent controls. Existing notices are unchanged.
- Preserve existing active-human, active Workspace owner/admin and Conversation-participation authorization. The request does not broaden diagnostic access to normal members.
- Reuse available evidence. Add only small, fixed-field observations where the audit establishes a gap; no message bodies, prompts, responses, tool details, raw errors or arbitrary text.
- Retain up to **seven days or the latest 1,000 completed message trails installation-wide**, whichever limit is reached first. Give trails their own retention/capacity accounting so ordinary messages do not evict lifecycle history.
- A handful of normal milestones, not continuous output or per-poll logging. Reads cannot wake, resume, retry, recover or otherwise mutate a session.
- Do not start real agents, restart existing services or touch real databases. Fake runtimes, isolated servers and temporary stores are permitted; real-Pi acceptance remains separately gated.
- Preserve unrelated `docs/image-support.md` and the existing no-explanatory-UI-microcopy rule.

## Audited target

Channels `d132f2e04d282b2ddbee955589c6825ead232a50` (published v0.0.15), Runtime pin `e92176054206d70e120d4b6641bda2a3d037eb84`. Runtime is unchanged. Work is on normal Channels branch `feat/message-delivery-diagnostics`, based on verified merged main; no worktree is needed.

Audit used source reads only: no user log, transcript, registry, database or live-agent inspection.

## Evidence we already have

| Existing source | What it proves | What it does not prove |
| --- | --- | --- |
| Public Conversation messages and sequences | A message was persisted and has authorized public attribution/recipients. | Relay observed it, admitted it, or supplied it to Runtime. Do not duplicate its body in diagnostics. |
| Relay queue/activity snapshots | Current aggregate queue coverage and the active trigger/phase where known. | Durable per-message queue position/history. A partial queue is not zero; a stopped/detached Relay may not have observed a message at all. |
| Lifecycle operation journal | Scoped Start/Stop/replacement milestones, exact targeted-trigger links when captured, and uncertain outcomes. | An automatic trail for every successful normal turn. Its 1,000-operation retention pool must remain separate. |
| Private turn-failure records | Failure classification, trigger correlation, attempt count and delivered/dead-letter outcome. | Successful normal-turn history or missing earlier steps. Reuse these facts rather than record raw exceptions again. |
| Runtime recent bridge events | Bounded current-worker admission/dispatch/control observations. | Per-message public correlation: identifiers are deliberately removed. Do not join these by nearest timestamps or ask Runtime for raw events/transcripts. |
| Recoverable Runtime turn API | `handle` can look up/reuse the deterministic exact turn, observe acceptance and wait for its actual result. | A read-time diagnostic inspector must not call the execution/recovery APIs to reconstruct old work. Capture small observations at the existing execution boundary instead. |
| `postResponse` result | Acknowledgment that the public response/cursor transaction committed. `created: false` means the idempotent response already existed. | A prior dispatch acknowledgment is not delivery, and failure to receive an acknowledgment is not proof that nothing committed. Record reused delivery distinctly. |
| Private Relay cursor | Recovery progress; it can advance for skips, Stop, roster removal or dead-letter outcomes. | Successful Runtime execution or a published assistant reply. Never infer either merely from `cursor >= triggerSequence`. |

### Inspected implementation points

- `packages/relay/src/relay.ts`: `drainState`, `runTurn`, `handleWithRetry`, `handle`, `commitResponse`, `commitDeliveryDeadLetter`, `persistCommittedResponseCursor`, `completeCancellation`, `clearActive`.
- `packages/control/src/agent-host.ts`: per-binding restoration/lease ownership and Relay construction.
- `packages/relay/src/diagnostics.ts`: private correlation/public projection contracts and existing bounded lifecycle observer.
- `packages/control/src/{diagnostics-recorder,diagnostics-worker,lifecycle-diagnostics,daemon}.ts`: synchronous best-effort producer, bounded write/read worker protocol, optional journal lifecycle and shutdown.
- `packages/relay-storage-drizzle/src/diagnostics.ts`: private independent journal schema, exact-scope reads, restart reconciliation, read expiry and physical pruning.
- `packages/control/src/{agent-diagnostic-reads,agent-session-inspection}.ts`: authorization, exact current-resource fencing and projection patterns.
- `packages/core/src/client.ts`: public response write and bounded message reads; no existing read-only exact response-by-trigger diagnostic lookup.

## Implemented slice

### Capture the missing observations, not another log stream

The existing data cannot safely reconstruct the successful path after the fact. The implementation adds an optional, non-throwing Relay observer at existing boundaries. Give it only explicit scope/correlation fields and fixed stages, never a raw message/error/Runtime object. Do not change execution ordering or add storage awaits, lifecycle locks, retry policy or recovery work.

A normal observed path would contain roughly these milestones:

1. **Eligible message observed** — Relay fetched and selected an eligible trigger; not a claim that every posted message was seen.
2. **Processing started** — Channels began handling that trigger; not yet Runtime dispatch.
3. **Dispatch requested** or **existing Runtime turn observed** — distinguish a new request from recovery/reuse.
4. **Runtime acceptance observed**, where the adapter actually supplies that evidence; legacy send remains field-specifically unverified.
5. **Runtime result observed** — distinguish completed, failed and interrupted; no response content.
6. **Response delivery requested** — distinguish assistant reply, failure notice and cancellation notice by fixed enum only.
7. **Public response commit acknowledged** or **existing public response acknowledged** — only after `postResponse` returns successfully.
8. **Private recovery cursor committed**, or an explicit cursor/dead-letter uncertainty/failure.

Cancellation, fencing, missing/sleeping workers, response-delivery retries, lost acknowledgments and recorder loss must not be collapsed into a generic success. A handler returning, Runtime finishing and public response delivery are separate facts. Closing a trail as unknown is not a failed or completed authoritative turn.

Do not log each Runtime poll or repeat every delivery-retry message. Coalesce bounded retry counts/stages and disclose clipping. Keep one observer for a trigger across deferred-wake/handling retries; do not create a new trail for every poll or retry.

### Retention and failure isolation

Implemented technical bounds alongside the approved seven-day/1,000-completed-trail policy:

- The **optional private diagnostic journal** upgrades its independent schema from v1 to v2, adding an indexed `delivery_trails` collection and separate gap metadata/retention. Existing lifecycle rows survive the upgrade; older application versions cannot open the newer optional journal schema. No public or authoritative Relay database migration is added. Do not add authoritative Relay/public-schema writes or reuse the lifecycle retention pool.
- Reuse the existing background diagnostic worker rather than add another process or persistent stream. Bound and prioritize lifecycle work so normal message traffic cannot exhaust its reserved recording capacity.
- Cap active/awaiting-write trail snapshots independently at 128, each at 16 observations / 8 KiB, with room reserved for a final outcome and explicit gap/clipping indicators. Reject/drop optional capture under pressure without affecting processing.
- Terminal retention starts at observation closure. Active records are separately bounded, not unlimited; on observer restart, close abandoned records as **unknown**, never infer delivery or execute recovery to fill a gap.
- Expired records must disappear from reads immediately. Prune terminal rows with bounded background/write-time cleanup. Logical expiry/deletion is not a secure-erasure promise for SQLite pages, WAL or backups; do not promise exact filesystem shrinkage.
- Reopening, schema upgrades, worker failure and shutdown must preserve existing lifecycle observations and remain optional/bounded. Inspect actual helper side effects and test the journal upgrade before enabling capture.

### Exact correlation and read API

Persist private immutable ownership/correlation for the Workspace, Conversation, participant, binding ID/generation, adapter, managed session/owner and exact trigger ID/public sequence. A trail ID is correlation, not authority. No timestamp matching or borrowing evidence from a replacement generation.

`GET /local/conversations/:conversationId/agents/:identityId/delivery-trails` provides a bounded list and optional selected detail (`cursor`, `trailId` only), scoped to the selected current owned binding/activation. Capture/revalidate that identity around all reads, authorize after evidence I/O and validate the same browser session immediately before delivery. Unsupported/legacy/ambiguous selections and missing evidence are explicit. Keep native/private correlation fields off the wire.

Project only the public trigger sequence, opaque diagnostic selection ID, fixed milestones/outcomes, times, bounded retry counts and coverage. List pages are bounded to 50, with a 32-KiB complete response, two-second evidence-read deadline, one physical read per selected resource and at most 16 per read service; slots remain occupied until underlying work settles. Authorization is refreshed after content I/O, followed by the final private identity fence and browser-session validation. The shared local-control protocol is now **22**. Do not add trail data to clipboard/report exports in this slice.

### Advanced UI only

Inside existing owner/admin **Details & diagnostics**, add a collapsed **Message delivery** section with explicit Show/Refresh and a bounded list of recorded triggers. Selecting a trigger shows its observed milestones and missing/unknown coverage. Only link public sequences already loaded and authorized; no message bodies or new public timeline decorations.

Use disposable human/Workspace/Conversation/participant ownership. Clear and abort/fence on close, navigation, observed role/session loss and replacement. No private Query/browser-storage/cross-tab cache, polling or background stream. Keep labels concise, with no explanatory helper paragraphs.

### Deliberate limits

This first slice records **observed eligible turns**, not every posted message. Messages posted while Relay is detached/paused may have no trail until actually observed later; show **Not recorded**, not a guessed waiting reason. Existing current stopped/queue state can remain a separate observation. Complete backlog capture would be additional scope, not a hidden prerequisite or inferred history.

Do not retroactively claim history for messages processed before capture exists. Do not read saved transcripts or call live Runtime execution/recovery APIs to make the history appear complete. No Runtime dependency change is currently needed: the execution boundary already supplies the necessary observations privately within Relay.

## Verification and delivery

1. Freeze the fixed-field trail contract and add producer/parser tests, especially privacy canaries and event/byte/count bounds.
2. Add independent journal retention/indexing, upgrade/reopen/restart tests and recorder/worker failure isolation. Demonstrate that high message volume cannot evict or starve lifecycle observations.
3. Instrument Relay with deterministic fake runtimes: new/recovered/legacy turns; retries; stop/cancel/fencing; late acknowledgment; committed response with private cursor failure; terminal notice/dead letter; shutdown/observer loss. Reuse authoritative correlation/outcomes instead of introducing alternate control logic.
4. Add scoped API/disposable advanced UI with revocation/replacement/cancellation tests, member denial, archived/read-only access and loaded public-sequence navigation. No everyday UI changes or report additions.
5. Run focused checks while building, then relevant full backend/web/browser/package checks once against the integrated target. Use ordinary integration code review; do not invoke delegated review without a new explicit request. No real-agent acceptance without scoped approval.

## Author verification checkpoint

Target: working changes from Channels `d132f2e04d282b2ddbee955589c6825ead232a50`; Runtime pin and all existing installations are unchanged. Capture runs during normal eligible-turn handling, independently of whether the diagnostics modal is open; inspection itself is manual/read-only and starts no stream.

- Build/type checks and **282 backend/storage tests** pass, including actual host restoration → Relay → the existing journal worker with a deterministic managed fake Runtime, and actual Channels HTTP/browser authorization with temporary stores. An additional actual-daemon integration test passes through real temporary Relay SQLite, the native journal worker and authenticated HTTP without a real harness.
- **157 web unit tests**, web type checking and the production web build pass. The build retains its existing non-fatal chunk-size advisory.
- Full Chromium regression: **111 passed**. Tests cover advanced-only desktop/mobile/keyboard access, explicit reads/pagination, close/navigation/denial/replacement clearing, member query suppression and absence of trail content from reports. A subsequent small reused-response labeling correction is covered by focused backend and rendering tests; full PR CI remains a separate gate.
- Storage tests prove separate 1,000-record pools, immediate read expiry, active capacity, restart reconciliation within the completed cap, exact immutable scope, owner-private storage and preservation of lifecycle rows through the v1 → v2 companion-journal upgrade. Recorder tests prove lifecycle write priority, separate capture capacity, coalescing/clipping and physical worker shutdown.
- Author integration review corrected a semantic ambiguity: `created: false` acknowledges an **existing response**, not necessarily the kind of notice/reply just attempted. Reused responses therefore get a distinct terminal outcome/label and no inferred response-kind field. Cursor-finalization uncertainty remains separate from confirmed public response persistence. This is author review, not independent review or release approval.
- During focused verification, a synthetic clipping test initially exercised coalescing rather than overflow, and a lifecycle test fixture had an invalid zero sequence; fixtures were corrected. A parallel web type check also raced generated Relay declarations during a backend build; the sequential post-build check passed without source changes. Earlier failures are not hidden.
- Clean temporary clones of implementation/packaging target `7e209a76a3ceac34d5b2f771b9a45c8a962f7727` and the unchanged Runtime pin passed frozen installs, `pnpm release:pack` and `pnpm release:smoke` without a dirty-build override. The existing package smoke now also writes/reads a delivery trail through the actual bundled journal Worker and checks that private fields are absent from its projection. Four message-trail browser cases passed against the final production-built preview.
- The actual-daemon test initially expected HTTP 200 for Start; the established endpoint correctly returns 201, and the fixture was corrected. No production change was needed.
- [Structured author evidence](verification/message-delivery-diagnostics-author.json) distinguishes these checks from independent review and the still-separate PR CI gate. No new genuine-Pi test or production service/database operation is authorized by this work.
