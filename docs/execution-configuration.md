# Execution Configuration

**Status:** Accepted direction; Channel working scopes and Runtime launch profiles are documented future work.

## BLUF

MinuChannels owns the execution-configuration experience, while Channels core remains communication-only. A Workspace provides the source and reusable agent defaults. A Channel may later narrow the working directory beneath that source. Each Channel-agent binding still receives an isolated Runtime session.

```text
Workspace
├── private source root
├── reusable agents
│   ├── persona
│   └── default Runtime launch profile
└── Channels
    ├── optional relative working scope
    └── isolated Runtime session per assigned agent
```

## Source scope

The Workspace source root is the default execution boundary. For example:

```text
Workspace: minuscule-labs
Source root: /Users/example/Workspaces/minuscule-labs

#runtime   → runtime/
#channels  → channels/
#release   → Workspace root
```

Channel creation does not require a source path. Channels remain useful for human collaboration without agent execution. Explicit Runtime Start requires a configured Workspace source root.

A future Channel working scope may narrow the Runtime working directory with a relative path. It must:

- default to the Workspace root;
- resolve to an existing directory beneath the Workspace root;
- reject absolute paths, `..` escapes, and symlink escapes;
- apply consistently to every agent session in that Channel unless later evidence justifies a narrower override;
- remain restricted agent-host configuration rather than collaboration metadata;
- expose only a redacted or relative summary in ordinary browser responses; and
- apply to new or explicitly **Start fresh** sessions, never mutate an active session.

This is filesystem scoping, not nested Channels. Conversational threads or subchannels are a separate future product decision.

## Reusable Workspace agents

An identity may be globally stable, but execution configuration is Workspace-local. A reusable Workspace agent owns:

- its Workspace handle and public delegation profile;
- its restricted persona;
- its default Runtime launch profile; and
- membership in any number of Channels.

The same Workspace agent may participate in several Channels, but `(workspaceId, channelId, agentIdentityId)` always maps to a distinct Runtime session and transcript. No global agent session is shared across Channels.

Cross-Workspace identity reuse or cloning remains deferred. If added, each Workspace must supply its own handle, permissions, source access, persona, credentials, and launch profile.

## Runtime launch profiles

The UI should eventually configure reusable launch profiles rather than ask users to “build a Runtime.” A profile may describe:

```text
Name: Pi Deep Review
Adapter: pi
Model: provider/model identifier
Reasoning: high
Additional adapter options: capability-defined, validated values
Credential reference: write-only host reference
```

Useful examples include:

```text
Pi Fast       → pi + faster model + low reasoning
Pi Deep       → pi + stronger model + high reasoning
Review Agent  → Pi Deep + reviewer persona
Builder Agent → Pi Fast + builder persona
```

Profiles belong to restricted Workspace execution configuration. The likely selection hierarchy is:

1. host-registered Runtime adapter and its advertised capabilities;
2. reusable Workspace launch profile;
3. Workspace agent default profile; and
4. a future Channel-agent binding override only if real usage requires it.

Model names, reasoning levels, and provider options must come from adapter capabilities or validated adapter schemas. MinuChannels should not hard-code Pi-specific controls into the collaboration domain. Credentials remain write-only and must never enter collaboration data, messages, SSE, audit values, or ordinary browser responses.

Configuration changes apply only to new or **Start fresh** sessions. Existing sessions retain the launch specification with which they were created.

## Current implementation

The current product supports:

- one private Workspace source root;
- one write-only persona per Workspace agent;
- a Runtime adapter identifier per Workspace agent; and
- isolated Runtime sessions per Channel-agent binding.

It does **not** yet support:

- Channel working-directory scopes;
- named reusable launch profiles;
- adapter capability discovery;
- model selection;
- reasoning-level selection;
- provider-option schemas; or
- per-Channel launch-profile overrides.

MinuRuntime's current start contract accepts `cwd`, `systemPrompt`, and `appendSystemPrompt`; model and reasoning are not currently part of that contract. Adding UI fields before Runtime and adapter capability contracts exist would create settings that cannot be reliably honored.

## Ownership boundary

- **MinuChannels UI:** profile and scope administration, redacted summaries, selection, and lifecycle guidance.
- **Private agent host:** authorization, validation, persistence, launch-spec resolution, audit metadata, and binding lifecycle.
- **MinuRuntime adapter:** capability declaration and faithful execution of validated launch options.
- **Channels core:** identities, membership, Channels, messages, targets, and events only; it never stores private launch configuration or executes agents.

## Promotion rule

Do not implement Channel scopes or profile builders merely because they are plausible. Promote them when local usage demonstrates one of these concrete needs:

- the Workspace root is too broad for safe or useful agent execution;
- users repeatedly maintain the same adapter/model/reasoning combinations;
- different agents require materially different model cost or reasoning behavior; or
- an adapter exposes a stable capability schema that the UI can validate and preserve.
