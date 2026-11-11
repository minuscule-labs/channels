# Changelog

## Unreleased

## 0.0.34

Release overview: [Simpler Settings and Workspace-authored guidance](docs/releases/v0.0.34.md).

- Standardize desktop/mobile Workspace Settings navigation and move Agents, Instructions, Skills and Presets into dedicated content pages. Use compact Agents/Skills tables and separate Skill editors; hide People navigation without changing authorization.
- Save Instructions and Skills atomically with immutable internal snapshots, Preview, revision-checked conflicts and archive behavior. Recheck owner/admin authority after private reads, before writes and before returning private results.
- Keep Instructions/Skills authoring in Workspace Settings. Limit Conversation settings to name, normal participants and working folders; preserve legacy channel-authored guidance, saved non-timeout advanced settings and existing session behavior. Preset instructions remain copied at creation, not live-linked.
- Simplify reusable Presets to name, participants and instructions, with confirmed revision-checked removal. Migration `0022_minimal_presets` removes obsolete model/effort/timeout overrides, participant roles and unassigned role slots from saved presets without rewriting existing Conversation snapshots/settings.
- Remove per-Conversation timeout overrides through migration `0023_workspace_only_timeouts`, fencing stale edits while preserving immutable snapshots and explicitly saved Workspace policies. Offer Workspace turn limits of 30 minutes, 1 hour and 2 hours, defaulting to 1 hour; keep idle sleep and shorter internal safety waits separate.
- Add private authored documents, session manifests, pinned invocation/link records and the nullable public invocation correlation field through Relay migrations `0018`–`0021` and Core migration `0012`. Procedure bodies remain private; existing messages and IDs are preserved.
- Add the explicit `/skills` catalog/picker and guarded invocation infrastructure without enabling production publication. Supported sessions lacking a selected publication report Pending; a new session captures current publications, while reconnect/resume retains existing pins. Unsupported Harness invocation remains disabled.
- Keep local-control protocol v25, the existing Runtime pin and the single-user, loopback-only deployment model. Retain the known Runtime recovery/native-library caveats; exact-artifact clean-account/reopen/genuine-Pi acceptance and required CI remain release gates.

## 0.0.33

Release overview: [Bounded connection cleanup and content-page settings](docs/releases/v0.0.33.md).

- Release production-proxy connections when browser consumers disconnect, propagate premature upstream failure, and dispose of fully parsed but unread responses without breaking normal HTTP completion or socket reuse.
- Make both SSE routes release subscriptions and heartbeat timers across disconnect, asynchronous setup, response failure, and shutdown. Add real-HTTP regressions, including 100 disconnect cycles per route and backpressure cancellation.
- Handle deferred libSQL cleanup unlinking an optional diagnostic sidecar between open and descriptor validation. Accept only a genuinely absent private sidecar while retaining file-safety checks and rejecting replacements or an unlinked main database.
- Isolate optional diagnostic I/O in a child process so forced timeout/shutdown during native libSQL execution cannot abort the Channels host. Preserve bounded shutdown, journal formats, private projections and existing recovery coverage. This contains the reproduced worker-termination abort, not every possible native-library or Runtime failure.
- Move Workspace and Conversation settings, people/permissions, and preset editing into content pages. Persist current Conversation roles, model/effort overrides, guidance, and timeouts separately from immutable creation snapshots; validate and prepare creation working folders before publication.
- Generate new typed resource IDs with UUIDv7 while preserving the existing prefixed 32-hex shape and acceptance of existing IDs. Add the core `uuid` dependency; message sequences remain authoritative and UUID timestamps are public.
- Add private Relay migrations `0016_conversation_settings` and `0017_creation_folder_preparation`; advance local-control protocol to v25. Keep the public database schema and Runtime pin `f0ffbfcc5f24e75174bff1919aa5cd41ce22d732` unchanged from v0.0.32.
- Skip runner jobs for draft PRs and use bundled Playwright browsers in CI; ready-for-review PRs, main commits, and releases retain their verification gates.
- Retain the known Runtime resume/PID-publication and recovery/context-reconstruction limitations. Other native Neon abort mechanisms have not been ruled out; historical ENOBUFS causality and the 24–48-hour connection soak remain unverified.

