#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { Command, InvalidArgumentError } from "commander";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LocalManagedRuntimePort } from "./agent-host.ts";
import { createLocalProductApp } from "./local.ts";
import { resolveChannelsDataDirectory } from "./local-paths.ts";
import { createLocalWebServer } from "./local-web-server.ts";
import { checkForUpdate, compareVersions, installUpdate, registerInstallationInstance, type UpdateCheck } from "./updater.ts";

interface LocalCliOptions {
  channelsPort: number;
  controlPort: number;
  webPort: number;
  dataDir?: string;
  cwd?: string;
  workspaceName?: string;
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

function packagedPath(...segments: string[]): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", ...segments);
}

function defaultWebDirectory(): string {
  const packaged = packagedPath("assets", "web");
  return existsSync(packaged) ? packaged : resolve(repositoryRoot(), "packages/web/dist");
}

function defaultMigrationsFolder(kind: "channels" | "agent-host"): string | undefined {
  const packaged = packagedPath("assets", "migrations", kind);
  return existsSync(packaged) ? packaged : undefined;
}

function moduleSpecifier(value: string): string {
  if (value.startsWith(".") || value.startsWith("/") || isAbsolute(value)) {
    return pathToFileURL(resolve(value)).href;
  }
  return value;
}

async function loadPiRuntime(specifier?: string): Promise<LocalManagedRuntimePort> {
  const packagedModule = packagedPath("bin", "runtime-pi.js");
  const developmentModule = resolve(repositoryRoot(), "../runtime/packages/pi/dist/src/index.js");
  const defaultModule = existsSync(packagedModule) ? packagedModule : developmentModule;
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

async function currentVersion(): Promise<string> {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(currentDirectory, "../..", "package.json"), resolve(currentDirectory, "../../../..", "package.json")];
  for (const path of candidates) {
    try {
      const metadata = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
      if (typeof metadata.version === "string") return metadata.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Unable to determine the installed MinuChannels version");
}

function printUpdate(update: UpdateCheck, json: boolean): void {
  if (json) return void console.log(JSON.stringify(update, null, 2));
  if (update.updateAvailable) {
    console.log(`MinuChannels ${update.latestVersion} is available (installed: ${update.currentVersion}).`);
    console.log(`Release: ${update.releaseUrl}`);
    console.log("Stop any running MinuChannels server, then run `minu-channels update`.");
  } else {
    const qualifier = compareVersions(update.currentVersion, update.latestVersion) > 0 ? ` (latest release: ${update.latestVersion})` : "";
    console.log(`MinuChannels ${update.currentVersion} is up to date${qualifier}.`);
  }
}

async function utilityCommand(args: string[]): Promise<boolean> {
  const command = args[0];
  if (command === "--version" || command === "-V" || command === "version") {
    console.log(await currentVersion());
    return true;
  }
  if (command !== "paths" && command !== "doctor" && command !== "update") return false;
  const utility = new Command().name(`minu-channels ${command}`).option("--data-dir <path>").option("--json");
  if (command === "update") utility.option("--check");
  utility.parse([process.argv[0]!, process.argv[1]!, ...args.slice(1)]);
  const options = utility.opts<{ dataDir?: string; json?: boolean; check?: boolean }>();
  const dataDirectory = resolveChannelsDataDirectory({ explicit: options.dataDir });
  if (command === "paths") {
    const paths = { dataDirectory, channelsDatabase: join(dataDirectory, "channels.db"), relayDatabase: join(dataDirectory, "relay.db"), profile: join(dataDirectory, "local-profile.json"), lock: join(dataDirectory, "run", "instance.lock") };
    if (options.json) console.log(JSON.stringify(paths, null, 2));
    else Object.entries(paths).forEach(([label, path]) => console.log(`${label}: ${path}`));
    return true;
  }
  if (command === "doctor") {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push({ name: "Node.js", ok: nodeMajor >= 22, detail: process.versions.node });
    try {
      await access(dataDirectory);
      const mode = (await stat(dataDirectory)).mode & 0o777;
      checks.push({ name: "Data directory", ok: (mode & 0o077) === 0, detail: `${dataDirectory} (${mode.toString(8)})` });
    } catch {
      checks.push({ name: "Data directory", ok: true, detail: `${dataDirectory} (not created yet)` });
    }
    checks.push({ name: "Platform", ok: process.platform === "darwin" || process.platform === "linux", detail: `${process.platform}/${process.arch}` });
    if (options.json) console.log(JSON.stringify({ ok: checks.every(({ ok }) => ok), checks }, null, 2));
    else checks.forEach((check) => console.log(`${check.ok ? "ok" : "failed"}  ${check.name}: ${check.detail}`));
    if (checks.some(({ ok }) => !ok)) throw new Error("MinuChannels doctor found problems");
    return true;
  }
  const update = await checkForUpdate({ currentVersion: await currentVersion() });
  if (options.check || !update.updateAvailable) printUpdate(update, Boolean(options.json));
  else {
    const installed = await installUpdate(update);
    if (options.json) console.log(JSON.stringify(installed));
    else console.log(`Updated MinuChannels from ${installed.previousVersion} to ${installed.version}.`);
  }
  return true;
}

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2).filter((argument) => argument !== "--");
  if (await utilityCommand(rawArguments)) return;
  const argv = process.argv.slice(0, 2).concat(rawArguments);
  const program = new Command()
    .name("minu-channels")
    .description("Start the persistent local MinuChannels product")
    .argument("[directory]", "Workspace source directory (required on first non-interactive launch)")
    .option("--channels-port <number>", "internal Channels API port", port, 4310)
    .option("--control-port <number>", "internal authenticated control port", port, 4311)
    .option("--web-port <number>", "local product web port", port, 5174)
    .option("--data-dir <path>", "persistent local data directory")
    .option("--cwd <path>", "Workspace source directory (legacy alias)")
    .option("--workspace-name <name>", "name for a newly created Workspace")
    .option("--web-dir <path>", "production web asset directory")
    .option("--runtime-module <module>", "Pi Runtime module")
    .option("--no-open", "print the one-time launch URL instead of opening a browser")
    .showHelpAfterError();
  program.parse(argv);
  const options = program.opts<LocalCliOptions>();
  if (options.cwd && program.args[0]) {
    throw new Error("Pass the Workspace directory as either a positional argument or --cwd, not both");
  }
  const directoryArgumentProvided = Boolean(options.cwd ?? program.args[0]);
  const dataDirectory = resolveChannelsDataDirectory({ explicit: options.dataDir });
  const freshInstallation = !existsSync(join(dataDirectory, "local-profile.json"));
  let workspaceInput = options.cwd ?? program.args[0];
  let workspaceName = options.workspaceName?.trim();
  if (freshInstallation && !workspaceInput) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("First launch requires a Workspace directory argument (for example: minu-channels .)");
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const sourceAnswer = (await prompt.question(`Workspace source folder [${process.cwd()}]: `)).trim();
      workspaceInput = sourceAnswer || process.cwd();
      const inferredName = basename(resolve(workspaceInput)) || "Workspace";
      const nameAnswer = (await prompt.question(`Workspace name [${inferredName}]: `)).trim();
      workspaceName = nameAnswer || inferredName;
    } finally {
      prompt.close();
    }
  }
  const workspaceRoot = resolve(workspaceInput ?? process.cwd());
  workspaceName ||= basename(workspaceRoot) || "Workspace";
  if (new Set([options.channelsPort, options.controlPort, options.webPort]).size !== 3) {
    throw new Error("Channels, control, and web ports must be distinct");
  }
  const webUrl = `http://127.0.0.1:${options.webPort}/`;
  const runtime = await loadPiRuntime(options.runtimeModule);
  const installationInstance = await registerInstallationInstance();
  let app: Awaited<ReturnType<typeof createLocalProductApp>>;
  try {
    app = await createLocalProductApp({
      channelsPort: options.channelsPort,
      controlPort: options.controlPort,
      webUrl,
      workspaceRoot,
      dataDirectory: dataDirectory,
      workspaceName,
      selectWorkspaceRoot: !freshInstallation && directoryArgumentProvided,
      runtimeAdapter: "pi",
      runtime,
      channelsMigrationsFolder: defaultMigrationsFolder("channels"),
      relayMigrationsFolder: defaultMigrationsFolder("agent-host"),
      onAudit(event) {
        process.stderr.write(`${JSON.stringify({ source: "minu-channels", ...event })}\n`);
      },
    });
  } catch (error) {
    await installationInstance.close();
    throw error;
  }
  let web: Awaited<ReturnType<typeof createLocalWebServer>> | undefined;
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await web?.close().catch(() => undefined);
    await app.close();
    await installationInstance.close();
  };
  try {
    web = await createLocalWebServer({
      channelsEndpoint: app.channelsEndpoint,
      channelsServiceToken: app.channelsServiceToken,
      authenticateBrowser: app.authenticateBrowser,
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
    console.log("  Agent:    click Start for @builder, then send a message for a live Pi response");
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
