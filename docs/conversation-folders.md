# Conversation folders

Folders organize Conversations inside a Workspace:

```text
Workspace → Folder → Conversation → Thread
          → Unfiled Conversation
```

A top-level Conversation belongs to zero or one folder in its own Workspace. Folders are shared navigation, not Projects, source directories, permission boundaries, or shared agent context.

## Using folders

Active human Workspace owners and admins can:

- choose **Create folder** from the Workspace actions menu,
- rename a folder using its header action,
- choose an optional **Folder** when creating a Conversation, or
- choose **Move to folder** from Conversation actions, including **Unfiled**.

Ordinary members can navigate and collapse groups but cannot administer folders or assignments. Existing authenticated gateway and core service-credential policies still apply; folders add no new confidentiality guarantee.

Folder names are trimmed and must contain 1–100 UTF-16 code units, excluding U+0000. Names are unique within a Workspace using JavaScript's locale-independent Unicode `toLowerCase()`: **Roadmap** and **roadmap** conflict. No Unicode normalization or accent folding is performed. Different Workspaces may use the same name. Renaming preserves the folder ID and its assignments.

## Navigation and lifecycle

- Folder groups are alphabetical, with a stable folder-ID tie-breaker. Existing Conversation order is preserved within a group.
- Empty folders and Unfiled stay visible. Active Conversations without a folder appear under Unfiled.
- Collapse preferences are browser-local, scoped by current human, Workspace, and folder ID. Desktop and mobile drawer use the same preferences. Groups initially expand; direct navigation or a successful move reveals the selected Conversation's destination.
- Collapsed groups aggregate active unread messages and direct mentions without marking anything read or double-counting Workspace totals.
- Snoozed and Settled/Archived Conversations retain their folder assignment in the existing lifecycle sections. Reopening returns them to that folder or Unfiled. Active and Snoozed Conversations may move; Settled/Archived Conversations must be reopened first.
- Threads cannot be filed independently. They remain attached to the parent, retaining their own messages, context snapshot, and agent sessions.

Folder writes use the existing pending/error UI. A rejected move retains the previous assignment. IDs and Conversation URLs do not change when filing, unfiling, or renaming a folder.

## Synchronization

The mutating tab updates its folder catalogue and Conversation metadata after the server confirms success. A committed assignment emits the existing `conversation.updated` event; unchanged assignments emit no extra event. Active and background connections refresh metadata and discover previously unknown folders without clearing messages or unread state.

Other tabs refresh folder catalogues on focus/reload, and queries refresh on reconnect. Immediate Workspace-wide streaming of catalogue-only renames is not promised. This feature adds no catalogue polling loop.

## Data and execution boundaries

Migration `0011_conversation_folders.sql` adds the public `conversation_folders` table, a nullable Conversation `folder_id`, and reference/Workspace/thread guards. Existing Conversations become Unfiled without a backfill or transcript/roster rewrite. Folder membership survives database reopen.

Creating, renaming, filing, and unfiling do not change Conversation IDs, participants, roster revisions, messages/sequences, read cursors, lifecycle, or thread ancestry. They do not start, stop, resume, replace, interrupt, or prompt agents; change private Workspace source roots or Conversation working folders; or change Runtime binding/session identity. Existing lifecycle actions retain their own managed-work safety rules independently of organization.

Normal product startup applies the additive migration. Follow [local release backup/restore guidance](local-release.md), not manual edits to a live database.

## Non-goals

No nested folders, multiple-folder membership, folder deletion/archive, bulk moves, drag-and-drop, custom ordering, folder-specific permissions/agents/instructions, shared context, or source-directory changes are included. Search and existing lifecycle terminology are unchanged.

## Verification references

Folder contracts, migration/reopen and authorization checks live in the existing core, storage, and gateway test suites. Web unit and browser coverage is in `packages/web/test/conversation-folders.test.tsx` and `packages/web/test-browser/conversation-folders.spec.ts`.

`scripts/smoke-conversation-folders.mjs` exercises signed browser authentication, the real gateway/core and public/private databases, and real Runtime-owned workers. Its final Pi RPC executable is controlled: it uses no installed Pi or model provider. Run after `pnpm build`, with `MINU_RUNTIME_ROOT` pointing to the built Runtime revision in `runtime-source.json`, or `MINU_RUNTIME_MODULE` pointing to the bundled Runtime client. CI uses the bundled pinned Runtime in the existing package-verification job.

See [Conversation lifecycle](conversation-lifecycle.md) and [Conversation threads](conversation-threads.md) for their separate execution and context contracts.