## 0.0.32

Release overview: [Conversation folders and consistent action controls](docs/releases/v0.0.32.md).

- Add flat Workspace folders with create/rename, optional creation-time filing, Move/unfile, empty/Unfiled groups, remembered collapse preferences and collapsed unread/mention totals.
- Keep folder organization separate from permissions, agent context, private Presets, source/working scopes, lifecycle and thread/session identity. Fence stale background metadata responses without reopening stable subscriptions.
- Use compact folder navigation, quick-create plus vertical popup actions, matching text sizes and aligned borderless action controls. Highlight the active Conversation rather than its folder; keep the existing Workspace selector.
- Add public migration `0011_conversation_folders`; existing Conversations become Unfiled without rewriting messages or bindings. Keep the private Relay schema, local-control protocol v24, Runtime `f0ffbfcc5f24e75174bff1919aa5cd41ce22d732` and dependencies unchanged from v0.0.31.
- Retain the known Runtime resume/PID-publication race, recovery/context-reconstruction and intermittent native Neon database-abort limitations. This release does not claim to fix them or introduce shadcn/ui.

## 0.0.31

Release overview: [Reusable Conversation presets](docs/releases/v0.0.31.md).

- Add editable Workspace presets and Exploration, Feature delivery, and Incident/debug starting points. Assign existing agents to roles, review optional Conversation model/effort defaults and guidance, then create explicitly.
- Save independent creation snapshots so later preset edits or deletion do not change existing Conversations. Apply settings to initial and replacement sessions, including threads, without modifying Workspace agent configuration.
- Recover exact preset-save and Conversation-create retries, reject stale edits, and isolate late editor responses from the currently selected draft.
- Add private Relay migration `0015_conversation_presets` for presets and creation snapshots. Keep the public Conversation schema, local-control protocol v24, Runtime `f0ffbfcc5f24e75174bff1919aa5cd41ce22d732`, and dependencies unchanged from v0.0.30.
- Retain the documented recovery/context-reconstruction and intermittent native Neon database-abort limitations. Disabled-model readiness for existing agents remains separate lifecycle work.

## 0.0.30

Release overview: [Restore mention-based agent handoffs](docs/releases/v0.0.30.md).

- Restore intentional agent-response mentions as handoffs to eligible existing sessions in the same conversation or thread. No new messaging tool is required.
- Keep each human's browser-local sticky recipient independent: incoming agent handoffs and replies never change the destination of that human's follow-ups.
- Preserve recipient wake policies, permissions, archive/retirement fences and explicit Stop. Agent handoffs do not start unbound agents or resume stopped ones; unaddressed agent replies do not wake peers, including under `all_messages`.
- Keep supplied API `to` authoritative, including `[]`; exclude code, quotations and escaped mentions from implicit routing.
- Keep Runtime `f0ffbfcc5f24e75174bff1919aa5cd41ce22d732`, protocol v24, dependencies and database schemas unchanged from v0.0.29. Existing recovery/context-reconstruction and native Neon database-abort limitations remain.

## 0.0.29

Release overview: [Simpler composer and thread-only message menus](docs/releases/v0.0.29.md).

- Remove the composer recipient dropdown without a replacement indicator or helper text. Keep attachment on the left and Send on the right in main conversations and threads.
- Remove the separate Reply action. Message popups offer only Start/Open thread; thread messages no longer show an otherwise empty actions menu.
- Keep intentional mention selection, per-human/conversation sticky follow-ups, thread defaults and Send-triggered activation. Preserve saved retry metadata, backend reply support, permissions and independent thread sessions/frozen context.
- Keep Runtime `f0ffbfcc5f24e75174bff1919aa5cd41ce22d732`, protocol v24, dependencies and database schemas unchanged from v0.0.28. Browser-login/dev-instance isolation improvements and CI/CD changes remain separate work.
- Retain the recovery/context-reconstruction and intermittent native Neon database-abort limitations disclosed in v0.0.28; this UI patch does not claim to fix them.

