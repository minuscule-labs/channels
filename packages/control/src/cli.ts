#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LocalManagedRuntimePort } from "./agent-host.ts";
import { createLocalControlDaemon } from "./daemon.ts";
import { DEFAULT_CHANNELS_PORT, DEFAULT_CONTROL_PORT, DEFAULT_WEB_PORT, localChannelsUrl } from "./local-host.ts";

interface CliOptions {
  port: number;
  channelsUrl: string;
  channelsServiceToken: string;
  relayDb?: string;
  webUrl: string;
  humanIdentityId: string;
  runtimeAdapter: string[];
  open: boolean;
}

function integer(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 65_535) {
    throw new InvalidArgumentError("must be an integer from 0 to 65535");
  }
  return number;
}

function collect(value: string, values: string[]): string[] {
  return [...values, value];
}

function moduleSpecifier(value: string): string {
  if (value.startsWith(".") || value.startsWith("/") || isAbsolute(value)) {
    return pathToFileURL(resolve(value)).href;
  }
  return value;
}

async function runtimeFromModule(specification: string): Promise<[string, LocalManagedRuntimePort]> {
  const separator = specification.indexOf("=");
  if (separator < 1 || separator === specification.length - 1) {
    throw new Error("Runtime adapters must use <name>=<module>[#export]");
  }
  const name = specification.slice(0, separator).trim();
  const moduleAndExport = specification.slice(separator + 1).trim();
  if (!name || !moduleAndExport) {
    throw new Error("Runtime adapters must use non-empty names and module specifiers");
  }
  const hash = moduleAndExport.lastIndexOf("#");
  const requestedExport = hash > 0 ? moduleAndExport.slice(hash + 1) : undefined;
  const requestedModule = hash > 0 ? moduleAndExport.slice(0, hash) : moduleAndExport;
  const loaded = await import(moduleSpecifier(requestedModule)) as Record<string, unknown>;
  let candidate = requestedExport
    ? loaded[requestedExport]
    : loaded.localControlRuntime ?? loaded.default;
  if (candidate === undefined && typeof loaded.createLocalControlRuntime === "function") {
    candidate = await (loaded.createLocalControlRuntime as () => unknown)();
  }
  if (typeof candidate === "function") {
    candidate = new (candidate as new () => unknown)();
  }
  if (!candidate || typeof candidate !== "object"
    || typeof (candidate as { status?: unknown }).status !== "function") {
    throw new Error(`Runtime module for ${name} does not expose an object with status(sessionId)`);
  }
  return [name, candidate as LocalManagedRuntimePort];
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
  const program = new Command()
    .name("minu-channels-control")
    .description("Run the authenticated loopback MinuChannels control daemon")
    .option("--port <number>", "loopback control port", integer, DEFAULT_CONTROL_PORT)
    .option("--channels-url <url>", "MinuChannels HTTP endpoint", `http://127.0.0.1:${DEFAULT_CHANNELS_PORT}`)
    .requiredOption("--channels-service-token <token>", "private Channels service credential", process.env.MINU_CHANNELS_SERVICE_TOKEN)
    .option("--relay-db <path>", "private local Relay database path")
    .option("--web-url <url>", "loopback web client URL", localChannelsUrl(DEFAULT_WEB_PORT))
    .requiredOption("--human-identity-id <id>", "stable human identity bound to the browser session")
    .option(
      "--runtime-adapter <name=module[#export]>",
      "load a structural Runtime status adapter; repeat for multiple adapters",
      collect,
      [],
    )
    .option("--no-open", "print the one-time launch URL instead of opening a browser")
    .showHelpAfterError();
  program.parse(process.argv);
  const options = program.opts<CliOptions>();
  const entries = await Promise.all(options.runtimeAdapter.map(runtimeFromModule));
  const runtimes = Object.fromEntries(entries);
  if (Object.keys(runtimes).length !== entries.length) {
    throw new Error("Runtime adapter names must be unique");
  }
  const daemon = await createLocalControlDaemon({
    currentHumanIdentityId: options.humanIdentityId,
    channelsEndpoint: options.channelsUrl,
    channelsServiceToken: options.channelsServiceToken,
    relayDatabasePath: options.relayDb,
    webUrl: options.webUrl,
    port: options.port,
    runtimes,
    onAudit(event) {
      process.stderr.write(`${JSON.stringify({ source: "minu-channels-control", ...event })}\n`);
    },
  });
  try {
    const launchUrl = daemon.issueBrowserLaunchUrl();
    console.log(`MinuChannels control listening on ${daemon.endpoint}`);
    if (options.open) {
      await openBrowser(launchUrl);
      console.log(`Opened authenticated web client at ${options.webUrl}`);
    } else {
      console.log("Open this one-time URL within 60 seconds:");
      console.log(launchUrl);
    }
  } catch (error) {
    await daemon.close();
    throw error;
  }

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await daemon.close();
  };
  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
