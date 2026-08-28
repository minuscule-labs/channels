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
POST /channels
GET  /channels/:id
POST /channels/:id/messages
POST /channels/:id/responses
GET  /channels/:id/messages
GET  /channels/:id/events
```

Participants expose an id, type, optional display name, short public role, and public delegation profile. The profile is routing metadata—not the agent's private system prompt. Messages have a monotonic per-Channel sequence, structured targets, optional replies, and parsed `@participant` / `@channel` mentions. SSE emits `message.created` notifications.

## Storage

The default server uses Drizzle ORM and libSQL at:

```text
~/.minu/channels/channels.db
```

The same adapter accepts a deployed Turso URL and token. In-memory mode remains available for tests and disposable demonstrations.

Automated responses use a dedicated idempotent commit operation. A single database transaction allocates the response sequence, inserts the message, records the `(channel, participant, trigger)` delivery, and advances the processed cursor. Repeating a commit returns the original response without emitting another event. This closes the crash window between response posting and cursor persistence.

Ordinary `POST /channels/:id/messages` calls are not yet idempotent. Two identical human or client sends create two messages because they currently represent distinct inputs. Before adding the web client, this endpoint should accept a client-generated idempotency key to protect against network retries and accidental double submission.

## Relay

The relay wakes agents according to membership policy, fetches the current Channel metadata, and supplies every awakened agent with a complete public participant roster plus bounded unseen message context. The roster includes exact mention ids, participant types, display names, roles, delegation profiles, and whether an agent is Runtime-connected. This lets agents select collaborators naturally without hardcoded peer ids. The relay then waits for Runtime work to settle, posts responses, and persists processed cursors. It is an integration layer: Channels core has no dependency on Runtime.

### Future roster caching

The correctness-first MVP currently fetches Channel metadata for each wake-up. Once membership becomes mutable, the relay should instead load the roster at startup/reconnect, cache it with a revision, and update it from `participant.added`, `participant.updated`, and `participant.removed` events. A reconnect or revision gap triggers one metadata refetch. Until membership mutation exists, this optimization is intentionally deferred.

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