## 0.0.28

Release overview: [Agent recovery without installation-wide transcript scans](docs/releases/v0.0.28.md).

- Recover and inspect exact owner-scoped sessions without scanning every saved transcript. Bound full-transcript validation to four readers per Runtime module and one per path, cancel queued/active read work safely, and keep guards occupied until physical settlement.
- Make explicit Restart resume the same transcript first, then permit controlled replacement in the same Conversation only after confirmed shutdown. Retain original transcripts/history and bounded public context; ordinary Start and background recovery never automatically replace existing sessions.
- Reserve recovery with a separate durable lease, reject competing lifecycle actions, and atomically commit replacement generation/history with its no-replay cursor boundary so cleanup failures cannot replay captured commands.
- Carry forward the emergency recovery build's cancellation and exact-manifest-version package verification. Document the manual, checksum-verified upgrade path from `0.0.27-recovery.0` without resetting product data or Runtime resume material.
- Pin Runtime `f0ffbfcc5f24e75174bff1919aa5cd41ce22d732`. Keep local-control protocol v24, dependencies and database schemas unchanged.
- Accept imperfect context reconstruction for now: repeated fallback replacements of a Fresh session can narrow recovered public context while the Conversation and retained transcripts remain intact. Do not claim a fix for the previously disclosed intermittent native Neon database abort.

## 0.0.27

Release overview: [Select once and start agents on Send](docs/releases/v0.0.27.md).

- Unify per-person, browser-local recipient selection across main conversations and threads, with a visible recipient control, intentional mention switching, Reply and sticky follow-ups. Incoming messages and generated replies cannot redirect selection.
- Start eligible never-bound addressed agents on Send, including later Sends and explicit multiple recipients. Preserve saved questions, retry identity, pending work, permissions, archive restrictions and explicit Stop; never implicitly resume or replace an existing binding.
- Keep broadcasts and multiple-recipient overrides message-only without replacing the sticky selection. Broadcasts do not start idle or resume stopped agents; unclear recipients do not start the roster.
- Add the borderless message-actions menu with separate Reply and Start/Open thread actions, and remember open threads per person/channel. Opening, restoring and drafting start nobody; thread sessions and frozen context remain separate.
- Fix manual-Start/Send ordering, omitted-recipient retry inference and retained Reply intents crossing authenticated identity changes, while preserving cancellation and retirement fences.
- Make supplied API `to` authoritative, including an empty list, rather than unioning body mentions. Generated agent text is not a routing command, and unaddressed messages no longer implicitly wake a sole agent. SDK clients should submit their effective targets explicitly; see the release overview.
- Keep protocol v24, Runtime `86bd35ea846740f55e83038b3ff823d9ddd67e34`, dependencies and database schemas unchanged from v0.0.26. Presets, Copy/link actions and automatic history synchronization remain outside this release.
- Retain the previously disclosed intermittent native Neon database-abort limitation; this release does not claim to fix it or waive required CI and artifact-acceptance gates.

## 0.0.26

Release overview: [Conversation threads with isolated agent sessions](docs/releases/v0.0.26.md).

- Add one durable side-panel thread per top-level message, live reply counts and thread-local message streams, drafts and retry keys.
- Give each agent a separate thread session seeded once with bounded public parent context through first thread creation, always retaining the root. Keep the snapshot frozen across reopen, delayed startup and restart; never clone private Runtime history or automatically sync later messages.
- Inherit current parent participants, lifecycle and working folders. Keep thread Start, Stop and session controls scoped while preserving parent permissions and archive safeguards.
- Fence retired thread work across recovery, cancellation and delayed delivery, including authoritative rejection of new obsolete responses while allowing already-committed responses to be retried.
- Return results to main manually: ask for a summary, copy it and post a new message. Copy-message, Share-to-conversation and reusable presets are not included.
- Add public Conversation migration 0010 for thread relationships and frozen context. Keep local-control protocol v24, the existing Runtime pin and dependencies unchanged. Back up the complete stopped data directory before upgrading; downgrading migrated data is unsupported.

