# Activity and unread state

The first version is one Activity list, authoritative unread counts, and links to exact Conversations or threads. A dedicated Threads screen, following controls, grouping, reactions and filters are not included.

## Activity

`/app/activity` lists incoming direct mentions, channel broadcasts, and replies in threads where the human authored the root or had already participated. Own messages are excluded. Participating later does not retroactively turn earlier unmentioned replies into notifications.

The Activity navigation badge counts all unread Activity notifications, including those beyond the loaded page—not all unread messages. A reply that is also a mention counts once. The badge appears in desktop and mobile navigation and is hidden at zero; browsing Activity does not clear it.

Each item shows its author, channel, thread-root preview where applicable, message preview and unread state. Opening it navigates to the exact Conversation/thread and its first unread message. The URL target is focused once, not again on every live update. The list has bounded, 50-item keyset pagination.

Activity is projected from already-persisted messages, current membership/roster access and human read cursors. There is no separate notification queue or message fanout store. Reopening the database retains Activity without depending on successful SSE delivery. Revoked membership/roster access removes items at the next authorized read.

## Unread correctness

Unread counts are calculated by the server across persisted messages, not from the browser's partial 100-message cache. Own messages are excluded; mention counts retain their existing direct-mention meaning.

Migration 0014 adds a separate `human_read_cursors` table and a chronological message index. Agent processing cursors, message persistence and Runtime lifecycle are unchanged. Existing valid browser read marks are imported monotonically when ahead of server state; they never rewind a server cursor.

A focused, visible timeline at its end acknowledges through its actually visible last message. Covered/hidden/unfocused timelines do not acknowledge. The acknowledgement must identify a persisted sequence, and storage atomically takes the maximum of old/new cursors. A concurrently arriving later message stays unread. Read failures retain unread state and can retry on focus/visibility/reconnect.

Reading Activity, changing lifecycle or dropping a subscription does not acknowledge messages. Each thread has its own cursor. Parent-channel badges count parent messages; Workspace/document totals include thread unread counts as well. Reading a parent does not clear its threads, or vice versa.

## Delivery and access

The existing principal-scoped SharedWorker/SSE connection carries an optional body-free `inbox.updated` hint alongside its bounded Conversation topics. Inbox hints consume no Conversation slots. With no viewed/recent Conversations, one inbox-only stream remains while a tab is open; closing all consumers closes it. Unsupported workers retain snapshot polling rather than opening per-tab streams.

Load, readiness, focus, reconnect and a periodic snapshot reconcile Activity/unread state from the server. Hints are coalesced before refreshing; they are not the durable source of truth.

- `GET /identities/me/inbox`: authoritative summaries for the authenticated active human's accessible scopes.
- `GET /identities/me/activity?before=...`: current-access Activity page; cursor values are ordering boundaries, not access grants.
- `POST /conversations/:id/read`, `{ "sequence": n }`: acknowledge only the authenticated human's accessible Conversation.
- `GET /conversations/events?inbox=1&conversationId=...`: combine inbox hints with up to 100 Conversation IDs; zero IDs is valid with authenticated inbox opt-in.

The browser cannot select another recipient via request data. Production, development/review and browser fixtures use the existing authenticated web gateway to derive identity from the session cookie, rather than adding an identity bypass to the APIs.

## Focused verification

- Core HTTP inbox test: mandatory actor, actor isolation, inbox-only delivery and monotonic acknowledgement.
- libSQL inbox test: more than 100 messages, persistence/reopen, paging, participation timing, channel mentions, revocation, independent thread and agent cursors.
- Hub/shared-worker tests: inbox-only lifetime, 100 Conversation slots and one physical connection.
- Activity browser tests: unsubscribed replies across tabs, exact thread navigation, unread preservation, composer-focus retention and legacy read-mark import. The unfocused-document guard is exercised with an explicit focus-state override because Playwright forces focus in headless Chromium; this is not an OS-window-focus acceptance claim.
- Existing migration, collaboration, folder, shared-event and authored-skill checks cover the affected integration boundaries.

This implementation does not itself publish a release or update an existing installation.
