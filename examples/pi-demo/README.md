# Pi collaboration demo

This optional integration example composes independently installed MinuChannels and MinuRuntime packages. It is intentionally excluded from the Channels workspace so Channels can install, build, test, and deploy without Runtime.

For local development, place the `runtime/` and `channels/` repositories beside each other. This private example uses pnpm `link:` dependencies on both repositories:

```bash
pnpm install
pnpm build
pnpm demo --cwd /path/to/project
```

The demo starts a human coordinator, a builder persona, a reviewer persona, and the mention-driven Channel Runtime relay. Every agent wake-up includes the public participant roster, roles, and delegation guidance, so the builder can discover the reviewer without a hardcoded peer id.

Interactive commands:

```text
/members
/messages
/status
/steer @agent-a <guidance for active work>
/interrupt @agent-a <replacement instruction>
/quit
```