## 0.0.25

Release overview: [Durable Pi sessions without destructive recovery fallbacks](docs/releases/v0.0.25.md).

- Fix resume rejection of valid native Pi journals containing context edits, usage records or additional tree roots. Remove stale entry/role allowlists while retaining ownership, private-file, identity, bounded-read and ancestry checks.
- Remove automatic replacement when an existing session cannot be resumed. Preserve managed identity, binding generation, context policy and pending-message cursor rather than silently starting over.
- Retire and suspend replaced sessions without discarding their resume manifests. Convert older queued automatic-destroy cleanup intents to non-destructive suspend attempts and retain visible failures instead of claiming successful cleanup of missing sessions.
- Record safe, bounded resume-failure reasons and stop recommending replacement as the ordinary recovery action. Keep worker-exit confirmation, delivery fencing and explicit-stop resume protection.
- Pin Runtime `86bd35ea846740f55e83038b3ff823d9ddd67e34`. Keep local-control protocol v24 and database schemas unchanged. Previously discarded manifests are not automatically reconstructed.
- Make development checks focused by default, fix web test-name filter forwarding, consolidate redundant browser coverage and split browser CI across three isolated single-worker runners. Superseded PR checks are cancelled; release gates are unchanged.

## 0.0.24

Release overview: [Clearer agent controls and reliable manual recovery](docs/releases/v0.0.24.md).

- Add explicit managed-worker Stop and same-transcript Restart even when session status is uncertain. Fence delivery, confirm exact-owner process exit and prevent delayed automatic wake after manual stop; unconfirmed shutdown never authorizes a replacement worker.
- Keep participant menus compact with Agent, New session and Inspect submenus, keyboard/touch navigation, collision-safe flyouts and red destructive actions. Stop agent now selects full worker shutdown; the legacy delivery-only action is labelled Pause agent and is not duplicated beside it.
- Move notification sound preferences from the sidebar into a dedicated Notifications section in Workspace Settings, preserving browser/identity scope and non-admin access. Make message links blue in light and dark themes without recoloring navigation.
- Pin Runtime `86f81102db9ddacade58009d040a95253188992b`, including bounded startup extension diagnostics and the stabilized startup-timeout test fixture. Advance local-control protocol to v24 without an authoritative database migration.

## 0.0.23

Release overview: [Inherit Pi integrations without extra controls](docs/releases/v0.0.23.md).

- Remove Runtime's blanket `--no-extensions` launch flag so capability discovery and newly launched/resumed Pi workers use Pi's configured extensions, built-in integrations and MCP servers.
- Keep integration configuration in Pi, including codemode activation; do not restore `pi-runtime.json`, `--pi-config` or per-agent integration controls. Skills selection and inherited service-environment behavior remain unchanged.
- Pin Runtime `7bd8a689dec0776d0b1fd5642d1a97353c9b251b`. Document trusted executable integrations, project-local configuration approval and worker replacement requirements. No database migration or local-control protocol change is added.

## 0.0.22

Release overview: [Simpler API workflows without extension configuration](docs/releases/v0.0.22.md).

- Remove explicit Pi extension loading, including `pi-runtime.json` and `--pi-config`. Existing extension configuration files are no longer read and are not deleted; removed CLI overrides are rejected.
- Pin Runtime's extension-removal commit `815f1fa3f9c73d573ce69d2c11142c70b3f40ffc`. Automatic extension discovery stays disabled; Skills, inherited environment handling, managed sessions, image input and diagnostics are preserved.
- Keep custom API workflows independent of native extensions. This does not provision service credentials, authorize automatic API fallback, add secret storage, or change database schemas/local-control protocol.

## 0.0.21

Release overview: [Stable text selection and quieter polling](docs/releases/v0.0.21.md).

