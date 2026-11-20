import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LocalManagedRuntimePort } from "./agent-host.ts";

function moduleSpecifier(value: string): string {
  return value.startsWith(".") || isAbsolute(value) ? pathToFileURL(resolve(value)).href : value;
}

type LocalAdapter = "pi" | "codex" | "claude-code";
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
    // Claude Code is opted into full native tools (Pi parity); it uses the installed `claude`, its login and its default managed root.
    const Runtime = Constructor as new (options?: object) => LocalManagedRuntimePort;
    const runtime = adapter === "claude-code" ? new Runtime({ permissions: "full" }) : new Runtime();
    for (const method of ["start", "send", "messages", "status", "startManaged", "listManagedSessions", "resume", "suspend", "destroy"] as const) {
      if (typeof runtime[method] !== "function") throw new Error(`${adapter} Runtime module is missing ${method}`);
    }
    return [adapter, runtime] as const;
  }));
  return Object.fromEntries(entries) as Record<LocalAdapter, LocalManagedRuntimePort>;
}
