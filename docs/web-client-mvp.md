# MinuChannels Web Client — MVP

**Status:** Reviewable collaboration UI; administration and live agent creation remain in progress

## Goal

Provide a responsive local-first human collaboration client for discovering Workspaces and Channels, reading live conversations, mentioning agents, and inspecting the public roster. The web app is a client, not a Runtime or orchestration layer.

## Architecture

MinuChannels is one product with modular internals:

```text
Browser ⇄ Channels HTTP/SSE ⇄ internal agent host ⇄ MinuRuntime sessions
```

Normal work, agent responses, safe status projections, and explicit operational intent should flow through Channels. The current direct localhost status overlay is transitional; private Workspace agent configuration, Runtime bindings, credentials, roots, leases, and diagnostics remain internal agent-host data rather than public Channel data.

The browser must never open private storage, receive Runtime credentials/session ids, or import agent-host/Runtime server packages. Current browser-safe control contracts remain only where the local composition still requires them. See [`product-boundary.md`](product-boundary.md).

## One-command review harness

`pnpm dev` now builds and starts a disposable seeded Channels service, temporary Relay storage, authenticated local control, and Vite, then opens the seeded Channel through the one-time browser bootstrap. `pnpm app:review` is the explicit alias, while `pnpm web:dev` remains frontend-only. The review Workspace contains one human, builder, and reviewer; representative timeline messages; one simulated builder binding; and one unbound agent. A real `ChannelRuntimeRelay` consumes explicit `@builder` mentions and posts a deterministic simulated response, proving routing, response commit, SSE, and rendering; unaddressed messages intentionally remain context without waking agents. Coordinated Ctrl-C shutdown removes Relay, temporary data, and the Vite process group. This mode is functional but uses a simulated Runtime—not live model execution or production authentication.

## Foundation slice

- React, TanStack Router, TanStack Query, Tailwind, and Vite.
- Radix Dialog for accessible mobile drawers, matching the proven MinuNotes primitive approach.
- MinuNotes-inspired responsive sidebar shell and flat technical visual language.
- Explicitly labeled Workspace sections and names in navigation and Channel headers.
- Durable Channel names as primary labels; opaque ids remain routing details.
- Channel timeline ordered by monotonic sequence.
- Race-free SSE startup: subscribe, wait for `ready`, refetch, then merge by message id.
- Revision-aware roster refresh.
- Temporary human author selection stored locally; current-human browser-session binding replaces it next.
- Plain-text composer with mention suggestions and structured targets.
- Enter-to-send interaction; Shift+Enter and Cmd/Ctrl+Enter insert line breaks without breaking IME or mention selection.
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

The current localhost boundary is implemented as `@minu/channels-control`. It provides browser-safe contracts/client exports, a Node server facade over structural Channel, binding, and Runtime status ports, and the current daemon/launcher. Under the accepted product direction this is a transitional internal agent-host package, not an independent product or alternate work path. Channels core and the browser may not import agent-host, Runtime, daemon, or server modules.

Current read-only endpoints are capability-oriented rather than storage CRUD:

```http
GET /local/health
GET /local/capabilities
GET /local/channels/:id/agents
```

The agent response reports `unbound | idle | running | offline | disabled | uncertain`, wake policy, and disabled command capability flags without Runtime session IDs, adapter names, leases, credentials, prompts, roots, or database paths. The web roster polls this optional API every five seconds while available, retries a missing service more slowly, and shows local Runtime state separately from public membership. Messaging continues and the roster labels local status unavailable when the service cannot be reached.

The real daemon now requires a browser session. A 256-bit one-time code valid for 60 seconds is redeemed at a loopback bootstrap endpoint for a separate random, HttpOnly, SameSite=Strict `/local` cookie. The credential is never placed in a URL, remains only in daemon memory, expires after eight hours, and is revoked by daemon restart. Browser and control use the same loopback hostname. Sanitized audit events record session issuance and rejection without recording either secret or private execution metadata. Playwright proves the cookie survives the control-to-web redirect and Vite `/local` proxy.

Steering, interruption, reconnect, configuration writes, and agent creation remain disabled until command-specific authorization, audit, fencing, and confirmations are implemented.

## Deferred

- Authentication and hosted deployment. Do not add a client-only login facade while Channels requests remain unauthenticated. When server authentication is introduced, reuse the MinuNotes Better Auth email-OTP/session pattern and bind the authenticated account to a Channels human identity.
- Private Runtime mutations until current-human authentication, agent-host fencing, and safe Channel command/result projections are defined.
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
