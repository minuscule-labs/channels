import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LocalManagedRuntimePort } from "./agent-host.ts";

function moduleSpecifier(value: string): string {
  return value.startsWith(".") || isAbsolute(value) ? pathToFileURL(resolve(value)).href : value;
}

type LocalAdapter = "pi" | "codex" | "claude-code";
/** The one access level every local agent runs with: whatever the user's own account can do, without asking. Each adapter maps it
 * to its native setting below, so what an agent can do does not depend on which harness runs it. */
export const LOCAL_AGENT_ACCESS = "full" as const;
export type LocalAgentAccess = typeof LOCAL_AGENT_ACCESS;
/** Pi has no restriction setting (no options); Claude Code bypasses permission prompts with every native tool; Codex runs
 * unsandboxed with approvals off. */
export const LOCAL_AGENT_ACCESS_OPTIONS: Record<LocalAdapter, Record<LocalAgentAccess, object | undefined>> = {
  pi: { full: undefined },
  "claude-code": { full: { permissions: "full" } },
  codex: { full: { sandbox: "danger-full-access" } },
};

const CLASSES: Record<LocalAdapter, string> = { pi: "PiAgentRuntime", codex: "CodexAgentRuntime", "claude-code": "ClaudeCodeAgentRuntime" };

/** Load all installed adapters; selecting one remains an existing per-agent choice. */
export async function loadLocalRuntimes(overrides: { pi?: string; codex?: string; claudeCode?: string } = {}): Promise<Record<LocalAdapter, LocalManagedRuntimePort>> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const entries = await Promise.all((["pi", "codex", "claude-code"] as const).map(async adapter => {
    const packaged = resolve(directory, "..", "bin", ...(adapter === "pi" ? [] : [adapter]), `runtime-${adapter}.js`);
    const development = resolve(directory, "../../../../../runtime/packages", adapter, "dist/src/index.js");
    const specifier = (adapter === "claude-code" ? overrides.claudeCode : overrides[adapter]) ?? (existsSync(packaged) ? packaged : development);
    const loaded = await import(moduleSpecifier(specifier)) as Record<string, unknown>;
    const name = CLASSES[adapter];
    const Constructor = loaded[name];
    if (typeof Constructor !== "function") throw new Error(`${adapter} Runtime module does not export ${name}`);
    // Agents can do real work, and all three harnesses run with the same full access (see LOCAL_AGENT_ACCESS). They use the
    // installed CLI, its login and its default managed root. Saved sessions keep the policy they were created with.
    const Runtime = Constructor as new (options?: object) => LocalManagedRuntimePort;
    const options = LOCAL_AGENT_ACCESS_OPTIONS[adapter][LOCAL_AGENT_ACCESS];
    const runtime = options === undefined ? new Runtime() : new Runtime(options);
    for (const method of ["start", "send", "messages", "status", "startManaged", "listManagedSessions", "resume", "suspend", "destroy"] as const) {
      if (typeof runtime[method] !== "function") throw new Error(`${adapter} Runtime module is missing ${method}`);
    }
    return [adapter, runtime] as const;
  }));
  return Object.fromEntries(entries) as Record<LocalAdapter, LocalManagedRuntimePort>;
}
