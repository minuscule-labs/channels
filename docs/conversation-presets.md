# Conversation presets and settings

Create a Conversation using the existing compose button in the sidebar. The content page asks for a name, participants or a saved preset, and a working folder. The current human is included automatically. Leave the folder blank to use the Workspace source, or select a folder inside it. Folder validation and preparation finish before the Conversation is published. The separate Folder selector organizes the Conversation in the sidebar; opening creation from a folder menu preselects it.

Open **Workspace actions → Settings** for the Workspace settings page. Its horizontal tabs are inside the content area:

- **General**: Workspace name, private source location, and your notification preference on this device.
- **People & permissions**: Workspace members and their access roles. Owners can change human access roles; agent and service access remains Member.
- **Conversation presets**: a list of saved presets with dedicated create and edit pages.
- **Defaults & timeouts**: the base turn timeout and idle agent sleep policy.

The sidebar's controls and layout are unchanged.

## Presets

Select **Conversation presets → New preset**, enter a name, select existing Workspace agents using checkboxes, and add optional **Instructions**. There are no starting points, roles, session defaults, or timeouts in presets. Presets never create identities or change Workspace membership.

Select a saved preset during Conversation creation to copy its participants and instructions. You can adjust the participants before creating. Up to 16 participants and 16 KiB of instructions are supported. Unavailable agents must be replaced or removed before creation. Agents retain their saved model and effort; timeouts inherit the Workspace policy.

Existing reusable presets are migrated to this minimal format: assigned agents and instructions are retained, unassigned roles and obsolete overrides are removed. Affected preset revisions advance so stale editor writes conflict. Existing Conversation settings and immutable creation snapshots are not changed. The API retains the field name `guidance` for instructions; preset writes reject roles and removed override fields.

**Save as new preset** copies the current editor draft into a separate preset. Preset edits and deletion do not change existing Conversations. Saving a preset does not create a Conversation. Failed saves can be retried with the same draft ID, or recovered with **Reload presets**. Revision conflicts require an explicit reload.

## Editing a Conversation

Open **Conversation actions → Settings** to edit its name, roster and working folders on a separate page. Name and roster forms save independently. Shared Instructions and Skills are managed only in Workspace Settings; presets supply the task-specific instructions copied at creation. The separate Conversation Instructions/Skills editors and advanced Participants & roles, Session defaults and Collaboration editors are no longer displayed or loaded by this page. Existing saved roles, model/effort overrides and guidance are preserved, not silently cleared. Their backend persistence/API and immutable creation snapshots remain intact. Conversation creation and settings reject timeout overrides; every Conversation and thread uses the Workspace timeout policy.

New agent sessions and replacements use the current Conversation settings. Resuming a session retains its launch configuration. Threads inherit their parent's settings while retaining separate sessions and frozen public context. Workspace agent configurations and other Conversations retain their own settings. Creation snapshots remain immutable in storage but are not displayed in Settings. In each agent's **Inspect → Diagnostics**, **Session & context** reports the effective saved model and effort, and **Session instructions** reports that agent's instruction status. Settings does not duplicate saved instruction bodies or session status.

The Workspace turn timeout defaults to **1 hour**, with choices of **30 minutes, 1 hour, or 2 hours**. Existing explicitly saved Workspace values are preserved until changed. A turn snapshots its policy when processing begins; changing a setting does not shorten an in-progress turn. The overall turn budget follows that policy unless an explicit runtime retry budget is configured. Short internal network/runtime fault waits remain separate and unchanged.

Idle sleep defaults to **Off**. The Workspace can select 15 minutes, 30 minutes, 1 hour, 4 hours, or 24 hours, or **Off**. A saved idle policy applies to eligible idle sessions immediately; an already in-flight transition may finish. Addressing a sleeping agent wakes the same session. Migration0023 removes old overrides from editable Conversation settings and advances affected revisions, preserving other fields and immutable creation snapshots. Historical snapshot timeout values are archival only and never affect active policy.

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
