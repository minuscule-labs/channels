# Conversation presets and settings

Create a Conversation using the existing compose button in the sidebar. The content page asks for a name, participants or a saved preset, and a working folder. The current human is included automatically. Leave the folder blank to use the Workspace source, or select a folder inside it. Folder validation and preparation finish before the Conversation is published. The separate Folder selector organizes the Conversation in the sidebar; opening creation from a folder menu preselects it.

Open **Workspace actions → Settings** for the Workspace settings page. Its horizontal tabs are inside the content area:

- **General**: Workspace name, private source location, and your notification preference on this device.
- **People & permissions**: Workspace members and their access roles. Owners can change human access roles; agent and service access remains Member.
- **Conversation presets**: a list of saved presets with dedicated create and edit pages.
- **Defaults & timeouts**: the base turn timeout and idle agent sleep policy.

The sidebar's controls and layout are unchanged.

## Presets

Select **Conversation presets → New preset**, give it a name, and choose existing Workspace agents. Optional **Exploration**, **Feature delivery**, and **Incident / debug** starting points supply role and guidance drafts. Assign agents to the roles or remove unused roles; an agent can fill one role. Presets never create identities or change Workspace membership.

The editor also provides optional Conversation model and effort overrides, timeouts, and collaboration guidance. Leaving model and effort unset uses each agent's saved configuration. An explicit model must be enabled for each selected agent's harness, and effort must be supported. A non-reasoning model sets effort to **off**. Agent roles are responsibilities, separate from Workspace access roles and Workspace roster labels. Check-in guidance relies on agent behavior; it does not schedule reminders.

Select a saved preset during Conversation creation to copy its participants and defaults. You can adjust the participants before creating. Up to 16 agent roles and 16 KiB of guidance are supported. Unavailable agents must be replaced or removed before creation.

**Save as new preset** copies the current editor draft into a separate preset. Preset edits and deletion do not change existing Conversations. Saving a preset does not create a Conversation. Failed saves can be retried with the same draft ID, or recovered with **Reload presets**. Revision conflicts require an explicit reload.

## Editing a Conversation

Open **Conversation actions → Settings** to edit its name, roster, working folders, session defaults, timeouts, and collaboration guidance on a separate page. Name and roster forms save independently. **Save Conversation settings** saves roles, model/effort overrides, timeouts, and guidance together with a revision check.

New agent sessions and replacements use the current Conversation settings. Resuming a session retains its launch configuration. Threads inherit their parent's settings while retaining separate sessions and frozen public context. Workspace agent configurations and other Conversations retain their own settings. **Original creation settings** remains an immutable snapshot for reference. In **Inspect → Diagnostics**, **Session & context** reports the effective saved model and effort.

The base turn timeout defaults to 30 minutes. Workspace and Conversation choices are 1, 5, 10, 15, or 30 minutes. A turn snapshots its policy when processing begins; changing a setting does not shorten an in-progress turn. The turn retry budget remains an upper bound.

Idle sleep defaults to **Off**. Conversations can inherit the Workspace policy, select 15 minutes, 30 minutes, 1 hour, 4 hours, or 24 hours, or explicitly select **Off**. A saved idle policy applies to eligible idle sessions immediately; an already in-flight transition may finish. Addressing a sleeping agent wakes the same session.

## Private local-control API

Presets, creation snapshots, and current settings live in the private Relay database. Endpoints require an authenticated, active human Workspace owner or admin:

```text
GET    /local/workspaces/:workspaceId/conversation-presets
PUT    /local/workspaces/:workspaceId/conversation-presets/:presetId
DELETE /local/workspaces/:workspaceId/conversation-presets/:presetId
POST   /local/workspaces/:workspaceId/conversations
GET    /local/conversations/:conversationId/creation-setup
GET    /local/conversations/:conversationId/settings
PUT    /local/conversations/:conversationId/settings
```

Preset writes use `expectedRevision` (`null` for creation). Conversation settings use `expectedRevision: 0` for the first edit. Exact retries return the committed result without advancing its revision; stale writes and deletes return a conflict. Creation retains its draft ID across retries, including lost responses. Folder preparation is recorded once so overlapping retries cannot overwrite later folder edits. These settings and absolute local paths are not published in Conversation metadata or messages. Folder snapshots contain a Workspace-relative path and a request hash, never the selected absolute path.
