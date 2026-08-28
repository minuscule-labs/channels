# MinuChannels

MinuChannels provides shared communication between humans, agents, sessions, and services. A Channel is the sole conversation primitive; a direct conversation is simply a two-member Channel.

Channels does not run agents or decide workflows. MinuRuntime executes agents, while MinuOrchestrator may eventually decide what work should happen next.

## Packages

- `core` — Channel model, in-memory adapter, HTTP/SSE service, and TypeScript client.
- `storage-drizzle` — durable Drizzle/libSQL storage for local files or Turso, plus the standalone server CLI.
- `relay` — mention-driven integration against a small structural `AgentRuntimePort`; it has no Runtime package dependency.
- `examples/pi-demo` — optional composition example requiring separately installed MinuRuntime packages.

## Current API

```text
POST /identities
GET  /identities
POST /workspaces
GET  /workspaces
POST /workspaces/:id/members
GET  /workspaces/:id/members
POST /workspaces/:id/channels
GET  /workspaces/:id/channels
POST /channels
GET  /channels/:id
POST /channels/:id/messages
POST /channels/:id/responses
GET  /channels/:id/messages
GET  /channels/:id/events
```

Identities are reusable humans, agents, or services with stable opaque ids. Workspaces assign each identity a case-insensitive local mention handle, simple `owner` / `admin` / `member` access, optional public role label, and delegation profile override. Channels belong to one Workspace and select active Workspace members as participants. Structured message authors and targets store stable identity ids, while body `@handles` resolve through Workspace membership. Profiles remain routing metadata—not private system prompts. Access roles are modeled for the directory but are not authorization claims until authentication and permission enforcement are added. Messages have a monotonic per-Channel sequence, structured targets, optional replies, and parsed `@participant` / `@channel` mentions. SSE emits `message.created` notifications and periodic keepalive comments so quiet Channels remain connected. Message clients may protect retries with an optional key:

```http
POST /channels/:id/messages
Idempotency-Key: <client-generated-key>
```

The TypeScript client exposes this as `postMessage(channelId, input, { idempotencyKey })`.

## Storage

The default server uses Drizzle ORM and libSQL at:

```text
~/.minu/channels/channels.db
```

Migration `0004_workspace_directory.sql` adds identities, Workspaces, memberships, Channel ownership, and local handles. It conservatively places existing pre-Workspace Channels and participants into a default legacy Workspace while preserving their messages and routing ids.

The same adapter accepts a deployed Turso URL and token. In-memory mode remains available for tests and disposable demonstrations.

Automated responses use a dedicated idempotent commit operation. A single database transaction allocates the response sequence, inserts the message, records the `(channel, participant, trigger)` delivery, and advances the processed cursor. Repeating a commit returns the original response without emitting another event. This closes the crash window between response posting and cursor persistence.

Ordinary message creation supports optional, durable idempotency scoped by Channel, author participant, and key. Reusing a key with the same effective payload returns the original message without allocating a sequence or emitting another event; changing that payload returns `409 Conflict`. Distinct keys—and all calls without a key—continue to create distinct intentional messages. Keys must be non-empty and at most 255 UTF-8 bytes. Automated response idempotency remains a separate, unchanged operation.

## Relay

The relay wakes agents according to membership policy, fetches the current Channel metadata, and supplies every awakened agent with a complete public participant roster plus bounded unseen message context. The roster includes exact mention ids, participant types, display names, roles, delegation profiles, and whether an agent is Runtime-connected. This lets agents select collaborators naturally without hardcoded peer ids. The relay then waits for Runtime work to settle, posts responses, and persists processed cursors. It is an integration layer: Channels core has no dependency on Runtime.

The structural Runtime port optionally supports stable `startTurn` and `turn` operations. When available, the relay derives a turn id from the Channel, participant, and trigger message, then recovers the same running or completed work after a relay restart instead of repeating agent side effects. Recovery requires the same Runtime session to remain alive. Relay polling and turn timeouts are configurable; the default turn wait is 30 minutes so implementation work is not mistaken for a stalled agent.

### Future roster caching

The correctness-first MVP currently fetches Channel metadata for each wake-up. Relay prompts display Workspace-local `@handles` while retaining stable identity ids for routing. Once membership becomes mutable, the relay should instead load the roster at startup/reconnect, cache it with a revision, and update it from `participant.added`, `participant.updated`, and `participant.removed` events. A reconnect or revision gap triggers one metadata refetch. Until membership mutation exists, this optimization is intentionally deferred.

### Explicit controls

Normal addressed messages remain queued turns. Human clients may explicitly control a working bound agent:

```text
/steer @agent-a <guidance>
/interrupt @agent-a <replacement instruction>
```

Steering is delivered at the Runtime adapter's next safe model boundary and is recorded as an unaddressed Channel control message so it does not create another wake-up. Interruption aborts the active run, marks its trigger handled, and posts the replacement as a normal addressed Channel message. Interruption cannot undo tool or filesystem side effects.

## CLI

Install and operate Channels independently:

```bash
pnpm install
pnpm build
pnpm serve --port 4310
pnpm serve --db ./channels.db
pnpm serve \
  --db-url "$TURSO_DATABASE_URL" \
  --auth-token "$TURSO_AUTH_TOKEN"
```

An optional separately installed Minu CLI may expose the same server as `minu channels serve`. The Pi collaboration demo lives under `examples/pi-demo` because it composes Channels with MinuRuntime and is not required to build or deploy Channels.
