#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { Command, InvalidArgumentError } from "commander";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LocalManagedRuntimePort } from "./agent-host.ts";
import { coordinateConversationsUpdate } from "./coordinated-update.ts";
import { createLocalProductApp } from "./local.ts";
import { DEFAULT_CHANNELS_PORT, DEFAULT_CONTROL_PORT, DEFAULT_WEB_PORT, localConversationsUrl } from "./local-host.ts";
import { resolveConversationsDataDirectory } from "./local-paths.ts";
import { createLocalWebServer } from "./local-web-server.ts";
import { LocalServiceLifecycle, type LocalServiceStatus } from "./service-lifecycle.ts";
import { BoundedServiceLog } from "./service-log.ts";
import { requestServiceBrowserLaunchUrl, startServiceOpenBroker } from "./service-open.ts";
import { requestServiceRestart, startServiceRestartBroker, type ServiceQuiesceAction } from "./service-restart.ts";
import { confirmConversationsUpdate } from "./update-confirmation.ts";
import { checkForUpdate, compareVersions, registerInstallationInstance, type UpdateCheck } from "./updater.ts";

let backgroundServiceLog: BoundedServiceLog | undefined;
let backgroundServiceMode = false;

interface LocalCliOptions {
  conversationsPort: number;
  controlPort: number;
  webPort: number;
  dataDir?: string;
  cwd?: string;
  workspaceName?: string;
  webDir?: string;
  runtimeModule?: string;
  open: boolean;
  serviceMode: boolean;
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

function defaultMigrationsFolder(kind: "conversations" | "agent-host"): string | undefined {
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
    ? ["/usr/bin/open", [url]] as const
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
    console.log("Run `minu-channels update`; a running background service will be coordinated safely.");
  } else {
    const qualifier = compareVersions(update.currentVersion, update.latestVersion) > 0 ? ` (latest release: ${update.latestVersion})` : "";
    console.log(`MinuChannels ${update.currentVersion} is up to date${qualifier}.`);
  }
}

function serviceStatusSummary(status: LocalServiceStatus): string {
  if (status.running) return status.ready ? "running" : "starting";
  if (status.loaded) return "stopped";
  return status.installed ? "installed" : "not installed";
}

