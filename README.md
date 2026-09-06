# MinuChannels

> **MVP scope:** Remaining feature work is limited to packaging the proven local command for distribution and release-blocking fixes. Slash-command skill invocation, Channels-authored skills, richer member administration, supervision, hosted auth/deployment, worktrees, additional adapters, advanced controls, pagination, desktop/TUI work, and similar ideas are documented future work—not current implementation tasks. See [`docs/product-boundary.md`](docs/product-boundary.md#mvp-implementation-guardrail) and [`docs/skills.md`](docs/skills.md).

MinuChannels is one complete collaboration product for humans and agents, from responsive UI through isolated agent execution. A Channel is the sole conversation primitive; a direct conversation is simply a two-member Channel.

The public Channels core remains communication-only and does not import Runtime or execute agents. The MinuChannels product composes that core with an internal agent host (the current Relay, private binding storage, and control packages), while independently reusable MinuRuntime executes agent sessions. See [`docs/product-boundary.md`](docs/product-boundary.md) for the accepted MVP ownership and extraction strategy. [`docs/execution-configuration.md`](docs/execution-configuration.md) records the Workspace root → optional Channel scope → isolated agent session hierarchy. Reusable Workspace agents now have private launch profiles with adapter-discovered model, reasoning, and per-agent skill selection plus a persisted, adapter-scoped Workspace model allowlist; named profiles shared across agents and Channel-specific scopes remain future work.

## Start fresh locally

From this repository, start a persistent local Workspace with live Pi execution:

```bash
pnpm local -- --cwd /absolute/path/to/workspace
```

On first launch, MinuChannels creates one local human (`@you`), one configured but unstarted agent (`@builder`), one Workspace named after the source directory, and an empty **General** Channel. It does not create sample messages or execute the model automatically. Click **Start** when ready. In a two-participant human-agent Channel, ordinary human messages implicitly address and wake the bound agent; larger Channels require an explicit mention. Every turn receives bounded Channel history through its trigger, including context written before the binding cursor, without replaying that older work. **Manage Channel participants** lets an owner/admin select existing Workspace members or create a human, agent, or service inline. Handles are suggested from the display name and accept pasted `@handles`; agent/service creation includes agent instructions plus harness, provider, model, and reasoning configuration, then selects the new participant for the Channel. The dedicated Workspace **Agents** page lists reusable agents and opens each agent on a separate detail route for its effective name and handle alongside private agent instructions, harness, provider, model, reasoning, status, Channel assignments, and binding count. **Add agent** creates an agent or service from the list in a modal and then opens its detail page. Owners/admins can edit Workspace-local handles and replace private launch configuration there; launch changes apply only to new or **Start fresh** sessions. Workspace owners can add another Workspace with a private absolute source path, rename existing Workspaces, and replace source paths from Workspace settings. Existing Runtime sessions retain their original working directory until **Start fresh**.

Collaboration data, private agent-host state, and the stable local-human profile persist under the product-owned `~/.minu/channels/` directory with owner-only permissions. Channels never writes shared files directly beneath `~/.minu/`; `--data-dir`, `MINU_CHANNELS_HOME`, and `$MINU_HOME/channels` override the default in that order. A private `run/instance.lock` prevents two Channels servers from writing the same data directory. Re-running the command reopens the same identities, Workspace, Channel, messages, configuration, bindings, and recovery cursors. `--cwd` initializes the private Workspace root on first launch; later changes should use Workspace settings. Press Ctrl-C to stop the foreground product services. Use `--data-dir /other/path` for an independent local installation or fresh test without touching the default data.

This source-workspace command uses the dedicated `minu-channels` foreground entry point and serves the production web build through one loopback product URL; Vite remains review/development-only. [`docs/local-release.md`](docs/local-release.md) covers private-release installation, upgrades, backup, reset, and uninstall. Source development still builds and loads the sibling MinuRuntime repository. The release build instead bundles Runtime core, the Pi adapter and worker, web assets, and both migration trees into one installable artifact. `pnpm release:pack` creates the tarball and checksum; `pnpm release:smoke` installs it in a temporary environment and proves first launch plus persistent reopen. [`docs/distribution.md`](docs/distribution.md) records the private GitHub Release path and deferred public distribution options.

A hosted database is not needed for one person on one computer. Collaboration storage already has a libSQL/Turso adapter, while private execution state intentionally remains local. PostgreSQL and other collaboration adapters are future portability work; Channels core depends on storage interfaces rather than a specific database.

## Review the app

From this repository, launch a disposable seeded review Workspace with one command:

```bash
pnpm dev
```

The command builds the workspace, starts disposable Channels data, the authenticated local control daemon, a real Relay worker, and the Vite web client, then opens the seeded Channel in your browser. It includes `@you`, `@builder`, and `@reviewer`, sample timeline messages, one simulated builder binding, and one unbound agent so the primary UI states are visible. Mention `@builder` to receive a deterministic simulated response through the real mention → Relay → response path; unaddressed messages remain shared context and intentionally do not wake an agent. Press Ctrl-C to stop every service and remove review data.

This is a functional UI/Relay review harness, not live model execution or a production authentication mode. To print the one-time launch URL instead of opening a browser:

```bash
pnpm dev -- --no-open
```

Use `--cwd`, `--channels-port`, `--control-port`, or `--web-port` after `--` when defaults conflict. `pnpm app:review` remains an explicit alias for the same disposable composition; `pnpm web:dev` starts only the frontend.

To run the same product flow with genuine Pi execution, use the current local polyrepo command:

```bash
pnpm dev:live -- --cwd /absolute/path/to/workspace
```

This builds the sibling MinuRuntime repository, seeds private root/persona/Runtime configuration, and exposes explicit **Start**, **Start fresh**, and **Stop** actions for `@builder`. Starting creates a Pi session isolated to that Channel and advances its cursor past historical messages; Pi does not execute until a later addressed message arrives. Start fresh uses the generation-fenced replace protocol to create a new session with current configuration, skip work accepted before replacement, and stop the old owned Runtime when reachable. Stop fences delivery before terminating the Runtime; tool and filesystem effects are not rolled back. Responses return through Relay and normal Channel delivery. Agent responses render safe Markdown and GFM; human messages remain plain text for now. Shutdown stops sessions started by this disposable live composition. `pnpm app:live` is the explicit alias. The sibling-repository lookup is development scaffolding until MinuRuntime packages are published.

## Packages

- `core` — Channel model, in-memory adapter, HTTP/SSE service, and TypeScript client.
- `storage-drizzle` — durable Drizzle/libSQL storage for local files or Turso, plus the standalone server CLI.
- `relay` — internal agent-host processing: mention-driven context, response delivery, recovery, fencing, and a structural Runtime port.
- `relay-storage-drizzle` — internal agent-host storage for private Workspace agent configuration and Channel-specific Runtime bindings.
- `control` — transitional internal agent-host session, redacted private-configuration, status, and review-composition package; its responsibilities will be consolidated before publishing rather than extracted as a separate product now.
- `web` — responsive React/TanStack/Tailwind product client for Workspace configuration, navigation, live Channel messages, mentions, and rosters.
- `examples/pi-demo` — optional live composition example requiring separately installed MinuRuntime packages.

These packages preserve testable dependency boundaries; they are not separate products users must coordinate. `pnpm local` is the persistent product-level command; `pnpm dev` is the disposable review supervisor.

## Current API

```text
POST /identities
GET  /identities
POST /workspaces
GET  /workspaces
POST  /workspaces/:id/members
GET   /workspaces/:id/members
PATCH /workspaces/:id/members/:identityId
POST /workspaces/:id/channels
GET  /workspaces/:id/channels
POST /channels
GET   /channels/:id
PATCH /channels/:id
PATCH /channels/:id/participants
POST /channels/:id/messages
POST /channels/:id/responses
GET  /channels/:id/messages
GET  /channels/:id/events
```

The transitional internal agent-host control surface currently provides:

```text
GET   /local/session
GET   /local/health
GET   /local/capabilities
GET   /local/channels/:id/agents
POST  /local/channels/:id/agents/:identityId/start
POST  /local/channels/:id/agents/:identityId/replace
POST  /local/channels/:id/agents/:identityId/stop
GET   /local/workspaces/:id/config
PATCH /local/workspaces/:id/config
PATCH /local/workspaces/:id/agents/:identityId/config
```

The real local daemon opens `~/.minu/channels/relay.db`, composes it with public Channels HTTP and explicitly loaded structural Runtime status adapters, and requires a browser session. A random 60-second one-time launch code is exchanged for a distinct eight-hour in-memory session carried by an HttpOnly, SameSite=Strict `/local` cookie. Each session is bound to one stable human identity, and `/local/session` returns only that public identity id so the composer cannot select another author. Private configuration reads return booleans/counts only; root URI, notes routing, persona prompt, and Runtime adapter are write-only browser inputs and never appear in responses or audit events. Workspace configuration requires the bound human to be an active owner/admin. Lifecycle/start capabilities remain disabled. The session credential never appears in a URL and daemon restart revokes it. This is local workflow enforcement, not authorization of the still-unauthenticated public Channels API.

Channels have durable human-readable names scoped by their Workspace; opaque ids remain stable routing keys and URL parameters. New resources use readable type prefixes such as `workspace_`, `channel_`, `message_`, and `identity_` followed by 128 bits of UUID-quality randomness. Existing unprefixed ids remain valid compatibility data. Identities are reusable humans, agents, or services with stable opaque ids. Workspaces assign each identity a case-insensitive local mention handle, simple `owner` / `admin` / `member` access, optional public role label, and delegation profile override. Channels belong to one Workspace and select active Workspace members as participants. Owners and admins can replace that selection with optimistic `expectedRosterRevision`; a stale revision returns `409 Conflict`. Structured message authors and targets store stable identity ids, so removing a participant never rewrites historical attribution; the web timeline resolves former participants through the durable Workspace directory. Body `@handles` resolve through current Channel participation. Profiles remain routing metadata—not private system prompts. Owners and admins may update membership aliases, public routing metadata, and status; only owners may change access roles or update another owner, and the last active owner cannot be disabled or demoted. `actorIdentityId` is currently an advisory policy input—not authentication—so access roles are not security claims until authentication and permission enforcement are added. Messages have a monotonic per-Channel sequence, structured targets, optional replies, and parsed `@participant` / `@channel` mentions. SSE emits `message.created` and `roster.updated` notifications plus periodic keepalive comments so quiet Channels remain connected. Message clients may protect retries with an optional key:

```http
POST /channels/:id/messages
Idempotency-Key: <client-generated-key>
```

The TypeScript client exposes this as `postMessage(channelId, input, { idempotencyKey })`.

## Storage

The default server uses Drizzle ORM and libSQL at:

```text
~/.minu/channels/channels.db
```

Migration `0004_workspace_directory.sql` adds identities, Workspaces, memberships, Channel ownership, and local handles. It conservatively places existing pre-Workspace Channels and participants into a default legacy Workspace while preserving their messages and routing ids. Migration `0005_revisioned_rosters.sql` adds Channel roster revisions, participant status snapshots, and database triggers that prevent concurrent updates from removing the final active Workspace owner. Migration `0006_channel_names.sql` adds durable Channel names and assigns readable compatibility names to existing Channels.

The same adapter accepts a deployed Turso URL and token. In-memory mode remains available for tests and disposable demonstrations.

Automated responses use a dedicated idempotent commit operation. A single database transaction allocates the response sequence, inserts the message, records the `(channel, participant, trigger)` delivery, and advances the processed cursor. Repeating a commit returns the original response without emitting another event. This closes the crash window between response posting and cursor persistence.

Ordinary message creation supports optional, durable idempotency scoped by Channel, author participant, and key. Reusing a key with the same effective payload returns the original message without allocating a sequence or emitting another event; changing that payload returns `409 Conflict`. Distinct keys—and all calls without a key—continue to create distinct intentional messages. Keys must be non-empty and at most 255 UTF-8 bytes. Automated response idempotency remains a separate, unchanged operation.

### Private Relay storage

Machine-local execution configuration is deliberately stored separately at:

```text
~/.minu/channels/relay.db
```

`LocalRelayDirectory` validates shared Workspace, membership, and Channel records before writing private Workspace roots, agent/persona configuration, Runtime preferences, or Runtime session bindings. Migration `0001_private_agent_launch_config.sql` adds the private persona prompt and Runtime adapter preference required for launch; `0002_agent_host_cursors.sql` adds durable per-Channel recovery cursors to the private agent host. One reusable Workspace agent configuration can have one binding per Channel, and every binding has its own Runtime session id and transcript. Configuration edits apply to new or explicitly replaced sessions; they do not rewrite live transcripts. `restoreChannelBindings` verifies Runtime reachability without silently replacing an offline session, acquires a short ownership lease, and returns only the bindings owned by that Relay. Callers renew leases with `startAutoRenew`; generation compare-and-swap prevents stale session replacement. Relay fencing checks run before work and before response delivery, so a process that loses ownership cannot publish stale output or advance the cursor. Already-running tool or filesystem side effects cannot be undone. Runtime ids, roots, personas, adapters, and leases are not exposed by public Channels HTTP or metadata APIs.

## Relay

The relay wakes agents according to membership policy, fetches the current Channel metadata, and supplies every awakened agent with a complete public participant roster plus bounded unseen message context. The roster includes exact mention ids, participant types, display names, roles, delegation profiles, and whether an agent is Runtime-connected. This lets agents select collaborators naturally without hardcoded peer ids. The relay then waits for Runtime work to settle, posts responses, and persists processed cursors. It is an integration layer: Channels core has no dependency on Runtime.

The structural Runtime port optionally supports stable `startTurn` and `turn` operations. When available, the relay derives a turn id from the Channel, participant, and trigger message, then recovers the same running or completed work after a relay restart instead of repeating agent side effects. Recovery requires the same Runtime session to remain alive. Relay polling and turn timeouts are configurable; the default turn wait is 30 minutes so implementation work is not mistaken for a stalled agent.

### Revisioned roster caching

Every Channel has a durable `rosterRevision`. Updating a Workspace member transactionally updates that identity's snapshots in all affected Channels; replacing one Channel's selected participants uses a compare-and-swap against the expected revision. Both operations increment the revision and emit `roster.updated`. Relays load metadata after the SSE subscription is ready, cache it, and refetch only when an event carries a newer revision. This closes the startup race without reading metadata for every wake-up. Disabled members cannot author, receive direct mentions, or wake from `@channel`; removed participants are absent from the current roster while their immutable message author ids remain intact. Disabling or removing an agent advances its durable cursor to the current Channel head, intentionally discarding pending wakes so re-enabling or re-adding cannot rerun uncertain old work.

### Explicit controls

Normal addressed messages remain queued turns. Human clients may explicitly control a working bound agent:

```text
/steer @agent-a <guidance>
/interrupt @agent-a <replacement instruction>
```

Steering is delivered at the Runtime adapter's next safe model boundary and is recorded as an unaddressed Channel control message so it does not create another wake-up. Interruption aborts the active run, marks its trigger handled, and posts the replacement as a normal addressed Channel message. Interruption cannot undo tool or filesystem side effects.

## TypeScript source imports

Node-facing packages use explicit TypeScript extensions in source:

```ts
import { ChannelClient } from "./client.ts";
```

TypeScript 5.9 `rewriteRelativeImportExtensions` emits the runtime-safe `./client.js` specifier in `dist`. This keeps source imports honest while preserving standard Node ESM output. Bare package imports and Vite-managed browser imports are unchanged.

## CLI

Install and operate Channels independently:

```bash
pnpm install
pnpm build
pnpm serve --port 4310
pnpm serve --db ./channels.db
pnpm serve \
  --db-url "$TURSO_DATABASE_URL" \
  --auth-token "$TURSO_AUTH_TOKEN"
```

Run the loopback-only web client and authenticated local control daemon during local development with:

```bash
pnpm web:dev
pnpm control --human-identity-id <stable-human-id>
# Override the default API proxy when Channels is not on port 4310:
VITE_CHANNELS_PROXY_TARGET=http://127.0.0.1:4400 pnpm web:dev

# Optionally load an independently installed structural Runtime adapter:
pnpm control --human-identity-id <stable-human-id> --runtime-adapter \
  'pi=/absolute/path/to/runtime/packages/pi/dist/src/index.js#PiAgentRuntime'

pnpm web:check
pnpm web:test
pnpm --filter @minu/channels-web exec playwright install chromium # once per machine
pnpm web:test:browser
```

The browser uses typed product clients and does not depend on whether capabilities run in-process, over loopback, or on a hosted service. Workspace labels are explicit in navigation and Channel headers, while Channel names replace opaque ids as the primary UI label. Workspace settings show redacted configuration state and accept write-only replacement source/persona/Runtime values without reading them back. The composer always authors as the bound active human and offers no `Send as` selector. Enter sends a message; Shift+Enter or Cmd/Ctrl+Enter inserts a line break. The browser never reads internal execution storage or Runtime credentials directly. Current browser binding prevents accidental UI impersonation but does not authenticate Channels message requests or make a forged `actorIdentityId` trustworthy. Server-enforced user authentication remains upcoming; the planned baseline is MinuNotes' Better Auth email-OTP/session pattern rather than a client-only login screen.

An optional separately installed Minu CLI may expose the same server as `minu channels serve`. The Pi collaboration demo lives under `examples/pi-demo` because it composes Channels with MinuRuntime and is not required to build or deploy Channels.
