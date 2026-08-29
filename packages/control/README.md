# @minu/channels-control

**Status:** Transitional internal MinuChannels agent-host package; not planned as an independently published product in the MVP.

Authenticated, loopback-only, presentation-safe boundary used by the current MinuChannels local composition. Product review established that normal work should follow `UI ⇄ Channels ⇄ agent host ⇄ Runtime`; this package is limited to browser-session bootstrap, private product setup, safe local presentation status, diagnostics, and composition support. Its Relay/control/private-storage responsibilities will be consolidated behind an internal agent-host boundary during the live-agent vertical slice.

The current API keeps normal work out of control while supporting private product setup:

```http
GET   /local/session
GET   /local/health
GET   /local/capabilities
GET   /local/channels/:channelId/agents
POST  /local/channels/:channelId/agents/:identityId/start
POST  /local/channels/:channelId/agents/:identityId/replace
POST  /local/channels/:channelId/agents/:identityId/stop
GET   /local/workspaces/:workspaceId/config
PATCH /local/workspaces/:workspaceId/config
PATCH /local/workspaces/:workspaceId/agents/:identityId/config
```

It combines the public Channel roster with private binding and Runtime reachability internally, then returns only UI-safe state:

- stable Workspace, Channel, and identity IDs;
- `unbound`, `idle`, `running`, `offline`, `disabled`, or `uncertain` state;
- wake policy;
- start for unbound agents, replace for idle/offline/stopped agents, and stop for bound agents when managed execution is available;
- disabled steering, interruption, and reconnect capability flags;
- last verification timestamp when available.

Workspace configuration summaries return only `configured` booleans, status, and bound-Channel counts. Root URI, notes-folder routing, persona prompt, and Runtime adapter are write-only inputs: they are persisted in private local storage but never returned. It never returns Runtime session IDs, adapter names, leases, credentials, prompts, local roots, or private database paths.

## Exports and executable

- `@minu/channels-control/contracts` — browser-safe DTOs.
- `@minu/channels-control/client` — browser-safe HTTP client.
- `@minu/channels-control/server` — Node loopback service, HTTP server, and session primitives.
- `@minu/channels-control/daemon` — real local composition over Channels HTTP and Relay storage.
- `@minu/channels-control/review` — disposable seeded review backend.
- `minu-channels-control` — local control launcher executable.
- `minu-channels-review` — coordinated developer review launcher.

The daemon opens the private Relay database, connects to the public Channels endpoint, accepts structural status-only or managed Runtime adapters, restores reachable bindings under leases, and always enables browser-session authentication. Managed adapters may start one isolated session per `(Workspace, Channel, agent)` and are connected to normal Channel delivery by the internal agent host. Browser bundles continue to import only `client` and `contracts`.

## Browser-session launch

The launcher creates a 256-bit, one-time launch code with a 60-second default lifetime. Redeeming it at the loopback bootstrap endpoint:

1. consumes the code exactly once;
2. issues a separate random browser session bound to the configured stable human identity in an `HttpOnly`, `SameSite=Strict`, `/local` cookie;
3. redirects to the clean configured web URL with `Referrer-Policy: no-referrer`.

`GET /local/session` returns only the bound public identity id. The composer verifies that it is an active human participant and uses it automatically; arbitrary `Send as` selection is unavailable. The browser session credential is never placed in a URL. It expires after eight hours by default and is kept only in daemon memory, so daemon restart revokes it. The browser and daemon must use the same loopback hostname because cookies do not cross `localhost`, `127.0.0.1`, and `[::1]` aliases.

Session lifecycle events are emitted through a sanitized audit hook. Events record action, outcome, timestamp, and a bounded rejection reason—never launch codes, cookies, Runtime identifiers, or private configuration.

## Review the current app

From the repository root:

```bash
pnpm dev
```

