# Changelog

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
