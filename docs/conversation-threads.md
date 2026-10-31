# Conversation threads

Threads are side discussions attached to top-level messages. **Start thread** creates one durable thread for a message; its reply count reopens the same side panel. Replies stay out of the main timeline. Nested threads and independently named sub-conversations are not supported.

## Context and agents

Each thread has its own message stream, drafts, retry keys, and per-agent Runtime sessions. Opening a thread does not start its agents; use the thread's participant controls. Existing Start, Stop, and session-replacement permissions still apply.

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
