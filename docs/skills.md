# Agent Skills

**Status:** Harness discovery, per-agent selection, persistence, and loading for newly started sessions and **New session** replacements are implemented. [Authored workspace/channel instructions and playbooks](authored-content.md) now have private management APIs/UI. Published standing instructions load into newly created sessions with pinned manifests and Applied/Pending reporting. Explicit authored-playbook invocation, `/skills`, and dynamic mutation remain unfinished.

## BLUF

MinuChannels selects which harness-provided skills an agent may use; the harness remains responsible for discovering, loading, and executing them. Selected skills are fixed when a Runtime session starts. Agents may use enabled skills autonomously through normal harness behavior. MinuChannels does not create its own executable skill format for MVP.

## MVP contract

The MVP flow is:

```text
Harness discovers skills
        ↓
Conversations shows the sanitized catalog
        ↓
Workspace owner selects skills for an agent
        ↓
A newly started session or **New session** replacement receives those selections
        ↓
Harness exposes compact metadata and loads skill instructions when needed
```

The Runtime capability contract should expose a harness-neutral descriptor containing:

- a stable adapter-scoped skill id;
- a user-facing name and description;
- availability or compatibility state; and
- no credential values or unnecessary host paths.

The Runtime start contract should accept selected skill ids. Each adapter resolves those ids to its native representation and revalidates them at launch. For Pi, that means translating selections to Pi skill inputs while keeping filesystem paths inside Runtime and the private agent host.

Selected skill ids are restricted Workspace-agent configuration. Browser reads may return the selected ids and sanitized availability because they are not secrets, but skill source paths, credential-related errors, and private skill contents should not enter collaboration messages or public Conversations metadata.

Configuration changes apply only to newly started sessions and **New session** replacements. Existing sessions retain the skill set with which they were initialized. If a selected skill is no longer available, launch fails with a sanitized, actionable configuration error instead of silently dropping it.

## Context behavior

Enabling a skill does not require placing its complete contents in every prompt. A harness may expose compact name/description metadata to the model and load the complete instructions only when the model determines that the skill applies. MinuChannels should preserve this harness-native lazy-loading behavior rather than expanding every skill into the Conversation transcript or agent instructions.

An enabled skill is available for autonomous agent use. User-directed invocation is a separate interaction feature and is not necessary for the initial execution contract.

## Fast follows

The following are explicitly outside the MVP:

### Explicit slash-command invocation

Native slash invocation remains a future adapter feature. Authored playbooks instead use the gated [`/skills` flow](authored-content.md); no production activation is implied. Future callable native skills might offer commands such as:

```text
/code-review packages/control
/skill code-review packages/control
```

Conversations should parse this into a structured invocation and let the Runtime adapter translate it. It should not depend on sending an undocumented raw command string to every harness. Explicit invocation complements autonomous use; it does not replace the metadata agents need to discover capabilities.

### Dynamic session mutation

Adding or removing skills from an already-running session is deferred. It requires adapter support, an auditable update protocol, and clear behavior for in-progress turns. Until then, the UI must explain that **New session** applies changed selections.

### Workspace-authored skills

Workspaces can now store and publish instruction-only playbooks through authenticated private management APIs, with stable ids, immutable revisions/content hashes, provenance, and owner/admin checks. Authoring UI, guarded private delivery and a gated `/skills` composer flow are implemented. Independent T6 review, separate production activation and T7 intended-use/CI validation remain pending. Launch manifests pin scoped published identities/revisions without injecting full procedures into every prompt. Native adapter materialization is not implied by this contract; no executable bundles or additional permissions are supported.

### Conversation-derived skills

Explicitly authored channel-scoped playbooks are included in the same private management foundation, following the requested channel/workspace feature direction. They are not inferred from messages: ordinary conversation history, linked documents, and Conversation instructions do not become skills automatically. Launch manifests now pin scoped revisions and threads inherit their parent channel's instructions. Operational playbook discovery/invocation remains a later slice; publishing alone changes no running agent.

### Executable skills and installation

Skill installation, arbitrary scripts, network capabilities, marketplaces, trust prompts, signing, and permission grants are separate security-sensitive product areas. Harness credential and execution policy remains harness-owned unless Conversations deliberately introduces a broader capability-management system.

## Future-compatible identity

If Conversations later supports multiple skill sources, the durable reference should distinguish adapter and provenance, conceptually:

```text
(runtimeAdapter, source, skillId, version?)
```

Possible sources are `harness`, `workspace`, and `conversation`. Only `harness` is currently wired to agent execution; private authored documents can already be persisted at workspace/channel scope. This shape should not require exposing local skill paths or adopting Pi-specific command names as global identifiers.

## Promotion rule

Promote a fast follow only when usage demonstrates its need:

- add slash invocation when users need deterministic skill activation;
- add dynamic mutation when restarting sessions is materially disruptive;
- add Workspace-authored skills when teams repeatedly duplicate the same playbook outside Conversations; and
- add Conversation-derived skills only when Conversation-specific procedures cannot be represented cleanly as context or agent instructions.
