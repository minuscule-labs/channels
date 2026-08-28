# @minu/channels-control

Authenticated, loopback-only, presentation-safe control boundary for the MinuChannels web client.

The current API remains read-only:

```http
GET /local/health
GET /local/capabilities
GET /local/channels/:channelId/agents
```

It combines the public Channel roster with private binding and Runtime reachability internally, then returns only UI-safe state:

- stable Workspace, Channel, and identity IDs;
- `unbound`, `idle`, `running`, `offline`, `disabled`, or `uncertain` state;
- wake policy;
- disabled command capability flags;
- last verification timestamp when available.

It never returns Runtime session IDs, adapter names, leases, credentials, prompts, local roots, or private database paths.

## Exports and executable

- `@minu/channels-control/contracts` — browser-safe DTOs.
- `@minu/channels-control/client` — browser-safe HTTP client.
- `@minu/channels-control/server` — Node loopback service, HTTP server, and session primitives.
- `@minu/channels-control/daemon` — real local composition over Channels HTTP and Relay storage.
- `minu-channels-control` — local launcher executable.

The daemon opens the private Relay database, connects to the public Channels endpoint, accepts structural Runtime status adapters, and always enables browser-session authentication. Browser bundles continue to import only `client` and `contracts`.

## Browser-session launch

The launcher creates a 256-bit, one-time launch code with a 60-second default lifetime. Redeeming it at the loopback bootstrap endpoint:

1. consumes the code exactly once;
2. issues a separate random browser session in an `HttpOnly`, `SameSite=Strict`, `/local` cookie;
3. redirects to the clean configured web URL with `Referrer-Policy: no-referrer`.

The browser session credential is never placed in a URL. It expires after eight hours by default and is kept only in daemon memory, so daemon restart revokes it. The browser and daemon must use the same loopback hostname because cookies do not cross `localhost`, `127.0.0.1`, and `[::1]` aliases.

Session lifecycle events are emitted through a sanitized audit hook. Events record action, outcome, timestamp, and a bounded rejection reason—never launch codes, cookies, Runtime identifiers, or private configuration.

## Run locally

Build first, start Channels and the web client, then launch control:

```bash
pnpm build
pnpm serve
pnpm web:dev
pnpm control
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
pnpm control --runtime-adapter \
  'pi=/absolute/path/to/runtime/packages/pi/dist/src/index.js#PiAgentRuntime'
```

A loaded export may be a constructible class or an object with `status(sessionId)`. A module may instead expose `localControlRuntime`, a default runtime object, or `createLocalControlRuntime()`. Adapter modules are trusted local code and are loaded only when explicitly configured.

## Local hardening

- Binds only to `127.0.0.1` or `::1`.
- Rejects non-loopback `Host` headers.
- Rejects browser origins unless explicitly allowlisted.
- Requires an authenticated browser session in the real daemon.
- Exposes only read operations after bootstrap in this slice.
- Uses bounded Runtime/client waits, no-store responses, and sanitized errors.
- Stores private Relay state only in a local file URL.

Loopback plus a browser session is still not hosted-user authentication. Steering, interruption, configuration writes, and agent creation remain disabled until command-specific authorization, audit, fencing, confirmation, and recovery behavior are implemented.
