import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LocalManagedRuntimePort } from "./agent-host.ts";

function moduleSpecifier(value: string): string {
  return value.startsWith(".") || isAbsolute(value) ? pathToFileURL(resolve(value)).href : value;
}

/** Load both installed adapters; selecting one remains an existing per-agent choice. */
export async function loadLocalRuntimes(overrides: { pi?: string; codex?: string } = {}): Promise<Record<"pi" | "codex", LocalManagedRuntimePort>> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const entries = await Promise.all((["pi", "codex"] as const).map(async adapter => {
    const packaged = resolve(directory, "..", "bin", ...(adapter === "codex" ? ["codex"] : []), `runtime-${adapter}.js`);
    const development = resolve(directory, "../../../../../runtime/packages", adapter, "dist/src/index.js");
    const specifier = overrides[adapter] ?? (existsSync(packaged) ? packaged : development);
    const loaded = await import(moduleSpecifier(specifier)) as Record<string, unknown>;
    const name = adapter === "pi" ? "PiAgentRuntime" : "CodexAgentRuntime";
    const Constructor = loaded[name];
    if (typeof Constructor !== "function") throw new Error(`${adapter} Runtime module does not export ${name}`);
    const runtime = new (Constructor as new () => LocalManagedRuntimePort)();
    for (const method of ["start", "send", "messages", "status", "startManaged", "listManagedSessions", "resume", "suspend", "destroy"] as const) {
      if (typeof runtime[method] !== "function") throw new Error(`${adapter} Runtime module is missing ${method}`);
    }
    return [adapter, runtime] as const;
  }));
  return Object.fromEntries(entries) as Record<"pi" | "codex", LocalManagedRuntimePort>;
}
