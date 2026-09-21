# MinuChannels

MinuChannels is a local-first collaboration app where humans and coding agents work together in shared Conversations.

It runs on one computer, stores product data locally, and uses [MinuRuntime](https://github.com/minuscule-labs/runtime) to execute isolated agent sessions through Pi.

> [!IMPORTANT]
> MinuChannels is currently a single-user, loopback-only alpha for macOS and Linux. Do not expose its ports to another machine or an untrusted local user.

## What it includes

- Persistent Workspaces, Conversations, messages, and membership
- Reusable human, agent, and service identities
- Live updates, mentions, Markdown, syntax highlighting, and code-copy controls
- Per-agent instructions, Skills, harness, provider, model, and reasoning settings
- Explicit **Start**, **New session**, and **Stop** controls for agent sessions
- Conversation **Snooze**, **Archive**, and explicit **Reopen** lifecycle controls
- Workspace and Conversation administration with native folder selection
- Product-isolated local storage, recovery, locking, and checksum-verified updates
- A self-contained release package with the web app, migrations, and pinned Runtime

See [Product boundary](docs/product-boundary.md) for what belongs to the MVP and what remains future work. See the [web bundle performance backlog](docs/web-performance.md) for the deferred client-load optimization plan.

## Install a release

Requirements:

- macOS or Linux
- Node.js 22 or newer
- Pi installed, authenticated, and available as `pi` on `PATH`

Download the `.tgz` and `SHA256SUMS` from the approved [GitHub Release](https://github.com/minuscule-labs/channels/releases), verify the checksum, then install:

```bash
npm install -g ./minu-channels-0.0.6.tgz

# macOS background service
minu-channels start
minu-channels open

# Linux or explicit foreground operation
minu-channels run
```

On macOS, `start`, `stop`, `restart`, `status`, and `open` manage a user-owned background service. `restart` refuses while an agent turn is active; `restart --when-idle` stops admitting new turns, lets already-active work finish, and leaves queued Conversation work durable for recovery after restart. A checksum-verified global npm `update` safely coordinates the selected service and restarts it only when it was previously running; foreground or unrelated service instances block executable replacement. Login startup remains off until `minu-channels enable-login`; `disable-login` reverses it, and `remove-service` unregisters the service without deleting product data. `minu-channels run` is the explicit foreground command, while bare `minu-channels` remains its compatibility alias.

The authenticated browser opens first-run onboarding. Choose a local source folder and name to create your first Workspace and its empty **General** Conversation; the source path remains private.

Useful commands:

```bash
minu-channels --version
minu-channels paths
minu-channels doctor
minu-channels status
minu-channels update --check
```

For installation, upgrades, backup, restore, reset, and uninstall instructions, see [Installing a local alpha release](docs/local-release.md).

## Run from source

This repository expects the [`runtime`](https://github.com/minuscule-labs/runtime) repository beside it:

```text
minuscule-labs/
├── conversations/
└── runtime/
```

Install dependencies in both repositories, then start a persistent local Workspace:

```bash
pnpm install
pnpm local
```

Normal launch opens browser onboarding when no Workspace exists. Passing a path remains a non-interactive shortcut that creates the initial Workspace and Builder agent. Use `.` for the current directory, `--workspace-name` to override the inferred name, `--no-open` to print the one-time browser URL, or `--data-dir` for an independent installation.

For a persistent development app rooted in this checkout:

```bash
pnpm dev
```

Development state is isolated at `~/.minu/channels-dev` and survives restarts. Clear it explicitly while the development app is stopped:

```bash
pnpm dev:reset
```

For a disposable seeded review environment, use `pnpm dev:review`. For the disposable review flow with genuine Pi execution:

```bash
pnpm dev:live -- --cwd /absolute/path/to/workspace
```

## Local data and security

The default data directory is:

```text
~/.minu/channels/
```

Override precedence is `--data-dir`, `MINU_CHANNELS_HOME`, `$MINU_HOME/channels`, then the default. Collaboration data and private execution configuration are stored separately inside this product directory with owner-only permissions.

The production app binds its sockets to `127.0.0.1` and advertises `http://minu-channels.localhost:47412/`. The reserved `.localhost` name stays on this computer and gives Conversations its own browser-cookie namespace. Internal Conversations and control ports default to `47410` and `47411`. All three ports remain configurable.

A one-time browser bootstrap enforces Host and Origin policy and protects direct collaboration traffic with a private service credential. Agent instructions, source paths, Runtime sessions, and credentials are not exposed through public collaboration metadata.

## Architecture

```text
Browser ⇄ Conversations HTTP/SSE ⇄ agent host ⇄ MinuRuntime ⇄ Pi
```

The public Conversations core remains communication-only. The product composes it with private agent configuration, Relay delivery, local control, and the independently reusable MinuRuntime execution layer.

Workspace agents can participate in multiple Conversations. Each Conversation binding owns an isolated Runtime session and transcript. Addressed messages wake agents; ordinary messages in a two-participant human-agent Conversation implicitly address the sole agent.

Relay delivery uses one absolute per-trigger retry budget across Runtime and Conversation operations. Transient network, timeout, `408`, `425`, `429`, and `5xx` failures retry within that budget; other authenticated `4xx` responses are permanent. If a generic public terminal outcome cannot be committed, the private Relay store atomically records a sanitized dead letter and advances the durable cursor so poison delivery cannot block later work.

## Packages

- `core` — Conversation model, storage interface, HTTP/SSE service, and client
- `storage-drizzle` — durable Drizzle/libSQL collaboration storage
- `relay` — ordered agent wake-up, context, recovery, and response delivery
- `relay-storage-drizzle` — private agent configuration and Runtime bindings
- `control` — local supervision, authenticated browser gateway, and updater
- `web` — React product client

These are internal boundaries of one product, not separate services users must coordinate.

## Documentation

- [Local release installation and operations](docs/local-release.md)
- [Release process](docs/releasing.md)
- [Distribution model](docs/distribution.md)
- [Product boundary and architecture](docs/product-boundary.md)
- [Execution configuration](docs/execution-configuration.md)
- [Conversation lifecycle and archive behavior](docs/conversation-lifecycle.md)
- [Skills](docs/skills.md)
- [Web client MVP](docs/web-client-mvp.md)
- [Control API and development details](packages/control/README.md)

## Development checks

```bash
pnpm check
pnpm test
pnpm web:test
pnpm web:test:browser
```

Release maintainers should follow [Releasing MinuChannels](docs/releasing.md).

## License

MinuChannels is licensed under the [Apache License 2.0](LICENSE).
