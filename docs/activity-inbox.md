# Activity and unread state

Activity is a Workspace-scoped personal feed with All, Mentions and Threads tabs, authoritative unread counts, and links to exact Conversations or threads. A dedicated Threads screen, following controls, reactions and other notification types are not included.

## Activity

`/app/workspaces/:workspaceId/activity` lists incoming direct mentions, channel broadcasts, and replies in threads where the human authored the root or had already participated, within the selected Workspace only. Switching Workspaces while browsing Activity stays in Activity for the newly selected Workspace. Existing `/app/activity` bookmarks redirect to the remembered accessible Workspace, or the first accessible Workspace. Own messages are excluded. Participating later does not retroactively turn earlier unmentioned replies into notifications.

- **All** combines the existing eligible mentions and replies without double-counting a message that matches both rules.
- **Mentions** includes direct mentions and channel broadcasts addressed to the human, in either a parent Conversation or a thread.
- **Threads** includes eligible replies and mentions within threads. Creating a thread alone is not participation; a mention does not automatically subscribe the human to future unaddressed replies.

Replies from multiple authors in the same thread share one row, with the latest matching notification preview, its author plus the number of other notification authors, and an unread-notification count. Distinct threads in one parent remain separate; unthreaded mentions remain individual items. Mentions previews only matching mentions, not a later ordinary reply. Grouping and filtering occur before the 50-row keyset page limit, across the complete eligible thread history rather than only loaded pages.

The Activity navigation badge counts the selected Workspace's unread Activity notifications across **All**, regardless of the selected tab and including those beyond the loaded page—not grouped rows, other Workspaces' notifications or ordinary unread messages. A reply that is also a mention counts once. Three unread replies may occupy one row but contribute three to the badge. Row counts apply to the selected view. The badge appears in desktop and mobile navigation and is hidden at zero; browsing or switching tabs does not clear it.

Each item shows its channel, thread-root preview where applicable, message preview and unread state. Opening it navigates to the exact Conversation/thread and its first unread message. The URL target is focused once, not again on every live update. The selected tab is in `?view=mentions` or `?view=threads` (omitted means All), and remains selected across reload, Back from a thread and Workspace switching. Query caches and restored page/scroll coordinates are scoped by identity, Workspace and view.

Activity is projected from already-persisted messages, current membership/roster access and human read cursors. There is no separate notification queue or message fanout store. Reopening the database retains Activity without depending on successful SSE delivery. Revoked membership/roster access removes items at the next authorized read.

## Opening notifications

A thread reply or thread mention opens its parent Conversation with the existing thread panel selected explicitly. Desktop shows the parent alongside the panel; mobile shows the thread full-screen. The parent is positioned at the root, while the thread focuses its own first unread reply (or the linked reply when already read). Parent mentions explicitly open the parent view rather than restoring an unrelated remembered panel.

Thread links use `?threadId=...&threadMessage=...` on the parent Conversation URL; its message hash identifies the parent root, not a thread sequence. `threadId=null` explicitly selects the parent view. Normal remembered-thread navigation and older standalone thread URLs remain supported. A missing/foreign thread never falls back to a different remembered thread.

Closing the thread returns focus to its parent root without inserting another Back step. Back returns to the same Workspace's Activity position and loaded page depth, including after a reload. Per-tab session storage holds only identity/Workspace/view/history-scoped page counts and scroll coordinates, never notification bodies; if the query cache is gone, pages are fetched again through the current-access API.

Opening, restoring or loading a thread defaults read ownership to that thread, not its contextual parent. In the desktop split view, a trusted pointer, focus, wheel or keyboard interaction in either pane makes it the active read pane. The parent can therefore acknowledge visible latest messages without closing the thread; new messages in the other pane stay unread. Thread-navigation buttons do not claim the parent, and programmatic scrolling alone never changes ownership. Each pane still requires a visible, focused document, an unoccluded last message and an end-of-timeline position. Closing restores the parent's normal guarded read behavior.

## Unread correctness

Unread counts are calculated by the server across persisted messages, not from the browser's partial 100-message cache. Own messages are excluded; mention counts retain their existing direct-mention meaning.

Migration 0014 adds a separate `human_read_cursors` table and a chronological message index. Agent processing cursors, message persistence and Runtime lifecycle are unchanged. Existing valid browser read marks are imported monotonically when ahead of server state; they never rewind a server cursor.

The active read pane's focused, visible timeline at its end acknowledges through its actually visible last message. Covered/hidden/unfocused timelines and the inactive split-view pane do not acknowledge. The acknowledgement must identify a persisted sequence, and storage atomically takes the maximum of old/new cursors. A concurrently arriving later message stays unread. Read failures retain unread state and can retry on focus/visibility/reconnect.

Reading Activity, changing lifecycle or dropping a subscription does not acknowledge messages. Each thread has its own cursor. Parent-channel badges count parent messages; Workspace/document totals include thread unread counts as well. Reading a parent does not clear its threads, or vice versa.

## Delivery and access

The existing principal-scoped SharedWorker/SSE connection carries an optional body-free `inbox.updated` hint alongside its bounded Conversation topics. Inbox hints consume no Conversation slots. With no viewed/recent Conversations, one inbox-only stream remains while a tab is open; closing all consumers closes it. Unsupported workers retain snapshot polling rather than opening per-tab streams.

Load, readiness, focus, reconnect and a periodic snapshot reconcile Activity/unread state from the server. Hints are coalesced before refreshing; they are not the durable source of truth.

- `GET /identities/me/inbox`: authoritative summaries for the authenticated active human's accessible scopes.
- `GET /identities/me/activity?workspaceId=...&view=all|mentions|threads&before=...`: current-access Activity page filtered/grouped before pagination; cursor values, views and Workspace IDs are not access grants. The UI always supplies its selected Workspace and view. Grouped items add `authorCount` and `unreadCount`. Omitting `view` retains the original flat API; invalid views return 400. Omitting `workspaceId` retains the actor-wide projection for existing clients; an empty or inaccessible Workspace yields no items.
- `POST /conversations/:id/read`, `{ "sequence": n }`: acknowledge only the authenticated human's accessible Conversation.
- `GET /conversations/events?inbox=1&conversationId=...`: combine inbox hints with up to 100 Conversation IDs; zero IDs is valid with authenticated inbox opt-in.

The browser cannot select another recipient via request data. Production, development/review and browser fixtures use the existing authenticated web gateway to derive identity from the session cookie, rather than adding an identity bypass to the APIs.

## Focused verification

- Core HTTP inbox test: mandatory actor, actor isolation, inbox-only delivery and monotonic acknowledgement.
- libSQL inbox and memory/SQLite Activity-view tests: more than 100 messages, grouped/filter-before-page parity, distinct authors, participation timing, broadcasts, overlap deduplication, Workspace/roster revocation, persistence/reopen and independent thread/agent cursors.
- Hub/shared-worker tests: inbox-only lifetime, 100 Conversation slots and one physical connection.
- Activity browser tests: All/Mentions/Threads and keyboard navigation, grouped live previews/counts, Workspace isolation, mobile long-author layout, Back/reload restoration, unsubscribed replies across tabs, exact thread navigation, unread preservation, composer-focus retention and legacy read-mark import. The unfocused-document guard is exercised with an explicit focus-state override because Playwright forces focus in headless Chromium; this is not an OS-window-focus acceptance claim.
- Existing migration, collaboration, folder, shared-event and authored-skill checks cover the affected integration boundaries.

This implementation does not itself publish a release or update an existing installation.