This builds the workspace and coordinates disposable in-memory Channels data, temporary private Relay storage, the authenticated control daemon, a real `ChannelRuntimeRelay`, and Vite. It seeds one Workspace and Channel with `@you`, `@builder`, and `@reviewer`, sample messages, a simulated builder binding, and an unbound reviewer; then it opens the authenticated Channel. Mention `@builder` to exercise real structured routing, Relay delivery, atomic response posting, SSE delivery, and timeline rendering. Unaddressed messages intentionally remain context without waking the agent. Ctrl-C terminates Relay, the Vite process group, both loopback servers, and temporary storage.

Review mode demonstrates the application and Relay boundary. The `review-mode` Runtime response is deterministic—not live model execution. Use `pnpm dev -- --no-open` for a manual one-time URL, and pass custom ports after `--` if defaults are occupied. `pnpm app:review` is the explicit equivalent; `pnpm web:dev` remains frontend-only.

For the genuine Pi vertical slice:

```bash
pnpm dev:live -- --cwd /absolute/path/to/workspace
```

The current development command builds the sibling MinuRuntime repository, loads `PiAgentRuntime`, and seeds write-only root, persona, and `pi` adapter configuration without creating a session. The owner explicitly clicks **Start** for `@builder`; the agent host then starts Pi with the configured directory and `appendSystemPrompt`, persists and leases the private binding, advances the new binding past historical Channel messages, and starts Relay. A later `@builder` message produces a genuine response through Channels. **Replace** starts a fresh session from current private configuration only when Channel agent work is idle, compare-and-swaps the binding generation, advances recovery to the current head, rebuilds Relay, and best-effort stops the prior Runtime. **Stop** first increments the generation and disables the binding so stale output is fenced, then stops the process and removes it from Relay. Both actions require confirmation because transcripts do not carry over and filesystem effects remain. `pnpm app:live` is the explicit alias. Disposable live shutdown stops sessions created by that composition.

## Run services individually

Build first, start Channels and the web client, then launch control:

```bash
pnpm build
pnpm serve
pnpm web:dev
pnpm control --human-identity-id <stable-human-id>
```

The default composition uses:

```text
Channels: http://127.0.0.1:4310
Web:      http://127.0.0.1:5174/
Control:  http://127.0.0.1:4311
Relay DB: ~/.minu/channels/relay.db
```

Use `--no-open` to print the short-lived one-time launch URL instead of invoking the platform browser opener.

Runtime integrations stay optional and structural:

```bash
pnpm control --human-identity-id <stable-human-id> --runtime-adapter \
  'pi=/absolute/path/to/runtime/packages/pi/dist/src/index.js#PiAgentRuntime'
```

A loaded export may be a constructible class or an object with `status(sessionId)`. A module may instead expose `localControlRuntime`, a default runtime object, or `createLocalControlRuntime()`. Status-only adapters support projections; adapters also exposing `start`, `send`, and `messages` support explicit session start and Relay execution. Adapter modules are trusted local code and are loaded only when explicitly configured.

## Local hardening

- Binds only to `127.0.0.1` or `::1`.
- Rejects non-loopback `Host` headers.
- Rejects browser origins unless explicitly allowlisted.
- Requires an authenticated browser session in the real daemon.
- Limits writes to bounded JSON private-configuration endpoints authorized for the bound active Workspace owner/admin.
- Uses bounded Runtime/client waits, no-store responses, and sanitized errors.
- Stores private Relay state only in a local file URL.

Loopback plus a bound browser session is still not hosted-user authentication. It prevents accidental UI impersonation and authorizes machine-local private configuration plus explicit Runtime start/replace/stop; it cannot authorize direct public Channels API requests. Lifecycle operations emit secret-free accepted/rejected audit events and are restricted to active owner/admin browser sessions, active Channel agents, local directories, and registered managed adapters. Replace uses generation compare-and-swap and refuses active Channel work; Stop fences the binding before process termination and warns that external side effects remain. Steering, interruption, reconnect, and identity creation remain disabled until their command-specific confirmation and recovery behavior are implemented. Do not expand this package into a parallel browser work API; normal work and safe operational results belong in Channels.
