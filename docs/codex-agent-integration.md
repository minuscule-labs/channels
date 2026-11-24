# Codex in existing agent setup

Status: source implementation and controlled checks passed; independent review and
production deployment are pending. No published package or running installation
has been updated by this work.

## Setup

Pi remains the default. In the existing agent detail page, use **Private launch
profile → Runtime → Harness** and choose `codex`. Models, reasoning and skills come
from that adapter's discovery. There is no installation-wide or per-Conversation
selector. Saving a different adapter clears omitted old launch choices; it does not
reinterpret or replace a live Pi session. Use the existing explicit new-session
operation when changing a running agent to a different harness.

Both the persistent development composition and the product loader register Pi and
Codex. Each saved binding keeps its own adapter, owner and session ID. A controller
restart authenticates an already-living Codex worker before status/turn recovery;
that connection cannot launch, cold-resume, repair metadata or clear a fence.
Legacy adapters without that method retain their existing restoration path.

For an isolated source test after building the sibling Runtime checkout:

```sh
pnpm local -- --no-open --data-dir /absolute/disposable/channels-data --cwd /absolute/disposable/workspace
```

Open the printed local URL, select Codex in agent setup, save the profile and start
a new agent session explicitly. Codex must be installed and authenticated in the
actual service environment. Sending a message can invoke configured models, tools,
hooks and MCP integrations and may persist native history. Channels starts new Codex sessions with the
`danger-full-access` sandbox and approval-never: full access means Codex can change anything the user's account can,
without asking, exactly as Pi and Claude Code agents already can. Every harness uses the same single access level, so
what an agent can do does not depend on which harness runs it. Sessions created earlier keep the sandbox they were
created with (read-only and `workspace-write` sessions never widen on resume). This needs a Runtime that accepts the
`danger-full-access` sandbox; Channels fails to load an older Runtime rather than falling back to a narrower sandbox.
When Codex is not installed or not signed in, agent setup says so (install `codex`, run `codex login`). This is not blanket permission for external
integrations. Interactive approval/answer handling and explicit recovery remain
unfinished. Cold suspend/resume/destroy eligibility is still macOS/v5-limited.

The existing Pi module override remains `--runtime-module`; the product also accepts
`--codex-runtime-module`. Persistent review/development mode uses `--pi-module` and
`--codex-module`. These are module-loading overrides, not global adapter selection.

## Package resources and shipping gate

The packager now includes `dist/bin/runtime-pi.js` beside its existing
`owned-worker.js`, and Codex in `dist/bin/codex/{runtime-codex,owned-worker}.js`.
Separate directories preserve each adapter's worker-relative URL and avoid worker
name collisions.

Channels now pins Runtime commit
`f3c6737ce320901aa2468363f16b94513c3dc26b`, adding plugin-qualified Codex skill names,
the `danger-full-access` sandbox, pre-turn image capability and named setup errors to the previous
Pi/Codex/Claude Code baseline. An earlier Channels release may not read sessions created with that sandbox.
That source pin does not establish installed-artifact acceptance or authorize
publication/deployment. Before shipping, satisfy required CI and exact-artifact
acceptance through the normal release workflow. No pin, clean-tree requirement or
release gate is bypassed. See [releasing](releasing.md).
The isolated bundle/worker test is not an installed release or production-channel
acceptance test.

## Recorded checks

- Control/backend typecheck and web typecheck passed.
- 170 affected backend cases passed: all Relay tests plus control composition,
  agent actions, Runtime launch and the new loader/consumer tests. Normal deadlines
  and concurrency; no skips.
- One Chromium scenario passed with one fixture worker: choose Codex through the
  existing field, save and reopen the profile, and exercise adapter-scoped choices.
- Controlled bundle test loads both adapters through the packaged loader layout,
  starts the bundled Codex worker, sends fixture input, and on Darwin cold-resumes
  the same history and destroys only Runtime metadata.
- Actual Codex adapter plus owned fake app-server test delivers Conversation turns
  before and after replacing the product controller/adapter instance, with one
  native thread and no duplicate dispatch.
- Pi/Codex fake sessions deliberately share an opaque session ID; saved Pi bindings
  retain Pi routing even after the agent's future-session profile changes to Codex.
- Managed reconnect tests reject wrong owner, wrong ID or failed authentication
  before status or delivery; live restoration does not call resume.

These checks use no paid inference, real model/tool calls or production service.
Initial test typing/status-assertion errors and the genuine fresh-controller
connection failure were retained under `/tmp/minu-codex-channels-*`. Full workspace,
release/tarball installation, real-model/tool and production acceptance are not
claimed. Existing historical gates and all required Runtime capabilities remain
open until their respective evidence is complete.
