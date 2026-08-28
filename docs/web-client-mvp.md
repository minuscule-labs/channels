# MinuChannels Web Client — MVP

**Status:** In progress

## Goal

Provide a responsive local-first human collaboration client for discovering Workspaces and Channels, reading live conversations, mentioning agents, and inspecting the public roster. The web app is a client, not a Runtime or orchestration layer.

## Architecture

```text
Browser
├── Channels HTTP/SSE
│   ├── Workspaces and Channels
│   ├── public rosters
│   └── messages and live events
└── local control API
    ├── read-only binding and Runtime status (implemented)
    ├── Runtime status
    ├── steer / interrupt
    └── local Workspace configuration
```

The browser must never open `relay.db`, receive Runtime credentials, or import Runtime/Relay packages. `packages/web` depends only on the public Channels client/types.

## Foundation slice

- React, TanStack Router, TanStack Query, Tailwind, and Vite.
- Radix Dialog for accessible mobile drawers, matching the proven MinuNotes primitive approach.
- MinuNotes-inspired responsive sidebar shell and flat technical visual language.
- Workspace and Channel navigation.
- Channel timeline ordered by monotonic sequence.
- Race-free SSE startup: subscribe, wait for `ready`, refetch, then merge by message id.
- Revision-aware roster refresh.
- Human author selection stored locally.
- Plain-text composer with mention suggestions and structured targets.
- Desktop roster rail and mobile roster drawer.
- Explicit connecting/live/disconnected state and manual retry.

## API boundary

The public API is already sufficient for the foundation UI:

```http
GET /workspaces
GET /workspaces/:id/channels
GET /channels/:id
GET /channels/:id/messages
POST /channels/:id/messages
GET /channels/:id/events
```

The first localhost control boundary is implemented as `@minu/channels-control`. It provides browser-safe contracts/client exports and a Node server facade over structural Channel, binding, and Runtime status ports. It uses a separate `/local/*` namespace, binds only to loopback, validates Host and an explicit browser-Origin allowlist, exposes only reads, and returns sanitized presentation state. It may compose Relay and Runtime implementations; Channels core and the browser may not import them.

Current read-only endpoints are capability-oriented rather than storage CRUD:

```http
GET /local/health
GET /local/capabilities
GET /local/channels/:id/agents
```

The agent response reports `unbound | idle | running | offline | disabled | uncertain`, wake policy, and disabled command capability flags without Runtime session IDs, adapter names, leases, credentials, prompts, roots, or database paths. The web roster polls this optional API every five seconds while available, retries a missing service more slowly, and shows local Runtime state separately from public membership. Messaging continues and the roster labels local status unavailable when the service cannot be reached.

Steering, interruption, reconnect, configuration writes, and agent creation remain disabled until browser-session authentication, origin policy, audit, fencing, and confirmations are proven.

## Deferred

- Authentication and hosted deployment. Do not add a client-only login facade while Channels requests remain unauthenticated. When server authentication is introduced, reuse the MinuNotes Better Auth email-OTP/session pattern and bind the authenticated account to a Channels human identity.
- Private Runtime mutations until the local control API receives authenticated command support.
- Channel creation and participant selection.
- Membership administration.
- Threads, reactions, attachments, search, unread state, and notifications.
- TUI parity.

## Collaboration hardening

The implemented hardening slice builds OpenCode-style client/service seams with T3 Code-style React interaction patterns without changing the Channel domain model:

- Central query keys and pure SSE event-to-cache reduction.
- Client-generated message idempotency keys retained across retries.
- Draft persistence isolated by Workspace, Channel, and human author.
- Cursor-aware, keyboard-accessible mention suggestions with IME-safe submission.
- Deterministic timeline projection with day boundaries and compatible-message grouping.
- Automatic bounded SSE reconnect with authoritative ready/refetch/merge recovery.
- Playwright coverage against a real seeded Channels server for message send, roster revision, disconnect catch-up, stable retry keys, and accessible mobile drawers.
