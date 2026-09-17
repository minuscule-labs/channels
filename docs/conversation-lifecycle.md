# Conversation lifecycle

A Conversation is always in one effective lifecycle state:

- **Active** — normal collaboration and managed-agent admission are enabled.
- **Snoozed** — hidden from the normal sidebar list until its scheduled time. Managed-agent admission is blocked while it is snoozed.
- **Archived** (stored as `settled`) — retained indefinitely, hidden in **Archive**, and frozen until an authorized user explicitly reopens it.

Lifecycle state belongs to the public MinuChannels collaboration database (`channels.db`). Relay and Runtime binding storage do not store or decide lifecycle state.

## Using the browser

Active Workspace owners and admins can open a Conversation’s sidebar action menu and:

- choose a snooze preset (one or three hours, this evening, tomorrow, or next week),
- select a custom local date and time,
- settle it to **Archive**, or
- reopen a Snoozed or Archived Conversation.

Snoozed and archived Conversations are grouped under collapsible **Snoozed** and **Archive** sidebar sections. An expired snooze is evaluated as Active when it is read; no background cleanup job is required.

Archived Conversations show an **Archived** status and are read-only. Sending messages, generating responses, renaming the Conversation, editing its participants, and managing its agents require reopening first. Reopen returns the lifecycle to Active, but deliberately does not start, reconnect, replace, or otherwise change any Runtime session.

## Managed work safety

Snooze and Archive are conservative operations. Before committing either change, MinuChannels fences new managed-agent admission and requires every managed agent to be idle or stopped. It rejects the operation when an agent is working, queued, starting, disconnected, offline, uncertain, or being replaced. Idle bindings are retired before lifecycle state is persisted.

This avoids silently interrupting accepted work. If MinuChannels reports that a managed agent must be idle or stopped, let the work finish or use the relevant safe session control, then retry the lifecycle action.

## Archive integrity

Archived Conversation transcripts and rosters are stable records. In addition to direct Conversation mutations, later Workspace-member updates and agent/service display-name changes do not revise an archived Conversation’s participant roster or roster revision. The Workspace-level change still applies to active Conversations and future work.

## Persistence and upgrades

Lifecycle records are stored in the `conversation_lifecycles` table introduced by public collaboration migration `0008_conversation_lifecycles.sql`. Existing Conversations with no row are Active, so the migration does not rewrite messages, sequences, participants, or Runtime bindings.

Normal product startup and update flows apply pending migrations automatically. For a local file-backed data directory, MinuChannels snapshots its public and private databases before a pending update migration. Keep an ordinary backup of `~/.minu/channels` before upgrading, verify the product after the update, and retain that backup until satisfied. Do not hand-edit `channels.db` or run the migration against real local data outside the product’s update path.

See [local release operations](local-release.md) for upgrade and restore guidance.
