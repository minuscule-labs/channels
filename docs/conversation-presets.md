# Conversation presets

Presets are reusable creation drafts saved in a Workspace. Open **Create Conversation**, choose a saved preset or an **Exploration**, **Feature delivery**, or **Incident / debug** starting point, and review the settings before creating.

- Assign existing, active Workspace agents to roles. Starting points leave role assignments open. Remove unused roles; an agent can fill one role in a draft. The current human is included automatically.
- Choose an optional Conversation model and effort, or keep each agent's saved settings. An explicit choice applies to every agent session started in that Conversation. The model must be available and enabled for each selected agent's harness, and the effort must be supported. Selecting a non-reasoning model sets effort to **off**; creation also checks compatibility with inherited agent settings.
- Add optional collaboration guidance, such as milestone check-ins. Guidance and role assignments are appended to the agents' Workspace instructions when sessions start. Check-ins rely on agent behavior; they are not scheduled reminders.
- Expand **Save or manage presets** to save a new preset, update a selected saved preset, or delete one. Saving does not create a Conversation. Adjusting a draft does not update its saved preset unless explicitly saved.

Creation copies the reviewed settings into an independent snapshot. Editing or deleting a preset later does not change existing Conversations. Workspace agent configurations and their other Conversations retain their settings. Initial starts and new-session replacements use the Conversation snapshot; resuming an existing session keeps that session's launch settings. The snapshot is visible under **Settings → Creation settings**. In an agent's **Inspect → Diagnostics** page, **Session & context** reports the effective saved model and effort.

Conversation roles are responsibilities supplied to agents, separate from Workspace access roles and Workspace-wide roster labels. Presets never create agent identities or change Workspace membership. Unavailable or disabled agents must be replaced or removed before creation. Up to 16 agent roles and 16 KiB of guidance are supported.

Presets and snapshots live in the private Relay database. Authenticated local-control endpoints require an active human Workspace owner or admin:

```text
GET    /local/workspaces/:workspaceId/conversation-presets
PUT    /local/workspaces/:workspaceId/conversation-presets/:presetId
DELETE /local/workspaces/:workspaceId/conversation-presets/:presetId
POST   /local/workspaces/:workspaceId/conversations
GET    /local/conversations/:conversationId/creation-setup
```

Preset writes use `expectedRevision` (`null` for creation) to reject stale edits and deletes. An exact retry of a committed preset create or update returns the original result without advancing its revision. **Reload presets** can recover a saved preset or copy whose response was lost. Switching presets keeps the new draft separate from earlier save or delete completions.

Conversation creation uses a caller-stable Conversation ID and persists its settings before publishing the Conversation. Exact retries recover after a lost response; a changed request with the same ID is rejected. If a failed creation needs different settings after its snapshot was saved, close the dialog and start a new draft. Public collaboration APIs do not expose private launch defaults or guidance.
