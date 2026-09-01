# MinuChannels Web Client — MVP

**Status:** Reviewable collaboration, participant creation, private configuration, Channel administration, and explicit managed-agent lifecycle UI

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

`pnpm dev` builds and starts a disposable seeded Channels service, temporary Relay storage, authenticated local control, and Vite, then opens the seeded Channel through the one-time browser bootstrap. `pnpm app:review` is the explicit alias, while `pnpm web:dev` remains frontend-only. The default review Workspace contains one human, builder, and reviewer; representative timeline messages; one simulated builder binding; and one unbound agent. A real `ChannelRuntimeRelay` consumes explicit `@builder` mentions and posts a deterministic simulated response, proving routing, response commit, SSE, and rendering; unaddressed messages intentionally remain context without waking agents. `pnpm dev:live -- --cwd <absolute-path>` instead loads the sibling Pi Runtime build and exposes an explicit Start action. Starting creates a Channel-isolated Pi session, while execution still waits for a later addressed message. Coordinated Ctrl-C shutdown removes temporary data and stops sessions created by live disposable mode. Neither mode is production authentication.

## Foundation slice

- React, TanStack Router, TanStack Query, Tailwind, and Vite.
- Radix Dialog for accessible mobile drawers, matching the proven MinuNotes primitive approach.
- MinuNotes-inspired responsive sidebar shell and flat technical visual language.
- Explicitly labeled Workspace sections and names in navigation and Channel headers.
- Durable Channel names as primary labels; opaque ids remain routing details.
- Channel timeline ordered by monotonic sequence.
- Race-free SSE startup: subscribe, wait for `ready`, refetch, then merge by message id.
- Revision-aware roster refresh.
- Authenticated browser session bound to one stable current-human identity; composer authorship is automatic and offers no impersonation selector.
- Focused Workspace source dialog plus a dedicated Workspace Agents route. The Agents page combines readable/editable Workspace-local handle, public role, and delegation guidance with redacted/write-only Runtime, model, reasoning, persona, and status administration; it also shows Channel assignments and private binding counts.
- Owner/admin participant creation inside Manage Channel participants with human, agent, or service type; suggested/paste-safe handle; display name; public role; and inline Runtime/persona setup for execution identities.
- Named Channel creation from selected active Workspace members.
- Existing-Channel participant administration with optimistic roster revisions and conflict recovery.
- Explicit Start, Start fresh (generation-fenced replacement), and Stop actions with confirmation, bounded pending/error state, and redacted status refresh.
- Safe Markdown/GFM rendering for agent-authored responses only; human-authored messages remain plain text for now. Raw HTML and remote image loading are disabled.
- Historical timeline attribution resolved from stable Workspace identities after roster removal.
- Plain-text composer with mention suggestions and structured targets. In a two-participant human-agent Channel, an ordinary human message implicitly targets the sole bound agent; larger Channels require a mention.
- Enter-to-send interaction; Shift+Enter and Cmd/Ctrl+Enter insert line breaks without breaking IME or mention selection.
- Desktop roster rail and mobile roster drawer.
- Explicit connecting/live/disconnected state and manual retry.

## API boundary

The public API is already sufficient for the foundation UI:

```http
GET /identities
POST /identities
GET /workspaces
POST /workspaces/:id/members
GET /workspaces/:id/channels
POST /channels
GET /channels/:id
PATCH /channels/:id/participants
GET /channels/:id/messages
POST /channels/:id/messages
GET /channels/:id/events
```

The current localhost boundary is implemented as `@minu/channels-control`. It provides browser-safe contracts/client exports, a Node server facade over structural Channel, binding, and Runtime status ports, and the current daemon/launcher. Under the accepted product direction this is a transitional internal agent-host package, not an independent product or alternate work path. Channels core and the browser may not import agent-host, Runtime, daemon, or server modules.

Current endpoints are capability-oriented rather than raw storage CRUD:

```http
GET   /local/session
GET   /local/health
GET   /local/capabilities
GET   /local/channels/:id/agents
POST  /local/channels/:id/agents/:identityId/start
POST  /local/channels/:id/agents/:identityId/replace
POST  /local/channels/:id/agents/:identityId/stop
GET   /local/workspaces/:workspaceId/config
PATCH /local/workspaces/:workspaceId/config
PATCH /local/workspaces/:workspaceId/agents/:identityId/config
```