- Preserve message Markdown DOM nodes through status refreshes and incoming messages so selected text stays selected and copyable; avoid reprocessing unchanged message bodies.
- Check active Runtime status every five seconds instead of every second. Check action receipts every fifteen seconds when idle, retaining one-second reconciliation while actions are pending; pause chat receipt polling in hidden tabs and refresh on return.
- Keep diagnostics authorization checks, live Conversation events, local-control protocol 23, database schemas and the pinned Runtime unchanged.

## 0.0.20

Release overview: [Explicit Pi integrations](docs/releases/v0.0.20.md).

- Add an installation-private, disabled-by-default Pi extension allowlist through `pi-runtime.json`, with explicit foreground/live-review overrides and consistent service/development startup behavior. Keep credentials, per-agent Skills, public contracts, and the UI independent.
- Validate owner-only configuration files with bounded reads and fail-closed errors. Keep disposable review from inheriting production integrations, and document host-wide scope, service credentials, and worker restart requirements.
- Pin the reviewed Runtime extension-loading implementation, including exact selected-skill verification after extension initialization and bounded private startup-hook diagnostics. No database migration or control-protocol change is added.

## 0.0.19

Release overview: [Reliable participant recovery and separate diagnostics](docs/releases/v0.0.19.md).

- Track participant lifecycle actions independently of browser deadlines and status reads, reconcile late completion without replaying uncertain mutations, and prevent duplicate or overlapping actions for the same participant.
- Keep other participants usable during individual actions, add per-participant read-only status refresh and dismissible action notices, and allow an explicit Stop retry against the same durably fenced session.
- Move privileged diagnostics to a separate, lazy-loaded page with optional new-tab opening; preserve access-loss clearing, scoped issue navigation, and read-only inspection. Advance local-control protocol to v23 without a database migration or Runtime dependency change.

## 0.0.18

Release overview: [Safe product locking and Conversation images](docs/releases/v0.0.18.md).

- Hold a private SQLite writer lock throughout product startup, execution and shutdown so concurrent stale-marker recovery cannot admit two owners of one data directory. Preserve live legacy markers, owner-only permissions, crash release and the stable lock-database inode across reopen.
- Require Node.js 22.5+ with SQLite enabled for the packaged foreground app; recommend 22.13+ for flag-free operation and the background service. Update `doctor` and packaged-install checks to verify SQLite availability and lock exclusion.

## 0.0.17

Release overview: [Conversation images and agent vision](docs/releases/v0.0.17.md).

- Share PNG, JPEG, GIF and WebP images as structured Conversation message attachments, including image-only messages, picker/paste/drop, durable local bytes and retry-safe sends. Keep external Markdown images blocked and mark any pixels not delivered to an agent as unavailable.
- Store image files in owner-private attachment directories, include them in migration backups and reclaim abandoned uploads without sweeping other standalone databases' message images.
- Deliver bounded image parts to image-capable owned Pi sessions through typed Runtime input and live model checks. Preserve text-only fallback, ordered-pixel retry identity, Fresh-session boundaries, cancellation and native transcript resume; no public URLs or filesystem paths are passed to agents.

## 0.0.16

Release overview: [message-delivery diagnostics](docs/releases/v0.0.16.md).

- Add collapsed, owner/admin-only message-delivery trails inside Details & diagnostics, without new chat notices or everyday UI. Record fixed-field Relay/Runtime/delivery milestones only; keep reused public-response acknowledgments and private cursor uncertainty distinct from new reply delivery.
- Retain trails for up to seven days or 1,000 completed trails installation-wide in a separate optional-journal collection, preserving lifecycle retention and write priority. Bound capture, clipping, authorization/fencing and disposable manual inspection; no prompts, tool output, raw errors, transcript access, report additions or Runtime wakeup.
- Upgrade only the private diagnostic companion journal to schema v2 and local-control protocol to v22. Public/authoritative Relay schemas, Runtime dependency and lifecycle semantics are unchanged.

## 0.0.15

Release overview: [safe recent Runtime events](docs/releases/v0.0.15.md).

