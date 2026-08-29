# MinuChannels Product Boundary

**Status:** Accepted MVP direction

## BLUF

MinuChannels ships as one complete product from human UI through agent execution. Relay, private bindings, local control, and Runtime lifecycle are internal modular subsystems until real non-Channels consumers justify extraction. MinuRuntime remains independently reusable; the public Channels core remains communication-only and never executes agents directly.

## User mental model

Users install and operate one product:

```text
MinuChannels
├── Web UI
├── Channels server
├── Workspace, Channel, human, and agent administration
├── Private Workspace agent configuration and personas
├── Agent host (current Relay + control + private binding storage)
├── Runtime adapter integration
└── Local supervisor / packaged application
```

The product must coordinate these components. Users should not need to understand or manually launch internal packages.

Process placement is not a product boundary. A capability may run in one process, a loopback companion, a hosted service, or another machine without changing the UI/domain model. `/local` is a provisional internal route namespace, not a promise that Workspace configuration is conceptually machine-local.

Use precise data categories rather than an overloaded public/private split:

- **Collaboration data:** identities, handles, roles, Channels, messages, and sanitized activity visible to permitted participants.
- **Restricted Workspace configuration:** personas and desired Runtime behavior used by administration and session startup but not shown in conversations.
- **Internal execution state:** Runtime session ids, bindings, generations, leases, process state, and recovery metadata.
- **Secrets:** credentials, provider tokens, and key material.

Local roots are host configuration rather than secrets, but should not be reflected into conversations or ordinary browser responses. Current unauthenticated Channels APIs must not claim access-controlled confidentiality.

## Canonical work flow

```text
UI ⇄ Channels Server ⇄ Agent Host / Relay ⇄ Runtime sessions
```

1. The current human sends a Channel message or explicit command.
2. Channels durably stores and emits the shared intent.
3. The internal agent host consumes addressed work and resolves the Workspace, Channel, agent, persona, and isolated Runtime binding.
4. MinuRuntime executes the turn.
5. The agent host commits the sanitized response or command result through Channels.
6. Channels delivers it to every participant through the normal event stream.

Runtime A/B/C may be different harness adapters or isolated sessions of the same harness. The binding key remains `(workspaceId, channelId, agentIdentityId)` so transcripts never cross Channel boundaries.

## Product ownership

MinuChannels owns:

- reusable human, agent, and service identities;
- Workspaces and named Channels;
- membership, handles, public roles, and delegation profiles;
- private Workspace-level agent personas and Runtime preferences;
- assignment of agents to Channels;
- one isolated Runtime binding per agent and Channel;
- Relay wake, context, response, recovery, and fencing behavior;
- safe activity/status projections and command results;
- current-human browser authorship;
- the supervisor, setup flow, and complete user experience.

MinuRuntime owns harness-neutral execution, sessions, messages, stable turns, steering, interruption, and adapter implementations.

Channels core owns durable communication only. It does not import Runtime or execute agents. Product composition connects core to the internal agent host through explicit ports.

## Private configuration

Private personas, local roots, credentials, Runtime session ids, adapters, leases, and recovery metadata are product-owned but are not public Channel data. They must not appear in public Workspace/Channel metadata, messages, SSE payloads, or browser bundles.

The product may store them in local private storage for a local deployment or an authenticated secrets/configuration service for a hosted deployment. The agent host receives them through an internal launch specification and passes persona instructions to Runtime with `appendSystemPrompt` by default.

## Internal package direction

Current packages were intentionally separated while discovering contracts:

```text
packages/relay
packages/relay-storage-drizzle
packages/control
```

Before publishing, consolidate their product responsibilities behind an internal agent-host boundary while preserving browser/server and public/private dependency safety:

```text
packages/agent-host
  Relay processing and context
  private Workspace agent configuration
  Channel-specific Runtime bindings
  lifecycle, leases, recovery, and diagnostics

packages/agent-host-client
  presentation-safe browser contracts where still required

apps/local
  supervisor, web/API composition, setup, and review/development modes
```

Exact package names may change during the live-agent vertical slice. Do not extract a separate Relay repository yet.

## Extraction rule

Extract Relay/agent-host as an independent product only when evidence exists:

1. A second real non-Channels product needs it.
2. Multiple source adapters reveal a stable generic work contract.
3. It requires independent deployment, scaling, security ownership, or release cadence.
4. The extraction reduces rather than increases product complexity.

Potential future consumers such as MCP, Slack, Cowork, or other services are not sufficient by themselves to justify a generic abstraction now.

## Immediate implementation sequence

1. ~~Bind the browser session to the current human and remove per-message author selection.~~ Implemented with a presentation-safe `/local/session` projection; public Channels authorization remains future work.
2. Consolidate Relay/control/private storage responsibilities behind the internal agent-host interface as needed by implementation—not as a standalone extraction project.
3. ~~Add authenticated private Workspace root, persona, and Runtime configuration with redacted reads.~~ Internal agent-host API, persistence, and administration UI are implemented.
4. ~~Add Channel creation, participant assignment, and existing-Channel membership mutation.~~ Implemented with named Channels, selected active Workspace members, optimistic roster revisions, SSE refresh, and preserved historical author identity.
5. Start and bind a live Pi Runtime session from the product.
6. Prove `UI → Channels → agent host → MinuRuntime → Channels → UI` with a genuine response.
7. Package persistent local startup behind one product supervisor; address hosted authentication afterward.
