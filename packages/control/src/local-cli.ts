#!/usr/bin/env node
import { spawn } from "node:child_process";
import { Command, InvalidArgumentError } from "commander";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LocalManagedRuntimePort } from "./agent-host.ts";
import { createLocalProductApp } from "./local.ts";
import { createLocalWebServer } from "./local-web-server.ts";

interface LocalCliOptions {
  channelsPort: number;
  controlPort: number;
  webPort: number;
  dataDir?: string;
  cwd?: string;
  webDir?: string;
  runtimeModule?: string;
  open: boolean;
}

function port(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new InvalidArgumentError("must be an integer from 1 to 65535");
  }
  return parsed;
}

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function defaultWebDirectory(): string {
  return resolve(repositoryRoot(), "packages/web/dist");
}

function moduleSpecifier(value: string): string {
  if (value.startsWith(".") || value.startsWith("/") || isAbsolute(value)) {
    return pathToFileURL(resolve(value)).href;
  }
  return value;
}

async function loadPiRuntime(specifier?: string): Promise<LocalManagedRuntimePort> {
  const defaultModule = resolve(repositoryRoot(), "../runtime/packages/pi/dist/src/index.js");
  const loaded = await import(moduleSpecifier(specifier ?? defaultModule)) as Record<string, unknown>;
  const Constructor = loaded.PiAgentRuntime;
  if (typeof Constructor !== "function") {
    throw new Error("Pi Runtime module does not export PiAgentRuntime");
  }
  const runtime = new (Constructor as new () => LocalManagedRuntimePort)();
  if (typeof runtime.start !== "function" || typeof runtime.send !== "function"
    || typeof runtime.messages !== "function" || typeof runtime.status !== "function") {
    throw new Error("Pi Runtime module does not provide managed execution capabilities");
  }
  return runtime;
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

async function main(): Promise<void> {
  const argv = process.argv.slice(0, 2).concat(process.argv.slice(2).filter((argument) => argument !== "--"));
  const program = new Command()
    .name("minu-channels")
    .description("Start the persistent local MinuChannels product")
    .argument("[directory]", "Workspace source directory", process.cwd())
    .option("--channels-port <number>", "internal Channels API port", port, 4310)
    .option("--control-port <number>", "internal authenticated control port", port, 4311)
    .option("--web-port <number>", "local product web port", port, 5174)
    .option("--data-dir <path>", "persistent local data directory")
    .option("--cwd <path>", "Workspace source directory (legacy alias)")
    .option("--web-dir <path>", "production web asset directory")
    .option("--runtime-module <module>", "Pi Runtime module")
    .option("--no-open", "print the one-time launch URL instead of opening a browser")
    .showHelpAfterError();
  program.parse(argv);
  const options = program.opts<LocalCliOptions>();
  if (options.cwd && program.args[0] && resolve(program.args[0]) !== resolve(process.cwd())) {
    throw new Error("Pass the Workspace directory as either a positional argument or --cwd, not both");
  }
  const workspaceRoot = resolve(options.cwd ?? program.args[0] ?? process.cwd());
  if (new Set([options.channelsPort, options.controlPort, options.webPort]).size !== 3) {
    throw new Error("Channels, control, and web ports must be distinct");
  }
  const webUrl = `http://127.0.0.1:${options.webPort}/`;
  const runtime = await loadPiRuntime(options.runtimeModule);
  const app = await createLocalProductApp({
    channelsPort: options.channelsPort,
    controlPort: options.controlPort,
    webUrl,
    workspaceRoot,
    dataDirectory: options.dataDir,
    runtimeAdapter: "pi",
    runtime,
    onAudit(event) {
      process.stderr.write(`${JSON.stringify({ source: "minu-channels", ...event })}\n`);
    },
  });
  let web: Awaited<ReturnType<typeof createLocalWebServer>> | undefined;
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await web?.close().catch(() => undefined);
    await app.close();
  };
  try {
    web = await createLocalWebServer({
      channelsEndpoint: app.channelsEndpoint,
      controlEndpoint: app.controlEndpoint,
      webDirectory: resolve(options.webDir ?? defaultWebDirectory()),
      port: options.webPort,
    });
    const launchUrl = app.issueBrowserLaunchUrl();
    console.log("\nMinuChannels is ready");
    console.log(`  Web:      ${web.endpoint}/`);
    console.log(`  Data:     ${app.dataDirectory}`);
    console.log(`  Workspace: ${workspaceRoot}`);
    console.log(`  Setup:    ${app.initialized ? "created a fresh local Workspace" : "reopened existing local data"}`);
    console.log("  Agent:    click Start for @builder, then mention it for a live Pi response");
    if (options.open) {
      await openBrowser(launchUrl);
      console.log("\nOpened the authenticated local Workspace in your browser.");
    } else {
      console.log("\nOpen this one-time URL within 60 seconds:");
      console.log(launchUrl);
    }
    console.log("Press Ctrl-C to stop MinuChannels.");
  } catch (error) {
    await close();
    throw error;
  }

  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
