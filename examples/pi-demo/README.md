# Pi collaboration demo

This optional integration example composes independently installed MinuChannels and MinuRuntime packages. It is intentionally excluded from the Channels workspace so Channels can install, build, test, and deploy without Runtime.

For local development, place the `runtime/` and `channels/` repositories beside each other. This private example uses pnpm `link:` dependencies on both repositories:

```bash
pnpm install
pnpm build
pnpm demo --cwd /path/to/project
```

The demo registers a human coordinator, builder, and reviewer as reusable identities; creates a disposable Workspace with local `@you`, `@agent-a`, and `@agent-b` handles; then starts the two Runtime-owned personas and mention-driven relay. Every agent wake-up includes the public participant roster, roles, stable identity ids, and delegation guidance, so the builder can discover the reviewer without a hardcoded peer id.

Interactive commands:

```text
/members
/messages
/status
/steer @agent-a <guidance for active work>
/interrupt @agent-a <replacement instruction>
/quit
```
