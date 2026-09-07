# MinuChannels

MinuChannels is a local-first collaboration app where humans and coding agents work together in shared Channels.

It runs on one computer, stores product data locally, and uses [MinuRuntime](https://github.com/minuscule-labs/runtime) to execute isolated agent sessions through Pi.

> [!IMPORTANT]
> MinuChannels is currently a single-user, loopback-only alpha for macOS and Linux. Do not expose its ports to another machine or an untrusted local user.

## What it includes

- Persistent Workspaces, Channels, messages, and membership
- Reusable human, agent, and service identities
- Live updates, mentions, Markdown, syntax highlighting, and code-copy controls
- Per-agent instructions, Skills, harness, provider, model, and reasoning settings
- Explicit **Start**, **Start fresh**, and **Stop** controls for agent sessions
- Workspace and Channel administration with native folder selection
- Product-isolated local storage, recovery, locking, and checksum-verified updates
- A self-contained release package with the web app, migrations, and pinned Runtime

See [Product boundary](docs/product-boundary.md) for what belongs to the MVP and what remains future work.

## Install a release

Requirements:

- macOS or Linux
- Node.js 22 or newer
- Pi installed, authenticated, and available as `pi` on `PATH`

Download the `.tgz` and `SHA256SUMS` from the approved [GitHub Release](https://github.com/minuscule-labs/channels/releases), verify the checksum, then install:

```bash
npm install -g ./minu-channels-0.0.2.tgz
minu-channels /absolute/path/to/workspace
```

The first launch creates a local human, a configured but stopped `@builder` agent, the selected Workspace, and an empty **General** Channel. Start the agent from the UI when ready.

Useful commands:

```bash
minu-channels --version
minu-channels paths
minu-channels doctor
minu-channels update --check
```

For installation, upgrades, backup, restore, reset, and uninstall instructions, see [Installing a local alpha release](docs/local-release.md).

## Run from source

This repository expects the [`runtime`](https://github.com/minuscule-labs/runtime) repository beside it:

```text
minuscule-labs/
├── channels/
└── runtime/
```

Install dependencies in both repositories, then start a persistent local Workspace:

```bash
pnpm install
pnpm local -- /absolute/path/to/workspace
```

On an interactive first launch, omitting the path opens onboarding. Use `.` for the current directory, `--workspace-name` to override the inferred name, `--no-open` to print the one-time browser URL, or `--data-dir` for an independent installation.

For a disposable seeded review environment:

```bash
pnpm dev
```

For that review flow with genuine Pi execution:

```bash
pnpm dev:live -- /absolute/path/to/workspace
```

## Local data and security

The default data directory is:

```text
~/.minu/channels/
```

Override precedence is `--data-dir`, `MINU_CHANNELS_HOME`, `$MINU_HOME/channels`, then the default. Collaboration data and private execution configuration are stored separately inside this product directory with owner-only permissions.

The production app binds its sockets to `127.0.0.1` and advertises `http://minu-channels.localhost:47412/`. The reserved `.localhost` name stays on this computer and gives Channels its own browser-cookie namespace. Internal Channels and control ports default to `47410` and `47411`. All three ports remain configurable.

A one-time browser bootstrap enforces Host and Origin policy and protects direct collaboration traffic with a private service credential. Agent instructions, source paths, Runtime sessions, and credentials are not exposed through public collaboration metadata.

## Architecture

```text
Browser ⇄ Channels HTTP/SSE ⇄ agent host ⇄ MinuRuntime ⇄ Pi
```

The public Channels core remains communication-only. The product composes it with private agent configuration, Relay delivery, local control, and the independently reusable MinuRuntime execution layer.

Workspace agents can participate in multiple Channels. Each Channel binding owns an isolated Runtime session and transcript. Addressed messages wake agents; ordinary messages in a two-participant human-agent Channel implicitly address the sole agent.

## Packages

- `core` — Channel model, storage interface, HTTP/SSE service, and client
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
