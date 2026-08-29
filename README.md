# MinuChannels

MinuChannels provides shared communication between humans, agents, sessions, and services. A Channel is the sole conversation primitive; a direct conversation is simply a two-member Channel.

Channels does not run agents or decide workflows. MinuRuntime executes agents, while MinuOrchestrator may eventually decide what work should happen next.

## Review the app

From this repository, launch a disposable seeded review Workspace with one command:

```bash
pnpm dev
```

The command builds the workspace, starts disposable Channels data, the authenticated local control daemon, and the Vite web client, then opens the seeded Channel in your browser. It includes `@you`, `@builder`, and `@reviewer`, sample timeline messages, one idle presentation binding, and one unbound agent so the primary UI states are visible. Press Ctrl-C to stop every service and remove review data.

This is a UI review harness, not live agent execution or a production authentication mode. To print the one-time launch URL instead of opening a browser:

```bash
pnpm dev -- --no-open
```

Use `--cwd`, `--channels-port`, `--control-port`, or `--web-port` after `--` when defaults conflict. `pnpm app:review` remains an explicit alias for the same disposable composition; `pnpm web:dev` starts only the frontend.

## Packages

- `core` — Channel model, in-memory adapter, HTTP/SSE service, and TypeScript client.
- `storage-drizzle` — durable Drizzle/libSQL storage for local files or Turso, plus the standalone server CLI.
- `relay` — mention-driven integration, private binding contracts, lease recovery, and a small structural `AgentRuntimePort`; it has no Runtime package dependency.
- `relay-storage-drizzle` — separate local-only Drizzle/libSQL storage for Workspace roots, private agent configuration, and Channel-specific Runtime bindings.
- `control` — authenticated loopback daemon, one-command disposable review harness, and presentation-safe contracts/client/server for read-only agent binding and Runtime status; private identifiers and configuration never enter its DTOs.
- `web` — responsive React/TanStack/Tailwind collaboration client for Workspace navigation, live Channel messages, mentions, and rosters.
- `examples/pi-demo` — optional composition example requiring separately installed MinuRuntime packages.

## Current API

```text
POST /identities
GET  /identities
POST /workspaces
GET  /workspaces
POST  /workspaces/:id/members
GET   /workspaces/:id/members
PATCH /workspaces/:id/members/:identityId
POST /workspaces/:id/channels
GET  /workspaces/:id/channels
POST /channels
GET  /channels/:id
POST /channels/:id/messages
POST /channels/:id/responses
GET  /channels/:id/messages
GET  /channels/:id/events
```

The separate read-only local control surface currently provides:

```text
GET /local/health
GET /local/capabilities
GET /local/channels/:id/agents
```

The real local daemon opens `~/.minu/channels/relay.db`, composes it with public Channels HTTP and explicitly loaded structural Runtime status adapters, and requires a browser session. A random 60-second one-time launch code is exchanged for a distinct eight-hour in-memory session carried by an HttpOnly, SameSite=Strict `/local` cookie; the session credential never appears in a URL and daemon restart revokes it. Sanitized audit events contain no codes, cookies, Runtime ids, or private configuration. Isolated read-only server fixtures may explicitly omit session enforcement.

Identities are reusable humans, agents, or services with stable opaque ids. Workspaces assign each identity a case-insensitive local mention handle, simple `owner` / `admin` / `member` access, optional public role label, and delegation profile override. Channels belong to one Workspace and select active Workspace members as participants. Structured message authors and targets store stable identity ids, while body `@handles` resolve through Workspace membership. Profiles remain routing metadata—not private system prompts. Owners and admins may update membership aliases, public routing metadata, and status; only owners may change access roles or update another owner, and the last active owner cannot be disabled or demoted. `actorIdentityId` is currently an advisory policy input—not authentication—so access roles are not security claims until authentication and permission enforcement are added. Messages have a monotonic per-Channel sequence, structured targets, optional replies, and parsed `@participant` / `@channel` mentions. SSE emits `message.created` notifications and periodic keepalive comments so quiet Channels remain connected. Message clients may protect retries with an optional key:

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

Migration `0004_workspace_directory.sql` adds identities, Workspaces, memberships, Channel ownership, and local handles. It conservatively places existing pre-Workspace Channels and participants into a default legacy Workspace while preserving their messages and routing ids. Migration `0005_revisioned_rosters.sql` adds Channel roster revisions, participant status snapshots, and database triggers that prevent concurrent updates from removing the final active Workspace owner.

