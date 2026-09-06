# Agent Skills

**Status:** Harness discovery, per-agent selection, persistence, and new/Start fresh session loading are implemented. Explicit invocation, Channels-authored skills, and dynamic session mutation are fast follows.

## BLUF

MinuChannels selects which harness-provided skills an agent may use; the harness remains responsible for discovering, loading, and executing them. Selected skills are fixed when a Runtime session starts. Agents may use enabled skills autonomously through normal harness behavior. MinuChannels does not create its own executable skill format for MVP.

## MVP contract

The MVP flow is:

```text
Harness discovers skills
        ↓
Channels shows the sanitized catalog
        ↓
Workspace owner selects skills for an agent
        ↓
New or Start fresh session receives those selections
        ↓
Harness exposes compact metadata and loads skill instructions when needed
```

The Runtime capability contract should expose a harness-neutral descriptor containing:

- a stable adapter-scoped skill id;
- a user-facing name and description;
- availability or compatibility state; and
- no credential values or unnecessary host paths.

The Runtime start contract should accept selected skill ids. Each adapter resolves those ids to its native representation and revalidates them at launch. For Pi, that means translating selections to Pi skill inputs while keeping filesystem paths inside Runtime and the private agent host.

Selected skill ids are restricted Workspace-agent configuration. Browser reads may return the selected ids and sanitized availability because they are not secrets, but skill source paths, credential-related errors, and private skill contents should not enter collaboration messages or public Channels metadata.

Configuration changes apply only to new or **Start fresh** sessions. Existing sessions retain the skill set with which they were initialized. If a selected skill is no longer available, launch fails with a sanitized, actionable configuration error instead of silently dropping it.

## Context behavior

Enabling a skill does not require placing its complete contents in every prompt. A harness may expose compact name/description metadata to the model and load the complete instructions only when the model determines that the skill applies. MinuChannels should preserve this harness-native lazy-loading behavior rather than expanding every skill into the Channel transcript or agent instructions.

An enabled skill is available for autonomous agent use. User-directed invocation is a separate interaction feature and is not necessary for the initial execution contract.

## Fast follows

The following are explicitly outside the MVP:

### Explicit slash-command invocation

A future composer may discover callable skills and offer commands such as:

```text
/code-review packages/control
/skill code-review packages/control
```

Channels should parse this into a structured invocation and let the Runtime adapter translate it. It should not depend on sending an undocumented raw command string to every harness. Explicit invocation complements autonomous use; it does not replace the metadata agents need to discover capabilities.

### Dynamic session mutation

Adding or removing skills from an already-running session is deferred. It requires adapter support, an auditable update protocol, and clear behavior for in-progress turns. Until then, the UI must explain that **Start fresh** applies changed selections.

### Workspace-authored skills

A future Workspace may own reusable instruction-only playbooks. These require stable ids, versions or content hashes, provenance, permission checks, and adapter materialization. The first version should not execute arbitrary bundled scripts.

### Channel-derived skills

Channel-level skills are not planned without evidence that the same agent repeatedly needs a different reusable procedure in different Channels. Ordinary conversation history, linked documents, and Channel instructions are context—not automatically skills. If introduced later, Channel skills should be explicitly attached, versioned, visible to administrators, and snapshotted when a session starts rather than silently changing agent behavior.

### Executable skills and installation

Skill installation, arbitrary scripts, network capabilities, marketplaces, trust prompts, signing, and permission grants are separate security-sensitive product areas. Harness credential and execution policy remains harness-owned unless Channels deliberately introduces a broader capability-management system.

## Future-compatible identity

If Channels later supports multiple skill sources, the durable reference should distinguish adapter and provenance, conceptually:

```text
(runtimeAdapter, source, skillId, version?)
```

Possible sources are `harness`, `workspace`, and eventually `channel`. The MVP only implements `harness`. This shape should not require exposing local skill paths or adopting Pi-specific command names as global identifiers.

## Promotion rule

Promote a fast follow only when usage demonstrates its need:

- add slash invocation when users need deterministic skill activation;
- add dynamic mutation when restarting sessions is materially disruptive;
- add Workspace-authored skills when teams repeatedly duplicate the same playbook outside Channels; and
- add Channel-derived skills only when Channel-specific procedures cannot be represented cleanly as context or agent instructions.
