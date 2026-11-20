# Claude Code agent integration

Claude Code is selected per agent exactly like Pi and Codex (adapter id `claude-code`). Channels owns which harness an agent
uses; Runtime (`@minu/runtime-claude-code`) drives it.

- **Login and tools.** The adapter runs the installed `claude` from `PATH` with the user's own login (subscription or
  `ANTHROPIC_API_KEY` in the service environment). Channels never reads or stores credentials. Agents run with full native
  tools (`permissions: "full"`), matching Pi; Claude Code's user/project settings, hooks, MCP servers and skills load as if
  `claude` ran in the workspace folder. If there is no login, agent setup shows
  "Claude Code is not logged in; run `claude` to sign in".
- **Pickers.** Model, reasoning level and skills come from the harness (`capabilities`) for the workspace folder.
- **Sessions.** Durable owner-scoped sessions live under `~/.minu/runtime/claude-code`; stop, resume, force-stop and
  destroy follow the same contract as the other adapters (see the Runtime repository's process-family contract). Native
  transcripts stay in Claude Code's own config directory.
- **Packaging.** `dist/bin/claude-code/runtime-claude-code.js` and its `worker-entry.js` sit side by side so the worker URL
  resolves. No native engine ships; Claude Code must be installed on the machine that runs Channels. The development override is
  `--claude-code-runtime-module`.
- **Acceptance.** Run one real agent turn (Read) and a tiny Edit in a throwaway workspace on the target machine before release.
