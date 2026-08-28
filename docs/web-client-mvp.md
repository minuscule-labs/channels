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
└── local control API (next slice)
    ├── private binding status
    ├── Runtime status
    ├── steer / interrupt
    └── local Workspace configuration
```

The browser must never open `relay.db`, receive Runtime credentials, or import Runtime/Relay packages. `packages/web` depends only on the public Channels client/types.

## Foundation slice

- React, TanStack Router, TanStack Query, Tailwind, and Vite.
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

A localhost control API is required before adding private controls. It should be served by a local daemon, use a separate `/local/*` namespace, bind to loopback by default, and later authenticate the browser session. It may call Relay and Runtime libraries; Channels core and the browser may not.

Initial control endpoints should be designed around capabilities rather than exposing storage rows:

```http
GET  /local/channels/:id/agents
POST /local/channels/:id/agents/:identityId/steer
POST /local/channels/:id/agents/:identityId/interrupt
GET  /local/workspaces/:id/config
PATCH /local/workspaces/:id/config
```

## Deferred

- Authentication and hosted deployment.
- Private Runtime controls until the local control API exists.
- Channel creation and participant selection.
- Membership administration.
- Threads, reactions, attachments, search, unread state, and notifications.
- TUI parity.