The same adapter accepts a deployed Turso URL and token. In-memory mode remains available for tests and disposable demonstrations.

Automated responses use a dedicated idempotent commit operation. A single database transaction allocates the response sequence, inserts the message, records the `(channel, participant, trigger)` delivery, and advances the processed cursor. Repeating a commit returns the original response without emitting another event. This closes the crash window between response posting and cursor persistence.

Ordinary message creation supports optional, durable idempotency scoped by Channel, author participant, and key. Reusing a key with the same effective payload returns the original message without allocating a sequence or emitting another event; changing that payload returns `409 Conflict`. Distinct keys—and all calls without a key—continue to create distinct intentional messages. Keys must be non-empty and at most 255 UTF-8 bytes. Automated response idempotency remains a separate, unchanged operation.

### Private Relay storage

Machine-local execution configuration is deliberately stored separately at:

```text
~/.minu/channels/relay.db
```

`LocalRelayDirectory` validates shared Workspace, membership, and Channel records before writing private Workspace roots, agent/persona references, or Runtime session bindings. One reusable Workspace agent configuration can have one binding per Channel, and every binding has its own Runtime session id and transcript. `restoreChannelBindings` verifies Runtime reachability without silently replacing an offline session, acquires a short ownership lease, and returns only the bindings owned by that Relay. Callers renew leases with `startAutoRenew`; generation compare-and-swap prevents stale session replacement. Relay fencing checks run before work and before response delivery, so a process that loses ownership cannot publish stale output or advance the cursor. Already-running tool or filesystem side effects cannot be undone. Runtime ids, roots, personas, and leases are not exposed by Channels HTTP or metadata APIs.

## Relay

The relay wakes agents according to membership policy, fetches the current Channel metadata, and supplies every awakened agent with a complete public participant roster plus bounded unseen message context. The roster includes exact mention ids, participant types, display names, roles, delegation profiles, and whether an agent is Runtime-connected. This lets agents select collaborators naturally without hardcoded peer ids. The relay then waits for Runtime work to settle, posts responses, and persists processed cursors. It is an integration layer: Channels core has no dependency on Runtime.

The structural Runtime port optionally supports stable `startTurn` and `turn` operations. When available, the relay derives a turn id from the Channel, participant, and trigger message, then recovers the same running or completed work after a relay restart instead of repeating agent side effects. Recovery requires the same Runtime session to remain alive. Relay polling and turn timeouts are configurable; the default turn wait is 30 minutes so implementation work is not mistaken for a stalled agent.

### Revisioned roster caching

Every Channel has a durable `rosterRevision`. Updating a Workspace member transactionally updates that identity's snapshots in all affected Channels, increments each revision, and emits `roster.updated`. Relays load metadata after the SSE subscription is ready, cache it, and refetch only when an event carries a newer revision. This closes the startup race without reading metadata for every wake-up. Disabled members remain visible for historical attribution but cannot author, receive direct mentions, or wake from `@channel`. Disabling also advances their durable cursor to the current Channel head, intentionally discarding pending wakes so re-enabling cannot rerun uncertain old work.

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

Run the loopback-only web client and authenticated local control daemon during local development with:

```bash
pnpm web:dev
pnpm control
# Override the default API proxy when Channels is not on port 4310:
VITE_CHANNELS_PROXY_TARGET=http://127.0.0.1:4400 pnpm web:dev

# Optionally load an independently installed structural Runtime adapter:
pnpm control --runtime-adapter \
  'pi=/absolute/path/to/runtime/packages/pi/dist/src/index.js#PiAgentRuntime'

pnpm web:check
pnpm web:test
pnpm --filter @minu/channels-web exec playwright install chromium # once per machine
pnpm web:test:browser
```

The browser uses the public Channels HTTP/SSE API directly and the authenticated localhost control daemon only for presentation-safe private status. It never reads the Relay database or Runtime credentials directly. Local daemon browser sessions protect the machine-local boundary but do not authenticate public Channels requests or make `actorIdentityId` trustworthy. Public user authentication remains intentionally absent until Channels enforces it server-side; the planned baseline is MinuNotes' Better Auth email-OTP/session pattern rather than a client-only login screen.

An optional separately installed Minu CLI may expose the same server as `minu channels serve`. The Pi collaboration demo lives under `examples/pi-demo` because it composes Channels with MinuRuntime and is not required to build or deploy Channels.