- Add owner/admin-only **Recent Runtime events** in participant Details & diagnostics, alongside the existing Channels operation timeline. Inspect Runtime admission, dispatch, turn results, control acknowledgments and stop requests without exposing Pi/Codex logs or tool output.
- Bound each current-worker snapshot to 200 structured events and 32 KiB, with a two-second resource-read deadline, capture/window times and explicit eviction coverage. Older, suspended or unavailable workers remain unavailable rather than being started or resumed.
- Revalidate exact owner, binding and activation identity and fresh authorization before delivery. Keep event reads manual, cancel/fence late results and clear disposable browser state on close, navigation, access loss or observed replacement. Reports and clipboard actions do not include event content.
- Pin merged Runtime `e92176054206d70e120d4b6641bda2a3d037eb84` and advance local-control protocol to v21. No new database migration, raw export or lifecycle-semantic change is included.
- Preserve the outstanding real-Pi/clean-account acceptance and unresolved native database-panic caveats; automated, fake-RPC and packaged-integration evidence does not replace those gates.

## 0.0.14

- Publish the accumulated chat, agent-control and diagnostics improvements described in the [plain-English release overview](docs/releases/v0.0.14.md).
- Fix diagnostics shutdown returning before physical worker exit, which allowed journal reopening to race native database teardown. Keep the 500-ms flush budget and add a separate bounded 500-ms exit join; disclose incomplete shutdown rather than waiting indefinitely.
- Add regression coverage for delayed/failed worker exit, unresponsive exit, and immediate journal reopening after a real worker stops. This does not establish or claim to fix the earlier native Rust panic.

## 0.0.13

Tagged but not published: the release workflow stopped on a diagnostic journal `SQLITE_BUSY` test failure. Superseded by 0.0.14; the tag remains unchanged.

Release overview: [smoother chat, safer agent controls, and clearer diagnostics](docs/releases/v0.0.13.md).

- Add a private, bounded local timeline of agent operations, observed milestones, targeted failures and unknown outcomes, with owner/admin report preview and fresh-read Copy. Reports exclude raw logs, prompts, credentials, native session identifiers and private paths.
- Add read-only Session & context inspection that separates recorded context policy, observed running model/reasoning/skill-command availability, saved future launch settings and saved host context limits. Unsupported or older workers remain explicitly Not verified; no agent is started or resumed for inspection.
- Pin merged Runtime session-profile inspection and its managed-transcript compatibility fix. Revalidate owner, binding and generation before delivering inspection evidence; clear privileged browser state on access loss or navigation.
- Preserve the documented intermittent native database CI crash limitation: subsequent Linux/macOS, browser and packaging checks pass, but its root cause is unproven. Native backtraces are enabled without weakening test gates. Fresh real-Pi acceptance of the newest inspection feature remains outstanding.

- Share one multiplexed live-update connection across same-identity browser tabs so HTTP/1 stream limits cannot starve status/actions; reconcile on reconnect or suspended-tab overflow and use explicitly labeled snapshot polling when SharedWorker is unavailable.
- Keep participant inspection available during pending individual and bulk agent actions; allow busy confirmations to close or open diagnostics without canceling work, while retaining mutation guards and adding local request timing, status freshness, and read-only refresh.
- Use the short Bell fifth notification sound at its original pitch with increased gain; unlock saved sound preferences on trusted interaction after reload and notify when the browser window is unfocused while keeping a focused chat at its latest messages quiet.
- Persist a lease-clearing Stop intent before draining so crashes and uncertain pauses cannot auto-resume; preserve managed sessions for explicit Start, discard work through the stop boundary, and apply persisted per-session context modes including Fresh-session history exclusion.
- Place brief red turn-failure notices after their triggering messages in the Conversation timeline, with safe in-app diagnostics available to owners/admins from the notice and participant details; remove acknowledgment controls and avatar issue badges.

