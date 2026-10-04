# Changelog

## Unreleased

- Share complete-handle mention parsing between server and browser so trailing hyphens such as `@channel-` cannot be truncated into broadcast or another participant's handle.
- Scope broadcast recipient labels to the Conversation roster, while keeping broader Workspace identities for historical author/recipient attribution after removal.
- Make transient chat, participant, agent, and Workspace action errors dismissible without losing drafts, retry keys, or persisted diagnostics.
- Add collapse/dismiss controls to bulk-agent results and isolate chat feedback and late lifecycle responses across Conversation navigation.
- Expose individual Start buttons in the participant roster, retaining capability checks and new-session confirmation for stopped agents.
- Restore `@channel` in broadcast suggestions and recipient labels, recognize it through the real message/response API, and retain the canonical `@conversation` target and older drafts. Reserve both broadcast handles against new assignment; preserve existing `channel` handles as direct mentions until renamed, with an unambiguous legacy broadcast fallback.
- Simplify Conversation participant dialogs to choosing existing agents, keep the current human automatic and existing non-agent roster members editable, and move identity creation out of the modal to the Workspace Agents page.
- Open Conversations at the latest message and keep the timeline anchored through live updates and content/composer resizing, while preserving the reader's position in older history.
- Retain composer focus during and after Enter-to-send, including failed sends with preserved drafts.
- Lazily render a bounded Mermaid flowchart/basic-sequence profile with copyable source and safe fallback; preserve diagrams beside highlighted code and reject unsupported resource-capable syntax before rendering.

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
