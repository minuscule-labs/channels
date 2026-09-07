#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LocalManagedRuntimePort } from "./agent-host.ts";
import type { LocalControlAuditEvent } from "./session.ts";
import { createLocalProductApp } from "./local.ts";
import { DEFAULT_CHANNELS_PORT, DEFAULT_CONTROL_PORT, DEFAULT_WEB_PORT, localChannelsUrl } from "./local-host.ts";
import { createLocalReviewApp, type LocalReviewManagedRuntime } from "./review.ts";

function port(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return parsed;
}

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function moduleSpecifier(value: string): string {
  if (value.startsWith(".") || value.startsWith("/") || isAbsolute(value)) {
    return pathToFileURL(resolve(value)).href;
  }
  return value;
}

async function loadPiRuntime(specifier?: string): Promise<LocalReviewManagedRuntime> {
  const defaultModule = resolve(repositoryRoot(), "../runtime/packages/pi/dist/src/index.js");
  const loaded = await import(moduleSpecifier(specifier ?? defaultModule)) as Record<string, unknown>;
  const Constructor = loaded.PiAgentRuntime;
  if (typeof Constructor !== "function") {
    throw new Error("Pi Runtime module does not export PiAgentRuntime");
  }
  const runtime = new (Constructor as new () => LocalManagedRuntimePort)();
  if (typeof runtime.start !== "function" || typeof runtime.send !== "function"
    || typeof runtime.messages !== "function") {
    throw new Error("Pi Runtime module does not provide managed execution capabilities");
  }
  return {
    adapter: "pi",
    runtime,
    personaPrompt: "You are the implementation agent for this MinuChannels Workspace. Follow the human's Channel requests, inspect the configured repository carefully, make only requested changes, verify your work, and report concise concrete results. Never expose private Runtime configuration or credentials in Channel responses.",
  };
}

async function waitForWeb(
  url: string,
  child: ChildProcess,
  spawnFailure: () => Error | undefined,
  timeoutMs = 20_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const failure = spawnFailure();
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error(`Web process exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for the review web client at ${url}`);
}

async function openBrowser(url: string): Promise<void> {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]] as const
    : process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url]] as const
      : ["xdg-open", [url]] as const;
  await new Promise<void>((resolveOpen, reject) => {
    const child = spawn(command, [...args], { detached: true, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolveOpen();
    });
    child.once("error", reject);
  });
}

async function stopProcessGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolveStop) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      killer.once("exit", () => resolveStop());
      killer.once("error", () => resolveStop());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 3_000)),
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const forwardedSeparator = arguments_.indexOf("--");
  if (forwardedSeparator >= 0) arguments_.splice(forwardedSeparator, 1);
  const { values } = parseArgs({
    args: arguments_,
    options: {
      "channels-port": { type: "string" },
      "control-port": { type: "string" },
      "web-port": { type: "string" },
      cwd: { type: "string" },
      "no-open": { type: "boolean", default: false },
      "live-pi": { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      "data-dir": { type: "string" },
      "pi-module": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(`Usage: pnpm dev [-- options]\n       pnpm local [-- options]\n\nOptions:\n  --channels-port <port>  Channels API port (default 47410)\n  --control-port <port>   local control port (default 47411)\n  --web-port <port>       web client port (default 47412)\n  --cwd <path>            private Workspace root\n  --local                  use persistent local data and live Pi\n  --data-dir <path>        persistent local data directory (default ~/.minu/channels)\n  --live-pi               enable startable live Pi execution in disposable review mode\n  --pi-module <module>    Pi Runtime module (defaults to sibling runtime build)\n  --no-open               print launch URL instead of opening a browser\n  -h, --help              show help`);
    return;
  }

  const channelsPort = port(values["channels-port"], DEFAULT_CHANNELS_PORT, "channels-port");
  const controlPort = port(values["control-port"], DEFAULT_CONTROL_PORT, "control-port");
  const webPort = port(values["web-port"], DEFAULT_WEB_PORT, "web-port");
  if (new Set([channelsPort, controlPort, webPort]).size !== 3) {
    throw new Error("Review service ports must be distinct");
  }
  const webUrl = localChannelsUrl(webPort);
  const persistent = values.local;
  const managedRuntime = values["live-pi"] || persistent
    ? await loadPiRuntime(values["pi-module"])
    : undefined;
  const onAudit = (event: LocalControlAuditEvent) => {
    process.stderr.write(`${JSON.stringify({ source: persistent ? "minu-channels-local" : "minu-channels-review", ...event })}\n`);
  };
  const app = persistent
    ? await createLocalProductApp({
      channelsPort,
      controlPort,
      webUrl,
      workspaceRoot: values.cwd,
      dataDirectory: values["data-dir"],
      runtimeAdapter: managedRuntime!.adapter,
      runtime: managedRuntime!.runtime,
      personaPrompt: managedRuntime!.personaPrompt,
      onAudit,
    })
    : await createLocalReviewApp({
      channelsPort,
      controlPort,
      webUrl,
      workspaceRoot: values.cwd,
      managedRuntime,
      onAudit,
    });
  const vite = spawn(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["--filter", "@minu/channels-web", "exec", "vite", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
    {
      cwd: repositoryRoot(),
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        VITE_CHANNELS_PROXY_TARGET: app.channelsEndpoint,
        MINU_CHANNELS_SERVICE_TOKEN: app.channelsServiceToken,
        VITE_CHANNELS_CONTROL_PROXY_TARGET: app.controlEndpoint,
      },
      stdio: "inherit",
    },
  );

  let viteSpawnError: Error | undefined;
  vite.once("error", (error) => {
    viteSpawnError = error;
  });
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await stopProcessGroup(vite).catch(() => undefined);
    await app.close();
  };
  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));
  vite.once("exit", (code, signal) => {
    if (closing) return;
    process.stderr.write(`Review web process stopped (${signal ?? code ?? "unknown"})\n`);
    void close().then(() => {
      process.exitCode = code && code !== 0 ? code : 1;
    });
  });

  try {
    await waitForWeb(webUrl, vite, () => viteSpawnError);
    const launchUrl = app.issueBrowserLaunchUrl();
    console.log(`\nMinuChannels ${persistent ? "local app" : "review app"} is ready`);
    console.log(`  Web:      ${webUrl}`);
    console.log(`  Channels: ${app.channelsEndpoint}`);
    console.log(`  Control:  ${app.controlEndpoint}`);
    console.log(`  Handles:  ${persistent ? "@you, @builder" : "@you, @builder, @reviewer"}`);
    console.log(managedRuntime
      ? "  Agent:    click Start for @builder, then mention it for a live Pi response"
      : "  Agent:    @mention @builder for a simulated Relay response");
    console.log("  Context:  unaddressed messages do not wake agents");
    console.log(persistent
      ? `  Data:     persistent at ${"dataDirectory" in app ? app.dataDirectory : "~/.minu/channels"}`
      : "  Data:     disposable; removed on shutdown");
    if (persistent && "initialized" in app) {
      console.log(`  Setup:    ${app.initialized ? "created a fresh local Workspace" : "reopened existing local data"}`);
    }
    console.log(`  Runtime:  ${managedRuntime ? "live Pi (starts only on explicit click)" : "deterministic simulation"}`);
    if (values["no-open"]) {
      console.log("\nOpen this one-time URL within 60 seconds:");
      console.log(launchUrl);
    } else {
      await openBrowser(launchUrl);
      console.log("\nOpened the authenticated review Workspace in your browser.");
    }
    console.log(`Press Ctrl-C to stop all ${persistent ? "local" : "review"} services.`);
  } catch (error) {
    await close();
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
