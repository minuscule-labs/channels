# Changelog

## Unreleased

- Rename the canonical collaboration primitive from **Channel** to **Conversation** across the public database, private Relay database, HTTP/local-control APIs, browser routes, events, and TypeScript contracts. Existing `channel_` IDs and bookmarked `/channels/...` browser URLs remain valid; new conversations receive `conversation_` IDs.
- Before this migration runs, create owner-private, SQLite-consistent backups of `channels.db` and `relay.db` under `backups/before-migration-*`. The MinuChannels package, CLI, hostname, and `~/.minu/channels` data location remain unchanged.

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