async function utilityCommand(args: string[]): Promise<boolean> {
  const command = args[0];
  if (command === "--version" || command === "-V" || command === "version") {
    console.log(await currentVersion());
    return true;
  }
  const serviceCommands = new Set([
    "start", "stop", "restart", "status", "open", "enable-login", "disable-login", "remove-service",
  ]);
  if (serviceCommands.has(command ?? "")) {
    const utility = new Command().name(`minu-channels ${command}`).option("--data-dir <path>").option("--json");
    if (command === "restart") utility.option("--when-idle", "wait for currently active agent turns before restarting");
    utility.parse([process.argv[0]!, process.argv[1]!, ...args.slice(1)]);
    const options = utility.opts<{ dataDir?: string; json?: boolean; whenIdle?: boolean }>();
    const dataDirectory = resolveConversationsDataDirectory({ explicit: options.dataDir });
    const service = new LocalServiceLifecycle({
      dataDirectory,
      nodeExecutable: process.execPath,
      cliEntryPoint: fileURLToPath(import.meta.url),
    });
    let status: LocalServiceStatus;
    if (command === "start") status = await service.start();
    else if (command === "stop") status = await service.stop();
    else if (command === "restart") {
      const before = await service.status();
      if (before.running) {
        const previousPid = await service.processId();
        if (previousPid === undefined) throw new Error("MinuChannels service state could not be verified");
        const preparation = await requestServiceRestart(dataDirectory, {
          waitForIdle: Boolean(options.whenIdle),
          timeoutMs: options.whenIdle ? 135_000 : 10_000,
        });
        if (preparation.status === "busy") {
          throw new Error(`${preparation.activeTurns} active agent turn${preparation.activeTurns === 1 ? "" : "s"}; run \`minu-channels restart --when-idle\` to wait safely`);
        }
        status = await service.waitForRestart(previousPid);
      } else {
        status = await service.restart();
      }
    }
    else if (command === "enable-login") status = await service.setLoginEnabled(true);
    else if (command === "disable-login") status = await service.setLoginEnabled(false);
    else if (command === "remove-service") status = await service.remove();
    else if (command === "open") {
      status = await service.start();
      const launchUrl = await requestServiceBrowserLaunchUrl(dataDirectory);
      await openBrowser(launchUrl);
    } else status = await service.status();
    if (options.json) console.log(JSON.stringify(status));
    else if (command === "open") console.log("Opened the authenticated local Workspace in your browser.");
    else console.log(`MinuChannels is ${serviceStatusSummary(status)}${status.loginEnabled ? " and enabled at login" : ""}.`);
    return true;
  }
  if (command !== "paths" && command !== "doctor" && command !== "update") return false;
  const utility = new Command().name(`minu-channels ${command}`).option("--data-dir <path>").option("--json");
  if (command === "update") {
    utility.option("--check").option("-y, --yes", "confirm installation of the verified update");
  }
  utility.parse([process.argv[0]!, process.argv[1]!, ...args.slice(1)]);
  const options = utility.opts<{ dataDir?: string; json?: boolean; check?: boolean; yes?: boolean }>();
  const dataDirectory = resolveConversationsDataDirectory({ explicit: options.dataDir });
  if (command === "paths") {
    const paths = { dataDirectory, conversationsDatabase: join(dataDirectory, "channels.db"), relayDatabase: join(dataDirectory, "relay.db"), profile: join(dataDirectory, "local-profile.json"), lock: join(dataDirectory, "run", "instance.lock") };
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
  else if (await confirmConversationsUpdate({ assumeYes: Boolean(options.yes), json: Boolean(options.json) })) {
    const service = process.platform === "darwin" ? new LocalServiceLifecycle({
      dataDirectory,
      nodeExecutable: process.execPath,
      cliEntryPoint: fileURLToPath(import.meta.url),
    }) : undefined;
    const installed = await coordinateConversationsUpdate(update, { dataDirectory, service });
    if (options.json) console.log(JSON.stringify(installed));
    else console.log(`Updated MinuChannels from ${installed.previousVersion} to ${installed.version}${installed.serviceRestarted ? " and restarted the background service" : ""}.`);
  } else {
    console.log("Update cancelled.");
  }
  return true;
}

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2).filter((argument) => argument !== "--");
  if (await utilityCommand(rawArguments)) return;
  const runArguments = rawArguments[0] === "run" ? rawArguments.slice(1) : rawArguments;
  const argv = process.argv.slice(0, 2).concat(runArguments);
  const program = new Command()
    .name("minu-channels")
    .description("Start the persistent local MinuChannels product")
    .argument("[directory]", "Workspace source directory shortcut")
    .option("--conversations-port <number>", "internal Conversations API port", port, DEFAULT_CHANNELS_PORT)
    .option("--control-port <number>", "internal authenticated control port", port, DEFAULT_CONTROL_PORT)
    .option("--web-port <number>", "local product web port", port, DEFAULT_WEB_PORT)
    .option("--data-dir <path>", "persistent local data directory")
    .option("--cwd <path>", "Workspace source directory (legacy alias)")
    .option("--workspace-name <name>", "name for a newly created Workspace")
    .option("--web-dir <path>", "production web asset directory")
    .option("--runtime-module <module>", "Pi Runtime module")
    .option("--no-open", "print the one-time launch URL instead of opening a browser")
    .option("--service-mode", "run under the product-owned background supervisor")
    .addHelpText("after", `
Lifecycle commands (macOS):
  start, stop, restart, status, open
  enable-login, disable-login, remove-service

Other commands:
  run, paths, doctor, update, version
`)
    .showHelpAfterError();
  program.parse(argv);
  const options = program.opts<LocalCliOptions>();
  if (options.cwd && program.args[0]) {
    throw new Error("Pass the Workspace directory as either a positional argument or --cwd, not both");
  }
  const directoryArgumentProvided = Boolean(options.cwd ?? program.args[0]);
  const dataDirectory = resolveConversationsDataDirectory({ explicit: options.dataDir });
  const serviceLog = options.serviceMode
    ? new BoundedServiceLog(join(dataDirectory, "logs", "service.log"))
    : undefined;
  backgroundServiceLog = serviceLog;
  backgroundServiceMode = options.serviceMode;
  const output = (message: string): void => {
    if (serviceLog) void serviceLog.append(message).catch(() => undefined);
    else console.log(message);
  };
  const diagnostic = (message: string): void => {
    if (serviceLog) void serviceLog.append(message).catch(() => undefined);
    else process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  };
  const freshInstallation = !existsSync(join(dataDirectory, "local-profile.json"));
  const workspaceInput = options.cwd ?? program.args[0];
  const workspaceRoot = workspaceInput ? resolve(workspaceInput) : undefined;
  if (options.workspaceName && !workspaceRoot) {
    throw new Error("--workspace-name requires a Workspace directory argument");
  }
  const workspaceName = options.workspaceName?.trim()
    || (workspaceRoot ? basename(workspaceRoot) || "Workspace" : undefined);
  if (new Set([options.conversationsPort, options.controlPort, options.webPort]).size !== 3) {
    throw new Error("Conversations, control, and web ports must be distinct");
  }
  const webUrl = localConversationsUrl(options.webPort);
  const runtime = await loadPiRuntime(options.runtimeModule);
  const installationInstance = await registerInstallationInstance({
    kind: options.serviceMode ? "service" : "foreground",
    dataDirectory,
  });
  let app: Awaited<ReturnType<typeof createLocalProductApp>>;
  try {
    app = await createLocalProductApp({
      conversationsPort: options.conversationsPort,
      controlPort: options.controlPort,
      webUrl,
      workspaceRoot,
      dataDirectory: dataDirectory,
      workspaceName,
      selectWorkspaceRoot: !freshInstallation && directoryArgumentProvided,
      runtimeAdapter: "pi",
      runtime,
      conversationsMigrationsFolder: defaultMigrationsFolder("conversations"),
      relayMigrationsFolder: defaultMigrationsFolder("agent-host"),
      onAudit(event) {
        diagnostic(JSON.stringify({ source: "minu-channels", ...event }));
      },
      onDiagnostic(event) {
        diagnostic(JSON.stringify({ source: "minu-channels", type: "agent-host-diagnostic", ...event }));
      },
    });
  } catch (error) {
    await installationInstance.close();
    throw error;
  }
  let web: Awaited<ReturnType<typeof createLocalWebServer>> | undefined;
  let serviceOpenBroker: Awaited<ReturnType<typeof startServiceOpenBroker>> | undefined;
  let serviceRestartBroker: Awaited<ReturnType<typeof startServiceRestartBroker>> | undefined;
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.all([
      serviceOpenBroker?.close().catch(() => undefined),
      serviceRestartBroker?.close().catch(() => undefined),
    ]);
    await web?.close().catch(() => undefined);
    await app.close();
    await installationInstance.close();
    await serviceLog?.close().catch(() => undefined);
  };
  const exitAfterQuiesce = async (action: ServiceQuiesceAction): Promise<void> => {
    try {
      await close();
    } finally {
      // launchd restarts only unsuccessful exits. Updates use a successful exit so
      // executable replacement happens while no process from this install is live.
      process.exitCode = action === "restart" ? 75 : 0;
    }
  };
  try {
    web = await createLocalWebServer({
      conversationsEndpoint: app.conversationsEndpoint,
      conversationsServiceToken: app.conversationsServiceToken,
      authenticateBrowser: app.authenticateBrowser,
      isQuiescing: () => app.workSnapshot().state !== "running",
      controlEndpoint: app.controlEndpoint,
      webDirectory: resolve(options.webDir ?? defaultWebDirectory()),
      port: options.webPort,
    });
    if (options.serviceMode) {
      serviceOpenBroker = await startServiceOpenBroker(dataDirectory, () => app.issueBrowserLaunchUrl());
      serviceRestartBroker = await startServiceRestartBroker(
        dataDirectory,
        () => app.workSnapshot(),
        () => app.waitForQuiesced(),
        { onQuiesced: exitAfterQuiesce },
      );
    }
    output("MinuChannels is ready");
    output(`  Web:      ${webUrl}`);
    output(`  Data:     ${app.dataDirectory}`);
    output(`  Workspace: ${workspaceRoot ?? "choose or create one in the browser"}`);
    output(`  Setup:    ${app.initialized
      ? (app.workspaceId ? "created a fresh local Workspace" : "ready for browser Workspace setup")
      : "reopened existing local data"}`);
    if (app.workspaceId) {
      output("  Agent:    click Start for @builder, then send a message for a live Pi response");
    }
    if (!options.serviceMode) {
      const launchUrl = app.issueBrowserLaunchUrl();
      if (options.open) {
        await openBrowser(launchUrl);
        output("Opened the authenticated local Workspace in your browser.");
      } else {
        output("Open this one-time URL within 60 seconds:");
        output(launchUrl);
      }
      output("Press Ctrl-C to stop MinuChannels.");
    }
  } catch (error) {
    await close();
    throw error;
  }

  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (backgroundServiceLog) await backgroundServiceLog.append(`MinuChannels stopped: ${message}`).catch(() => undefined);
  else console.error(message);
  // A launchd job that cannot initialize exits successfully so KeepAlive does not
  // turn a persistent configuration or lock conflict into a restart loop.
  process.exitCode = backgroundServiceMode ? 0 : 1;
});
