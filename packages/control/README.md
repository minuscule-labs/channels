# @minu/channels-control

Loopback-only, presentation-safe control boundary for the MinuChannels web client.

The first slice is intentionally read-only:

```http
GET /local/health
GET /local/capabilities
GET /local/channels/:channelId/agents
```

It combines the public Channel roster with private binding and Runtime reachability internally, then returns only UI-safe state:

- stable Workspace, Channel, and identity IDs;
- `unbound`, `idle`, `running`, `offline`, `disabled`, or `uncertain` state;
- wake policy;
- command capability flags;
- last verification timestamp when available.

It never returns Runtime session IDs, adapter names, leases, credentials, prompts, local roots, or private database paths.

## Exports

- `@minu/channels-control/contracts` — browser-safe DTOs.
- `@minu/channels-control/client` — browser-safe HTTP client.
- `@minu/channels-control/server` — Node loopback service and HTTP server.

The server accepts structural Channel, binding, and Runtime status ports. It does not require the browser to import Relay or Runtime packages.

## Local hardening

- Binds only to `127.0.0.1` or `::1`.
- Rejects non-loopback `Host` headers.
- Rejects browser origins unless explicitly allowlisted.
- Exposes only `GET` in this slice.
- Uses no-store JSON responses and sanitized errors.

Loopback is not authentication. Steering, interruption, configuration writes, and agent creation remain disabled until browser-session authentication, origin policy, audit, fencing, and confirmation behavior are implemented.
