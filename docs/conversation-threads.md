# Conversation threads

Threads are side discussions attached to top-level messages. Choose **Start thread** from a message’s borderless actions menu to create one durable thread for that message; its reply count or **Open thread** menu action reopens the same side panel. Replies stay out of the main timeline. Nested threads and independently named sub-conversations are not supported.

The browser remembers the open thread separately for each user and channel. Returning to that channel or reloading restores the panel; closing it (including Escape) clears that selection. Only the thread ID is stored locally, not its messages. Restoring a panel never starts an agent.

## Context and agents

Each thread has its own message stream, drafts, retry keys, and per-agent Runtime sessions. Main conversations and threads share [participant targeting](participant-targeting.md), with separate per-user browser-local selections. Opening, reading or drafting in a thread does not start agents.

An addressed browser **Send** can start eligible never-bound thread agents, using existing Start permissions:

- Explicit recipients take precedence. Multiple explicit agents can start; that message does not replace the sticky selection. Broadcast never initiates startup.
- Without explicit recipients, default to the root's active agent author. For a human-authored root, use its sole active agent recipient; otherwise leave selection/start manual.
- Each user's selected recipient remains the default for their followups. A new single mention, recipient-control choice or Reply switches it without changing the parent's selection or rewriting message text.
- The message is saved with its normal retry key before startup; the new session includes that trigger and earlier directly addressed pending questions, above public retirement floors. A failed or partially failed startup preserves the durable message and same-key retry.
- Existing bindings—including explicitly stopped, uncertain or disabled sessions—are never implicitly resumed or replaced. Use the participant controls for those actions. Ordinary members can still post messages but do not gain Start privileges.

This behavior uses the authenticated local thread-send endpoint. Direct public message API writes do not start workers. Existing Start, Stop, session-replacement, parent lifecycle and working-folder permissions still apply; parent/sibling sessions and the context snapshot remain unchanged.

For a new thread, the initial public context is captured through **first thread creation**, not just through the root message:

- Always retain the selected root and mark it as the thread's starting message for the agent.
- Include recent parent messages within a maximum of 20 messages and a nominal 16,000 message-body-character budget. The root is retained in full even if it exceeds that background budget.
- Keep the selected messages in parent sequence order.
- Persist the snapshot unchanged. Reopening the thread, delayed agent startup, or later parent/sibling discussion does not refresh it. Existing stored snapshots are not retroactively rewritten.

Ordinary with-context session launches use that public snapshot as untrusted reference data, not higher-priority instructions. **Fresh session** deliberately omits inherited background. Private parent Runtime transcripts and tool history are never cloned. Conversation isolation does not isolate the shared project filesystem.

## Inherited administration

Threads inherit the parent's current participants, lifecycle, and working-folder configuration. They cannot independently widen membership, change working folders, or reopen an archived parent. Archive the parent only when managed main/thread work is idle or stopped; an archived parent freezes thread writes and prevents agent starts. Reopen through the parent.

## Returning results to main

For this version, ask the thread agent for a summary, then manually copy and post it in the main conversation. That is an ordinary new message; it does not synchronize histories. Mention an agent when follow-up is needed.

A Copy-message action and reviewed Share-to-conversation workflow are separate follow-ups, not part of this implementation.