Private configuration reads return only configured flags, status, and bound-Channel counts. Workspace root, notes routing, persona prompt, and Runtime adapter are write-only inputs; successful or rejected updates emit audit metadata without values. The bound human must be an active Workspace owner/admin. Persona/Runtime edits apply only to new or explicitly replaced sessions.

The agent response reports `unbound | idle | running | offline | disabled | uncertain`, wake policy, and disabled command capability flags without Runtime session IDs, adapter names, leases, credentials, prompts, roots, or database paths. The web roster polls this optional API every five seconds while available, retries a missing service more slowly, and shows local Runtime state separately from public membership. Messaging continues and the roster labels local status unavailable when the service cannot be reached.

The real daemon now requires a browser session. A 256-bit one-time code valid for 60 seconds is redeemed at a loopback bootstrap endpoint for a separate random, HttpOnly, SameSite=Strict `/local` cookie bound to the configured stable human identity. `GET /local/session` returns only that public identity id. The composer verifies active human Channel participation, keys drafts to that identity, and always uses it as the message author even if stale author-selection local storage is present. The credential is never placed in a URL, remains only in daemon memory, expires after eight hours, and is revoked by daemon restart. Browser and control use the same loopback hostname. This prevents accidental browser impersonation but is not public API authorization. Sanitized audit events record session issuance and rejection without recording either secret or private execution metadata. Playwright proves binding across refresh, authorship despite stale impersonation state, cookie bootstrap, and Vite `/local` proxy.

Private configuration writes and their administration UI are implemented. Agent administration lives at `/app/workspaces/:workspaceId/agents`; general Workspace settings retain only source configuration, while Channel-specific Start/Start fresh/Stop remains in each Channel. Forms never prefill saved source, persona, or Runtime values and clear replacement inputs after success. Active owners/admins create participants inside **Manage Channel participants**, where the new identity is added to the Workspace and selected for the current Channel in one flow. Display names suggest a handle, pasted leading `@` characters are normalized, and agent/service creation includes a required Runtime preference plus optional write-only persona. If restricted configuration fails after public identity/member creation, the UI reports that the participant was added and needs configuration rather than retrying into a duplicate identity. These collaboration writes still use the unauthenticated public Channels API, so local browser gating is advisory until hosted authentication exists. Runtime start, replace, and stop derive their actor from the authenticated browser session; responses remain redacted and audit events contain no root, persona, adapter, or session values. The replace operation is presented as **Start fresh** because it creates a new empty Runtime transcript rather than replacing the agent identity or Channel history. Start fresh is unavailable during active Channel work, starts from current configuration, generation-fences the old binding, and discards pre-replacement pending work. Stop confirms that side effects remain, fences output before process termination, and presents the binding as stopped/disabled. Steering, interruption, reconnect, and control-plane identity creation remain disabled until command-specific authorization, audit, fencing, and confirmations are implemented.

## Deferred

- Authentication and hosted deployment. Do not add a client-only login facade while Channels requests remain unauthenticated. When server authentication is introduced, reuse the MinuNotes Better Auth email-OTP/session pattern and bind the authenticated account to a Channels human identity.
- Runtime steering, interruption, and reconnect controls beyond the implemented start/replace/stop operations.
- Separately named launch profiles shared across agents, arbitrary provider-option schemas, and optional Channel working scopes beyond the implemented per-Workspace-agent model/reasoning profile; see [`execution-configuration.md`](execution-configuration.md).
- Reusing an existing global identity in another Workspace; Workspace member editing, disablement, role changes, and hosted authorization beyond the implemented Channel-focused creation flow.
- Channel rename.
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
- Bounded Channel history in every triggered turn, including older context that precedes the agent binding cursor; the cursor suppresses replay but does not hide conversation context.
- Playwright coverage against a real seeded Channels server for message send, Workspace participant creation, named Channel creation, optimistic participant replacement, historical attribution, Runtime start/replace/stop confirmations, roster revision, disconnect catch-up, stable retry keys, and accessible mobile drawers.