- Share complete-handle mention parsing between server and browser so trailing hyphens such as `@channel-` cannot be truncated into broadcast or another participant's handle.
- Scope broadcast recipient labels to the Conversation roster, while keeping broader Workspace identities for historical author/recipient attribution after removal.
- Make transient chat, participant, agent, and Workspace action errors dismissible without losing drafts, retry keys, or persisted diagnostics.
- Add collapse/dismiss controls to bulk-agent results and isolate chat feedback and late lifecycle responses across Conversation navigation.
- Keep individual session actions in each participant's popup without inline buttons. **Start agent** explicitly resumes a stopped session; **Reconnect** remains distinct. Offer **New session with context** and **Fresh session** for separate sessions, with Fresh excluding messages through its pre-launch Conversation boundary from future prompts.
- Restore `@channel` in broadcast suggestions and recipient labels, recognize it through the real message/response API, and retain the canonical `@conversation` target and older drafts. Reserve both broadcast handles against new assignment; preserve existing `channel` handles as direct mentions until renamed, with an unambiguous legacy broadcast fallback.
- Simplify Conversation participant dialogs to choosing existing agents, keep the current human automatic and existing non-agent roster members editable, and move identity creation out of the modal to the Workspace Agents page.
- Move channel settings from the header cog to the bottom of owner/admin sidebar popups, opening the existing name, participant, and working-folder modal without navigation or changes to its save behavior.
- Remove the redundant header Issues control in favor of participant Details & diagnostics. Keep participant avatars clickable with a bottom-right Runtime dot in expanded and minimized views, show turn-failure notices in the Conversation timeline, and avoid sidebar issue badges.
- Simplify participant rows to names, Runtime status dots, and live activity. Add a remembered desktop avatar rail and a Details & diagnostics modal for profiles, triggering messages, and safe failure details. Idle is blue, working green, uncertain/starting/retrying amber, and inactive gray; confirmed failures appear in the chat timeline without changing session health. Keep mobile drawers, lifecycle guards, diagnostic authorization, and Runtime session-ID redaction unchanged.
- Open Conversations at the latest message and keep the timeline anchored through live updates and content/composer resizing, while preserving the reader's position in older history.
- Streamline the composer with a two-row minimum input, borderless send-action footer, and accessible square icon-only send button; retain focus during and after Enter-to-send, including failed sends with preserved drafts.
- Lazily render a bounded Mermaid flowchart/basic-sequence profile with an expandable source disclosure, pointer-drag panning, and fixed zoom controls in the expanded view; preserve diagrams beside highlighted code and reject unsupported resource-capable syntax before rendering.

## 0.0.12

- Pin the Runtime managed-session release and add private, owner-scoped Conversation session history with durable activation, retirement, and cleanup reconciliation (`0011` Relay migration). Existing legacy references remain explicitly unmapped.
- Add opt-in idle suspend and lazy wake for owned Pi sessions. Preserve the logical session, transcript, Relay cursor, and binding generation; fail closed on uncertain work, lease, ownership, or lifecycle state (`0012` Relay migration).
- Add an owner/admin-only Workspace idle-sleep policy and settings control (`0013` Relay migration). Existing Workspaces and new deployments remain **Off** until explicitly configured; turning Off does not destroy a session already sleeping.
- Load browser routes and Markdown/syntax-highlighting features on demand to reduce the initial web bundle.

## 0.0.11

- Keep the local product browser session across service restarts with an owner-private signing key; renew it during use and require a new login only after 30 days of inactivity or credential removal.
- Leave disposable review/control sessions short-lived and in memory. Document macOS login-startup setup for an always-available background service.

## 0.0.10

- Add durable, owner/admin-only turn-failure diagnostics with short-lived, generation-fenced Runtime diagnostic actions; failures remain redacted from public Conversation history.
- Move owner/admin failure review into an Issues drawer, simplify Conversation lifecycle controls, and rename archived lifecycle presentation to Settled.
- Restore active managed agents on local startup: surviving sessions reconnect, while confirmed offline sessions receive fresh idle replacements without reviving explicitly stopped or disabled agents.
- Give replacement Pi sessions a temporary, public-Conversation-derived handoff; configure its 4K-token maximum plus 8K/50-message recent Conversation context per Workspace agent. Handoffs are not persisted as memory.
- Align healthy Relay turn deadlines with Pi while keeping short Runtime-operation timeouts and bounded retries.
- Add private Relay migration `0010_agent_session_context` for agent context-limit preferences.
- Document deferred web bundle optimization, idle-session sleep/wake, and Runtime session-history work.

