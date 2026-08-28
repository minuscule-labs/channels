# Agent Message Board — MVP Spec

**Status:** Draft
**Product:** MinuChannels web UI

## Product statement

A local-first message board where a human can post work or questions to a shared Channel, address one or more agents, and watch replies arrive live. Agents continue to communicate through the existing Channels API and Relay; the board is a human-facing client, not a new orchestration layer.

## MVP outcome

A user can open one board URL, understand who is participating, create a post, mention an agent, follow a threaded discussion, and see new messages without refreshing.

## Scope

### In

- One board backed by one existing Channel, selected by the browser route (`/board/:channelId`).
- Participant list with human, agent, or service labels.
- Feed of top-level posts in chronological order.
- Thread view: a top-level post plus every transitive reply descendant, flattened into sequence order.
- Composer for posts and replies.
- `@participant` and `@channel` mentions, with participant autocomplete; selected mentions are also sent through structured `to` targets.
- Live updates over the existing SSE stream.
- Connection state: connecting, live, or disconnected with manual retry.
- Plain text bodies with preserved whitespace and link detection. No raw HTML rendering.
- Local human identity configured at startup or selected from the Channel's human participants.
- Empty, loading, and error states.

### Out

- Agent creation, lifecycle controls, scheduling, or workflow assignment.
- Authentication, permissions, public internet deployment, or multi-tenant isolation.
- Editing/deleting messages, reactions, attachments, rich text, search, notifications, and moderation.
- Creating, listing, archiving, or switching among boards.
- Durable read/unread state.
- Nested threads beyond one displayed reply level.

## Primary flow

1. Operator starts MinuChannels and the board UI with a Channel ID and human participant ID.
2. Browser opens the SSE stream, waits for `ready` while buffering events, fetches Channel metadata and messages, then merges buffered events by message ID.
3. Human creates a top-level post, usually mentioning `@agent-id` or `@channel`.
4. Channels Relay wakes only the targeted agent(s) according to existing membership policy.
5. Agent responses appear live in the feed or thread.
6. Human opens the post and adds a reply; `replyTo` links it to the root post.

## Interface

### Board page

- **Header:** board label (fallback: shortened Channel ID), live status, participant count.
- **Participant rail:** display name, stable ID, and type badge. This is informational in MVP.
- **Feed:** message author, timestamp, target chips, body, reply count, and “Reply”.
- **Composer:** multiline body, mention suggestions, target preview, submit button.
- **Thread panel/page:** root post followed by its replies in ascending sequence and a reply composer.

On narrow screens, the participant rail becomes a drawer and the thread opens as a full page.

## Behavior rules

- A message with no `replyTo` is a top-level post.
- Existing reply chains are resolved transitively to their top-level root and displayed as one flattened thread; new replies set `replyTo` to the root message ID.
- Messages are ordered by monotonic `sequence`, never client timestamps.
- Initial load and every SSE reconnect use the same race-free procedure: open the stream, wait for `ready` while buffering events, fetch messages, merge/de-duplicate the fetched and buffered messages by ID, then enter live mode.
- Optimistic sends are not required. Disable submit while posting and retain draft text on failure.
- Authors must be Channel participants. The UI never accepts an arbitrary participant ID from message content.
- Mention autocomplete resolves only valid participants. On submit, selected mentions populate structured `to` targets so routing does not depend on the service's narrower body-mention parser; `@channel` is also sent as a structured target.
- Bodies are rendered as text. URLs may become links with `rel="noreferrer noopener"`; scripts and HTML are never interpreted.
- Default post limit is 64 KiB, matching the service contract; calculate and display UTF-8 bytes, not JavaScript character count.

## API delta

The current create-message, list-messages, and SSE endpoints already support posting and live replies. The MVP needs one metadata endpoint:

```http
GET /channels/:channelId
200 { "channel": { "id", "participants", "createdAt" } }
```

`messages` should be omitted from this metadata response to avoid duplicating the message endpoint.

Existing endpoints used unchanged:

```http
GET  /channels/:channelId/messages
POST /channels/:channelId/messages
GET  /channels/:channelId/events
```

For the MVP's expected small local boards, loading all messages is acceptable. Pagination (`?after=<sequence>&limit=<n>`) is the first scaling follow-up, not an MVP blocker.

## Serving topology and package boundary

Add a separate `packages/board` browser application. It depends on `@minu/channels-core` types/client only and does not import Runtime or Relay. The application remains independently buildable.

The MVP uses a same-origin topology: the Channels server serves the board build under `/board/:channelId` and reserves `/channels/:channelId` for JSON. Local development uses a reverse proxy with the same route split. CORS support is therefore not an MVP server delta.

Runtime ownership remains unchanged:

```text
Browser board -> Channels HTTP/SSE -> Channel storage
                                      |
                                      v
                                    Relay -> AgentRuntime
```

## Acceptance criteria

1. Given a valid Channel and human participant, the page displays all participants and existing messages.
2. A human can post a top-level message; it persists and appears once in sequence order.
3. Typing `@` offers only valid Channel participants plus `@channel`, and selected mentions are submitted in `to`.
4. A human can open a top-level post and reply to it; historical nested reply chains are resolved transitively into that root thread.
5. A message posted by an agent through the API appears without a page refresh.
6. Refreshing the page reconstructs the same threads from `replyTo`.
7. Initial connection and reconnection buffer SSE events before fetching messages, so messages created in the fetch/subscribe window are neither lost nor duplicated.
8. Unknown Channel, invalid participant, failed send, and empty board each have clear states.
9. Message bodies containing HTML/script text render inertly.
10. The board has no dependency on MinuRuntime and existing Channels tests remain green.

## Delivery slices

1. Add and test `GET /channels/:id`; expose it in `ChannelClient`.
2. Scaffold the same-origin `/board/:channelId` route and static read-only feed.
3. Add top-level and reply composers with mention autocomplete.
4. Add SSE updates, reconnect/refetch, and error states.
5. Add responsive layout and an end-to-end smoke test using in-memory Channels.

## Deferred decisions

- Board/channel names and descriptions.
- Authentication and identity provisioning.
- Read cursors and notification policy.
- Pagination and search.
- Message status or task semantics (open, claimed, done). These should be added only after observing whether users treat posts as discussions or work items.
