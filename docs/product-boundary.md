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
3. The internal agent host consumes addressed work and resolves the Workspace, Channel, agent, persona, and isolated Runtime binding. A human message in a two-participant human-agent Channel is implicitly addressed to that sole agent; larger Channels require structured or textual mentions.
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

Private personas, local roots, credentials, Runtime session ids, adapters, leases, and recovery metadata are product-owned but are not public Channel data. They must not appear in public Workspace/Channel metadata, messages, SSE payloads, or browser bundles. [`execution-configuration.md`](execution-configuration.md) is the canonical future contract for Workspace source roots, optional relative Channel working scopes, reusable Workspace agents, and adapter-capability-driven Runtime launch profiles.

The product may store them in local private storage for a local deployment or an authenticated secrets/configuration service for a hosted deployment. The agent host receives them through an internal launch specification and passes persona instructions to Runtime with `appendSystemPrompt` by default.

For the local MVP, collaboration and private execution databases are separate local libSQL files. A hosted database is unnecessary for one user on one machine. Collaboration storage may later use the existing Turso adapter or new PostgreSQL/other adapters through the Channels storage interfaces. Private execution state remains host-local unless a future authenticated agent-host deployment supplies an equivalent restricted store. Database portability is documented future work, not an MVP implementation task.

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

## MVP implementation guardrail

The lifecycle vertical slice is complete. From this point, prefer documenting future behavior over implementing it. MVP implementation is limited to:

1. one reliable foreground product command for startup, status/log visibility, and shutdown;
2. basic reusable identity and Workspace-member creation;
3. Channel rename; and
4. defects or usability problems that block review, installation, or the core collaboration flow.

Do not expand the MVP with richer supervision policy, optional first-mention auto-start, Channel working scopes, Runtime launch-profile builders, model/reasoning controls, pagination/virtualization, worktrees or Git automation, attachment infrastructure, hosted deployment/authentication, additional Runtime adapters, desktop packaging, TUI, advanced activity renderers, or new steering/interruption UI. Keep their intended contracts and safety constraints in documentation, but require evidence from real usage before implementation. This is a scope rule, not a rejection of those future capabilities. [`distribution.md`](distribution.md) is the canonical record for foreground npm/pnpm-dlx packaging, GitHub distribution choices, and the deferred T3-style background-service pattern.

Architecture consolidation is allowed only when required to ship the items above; it is not an independent MVP project. New lifecycle edge cases should generally be documented unless they expose data loss, duplicate execution, authorization failure, secret leakage, stale output, or inability to recover the shipped flow.

## Immediate implementation sequence

1. ~~Bind the browser session to the current human and remove per-message author selection.~~ Implemented with a presentation-safe `/local/session` projection; public Channels authorization remains future work.
2. Consolidate Relay/control/private storage responsibilities behind the internal agent-host interface as needed by implementation—not as a standalone extraction project.
3. ~~Add authenticated private Workspace root, persona, and Runtime configuration with redacted reads.~~ Internal agent-host API, persistence, and administration UI are implemented.
4. ~~Add Channel creation, participant assignment, and existing-Channel membership mutation.~~ Implemented with named Channels, selected active Workspace members, optimistic roster revisions, SSE refresh, and preserved historical author identity.
5. ~~Start and bind a live Pi Runtime session from the product.~~ Implemented through authenticated explicit start, private launch configuration, Channel-isolated binding, durable cursor, lease, and Relay lifecycle.
6. ~~Prove `UI → Channels → agent host → MinuRuntime → Channels → UI` with a genuine response.~~ Verified through the authenticated product start endpoint with Pi returning `LIVE_PI_PRODUCT_FLOW_OK` as Channel sequence 5 through the normal response commit path.
7. ~~Add explicit session replacement and stop with generation fencing, confirmation, and recovery-safe cursor behavior.~~ Implemented through protocol-v4 owner/admin lifecycle commands and verified against genuine Pi.
8. ~~Promote the working demo composition into persistent fresh local startup.~~ `pnpm local -- --cwd <path>` now initializes an empty local Workspace once, persists collaboration and private execution state under `~/.minu/channels`, reopens stable identities and Channels, runs live Pi only after explicit Start, serves the production web build through one loopback product URL, logs in the foreground, and shuts down with Ctrl-C. Replacing the sibling Runtime build/lookup with an installed package remains distribution work.
9. ~~Add basic identity/Workspace-member creation.~~ Owners/admins create reusable humans, agents, or services from Manage Channel participants, with stable handles, public roles, and inline restricted Runtime/persona setup for execution identities; the new member is selected for that Channel in the same flow. Identities remain globally stable records and handles remain Workspace-local. Cross-Workspace reuse/template cloning, member editing, and disablement remain deferred.
10. Add Channel rename.
11. Freeze MVP feature work after the items above, fix release blockers, and validate the product with real use before promoting documented future capabilities into implementation.