## 0.0.9

- Restore compatibility with v0.0.5 local profiles that store the default Conversation id as `channelId`, without modifying owner data.

## 0.0.8

- Stabilize the pinned Runtime’s owned Pi turn completion test under CI load.
- Rename the canonical collaboration primitive from **Channel** to **Conversation** across the public database, private Relay database, HTTP/local-control APIs, browser routes, events, and TypeScript contracts. Existing `channel_` IDs and bookmarked `/channels/...` browser URLs remain valid; new conversations receive `conversation_` IDs.
- Before this migration runs, create owner-private, SQLite-consistent backups of `channels.db` and `relay.db` under `backups/before-migration-*`. The MinuChannels package, CLI, hostname, and `~/.minu/channels` data location remain unchanged.
- Add Channels-owned Conversation lifecycle state: configurable Snooze, Archive, explicit Reopen, idle-only managed-work coordination, and archived read-only roster/transcript preservation.

## 0.0.6

- Move source and review-mode default ports to `47510–47512`, keeping them separate from the installed product’s `47410–47412` ports.

## 0.0.5

- Add private, advisory Channel working folders with one primary session folder, optional additional folders, canonical descendant validation, owner/admin local configuration, and Workspace-root inheritance. Working folders guide new sessions only; they do not enforce filesystem access.

- Show saved agent instructions and Runtime launch selections on the authenticated local agent detail page, preselecting `openai-codex` / `gpt-5.6-sol` / `medium` when selections were previously omitted, while keeping list, public Channel, audit, and diagnostic responses redacted.
- Make `pnpm dev` use an isolated persistent development database, retain disposable review mode as `pnpm dev:review`, and add an active-instance-aware `pnpm dev:reset`.

## 0.0.4

- Add opt-in contextual notifications, richer safe agent activity, a wider autosizing composer, and structured participant lifecycle actions.
- Restore reachable Runtime sessions across Channels restarts and distinguish disconnected, uncertain, and confirmed-offline states without exposing Runtime internals.
- Bound activity recovery, large-history catch-up, retry deadlines, and delivery poison handling; preserve progress through private durable dead letters.
- Verify live session capabilities and offer owner-authorized opaque diagnostic opening without returning paths, logs, or Runtime identifiers.
- Add the macOS background-service lifecycle with explicit start, stop, status, open, login-startup, removal, and active-work-aware graceful restart commands.
- Coordinate checksum-verified global npm updates with the selected running service while refusing foreground and unrelated installation instances.

## 0.0.3

- Open first-run Workspace setup in the browser; keep an explicit source path as a non-interactive shortcut.
- Advertise the dedicated `minu-channels.localhost` browser origin while retaining loopback-only socket binding.
- Move the default Channels, control, and web ports to `47410–47412`.
- Preserve the authenticated browser session when the production web gateway proxies private control requests.

## 0.0.2

First installable local-alpha release.

- Fix the GitHub Release workflow so it checks out the configured pinned Runtime source.
- Validate the complete package and install/reopen smoke path on pull requests before tagging.
- Test the pinned Runtime before release packaging.
- Ask users to confirm MinuChannels is stopped before self-update while retaining mandatory active-instance checks.
- Use the canonical public Runtime repository and streamline release installation guidance.

## 0.0.1

Initial local-alpha release.

- Local-first Workspaces and Channels with persistent SQLite storage.
- Human, agent, and service identities with Workspace-local handles and revisioned rosters.
- Live messaging, mentions, streamed updates, Markdown rendering, syntax highlighting, and code copy controls.
- Private Pi Runtime configuration, model policies, discovered Skills, and explicit agent session lifecycle controls.
- Workspace and Channel administration, first-run onboarding, canonical private source paths, and native folder selection.
- Product-isolated data directories, owner-only permissions, one-writer locking, and typed resource IDs.
- Self-contained macOS/Linux release package with bundled Runtime and web assets.
- Version, paths, doctor, and checksum-verified update commands.
