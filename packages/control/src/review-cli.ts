#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalReviewApp } from "./review.ts";

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
  if (arguments_[0] === "--") arguments_.shift();
  const { values } = parseArgs({
    args: arguments_,
    options: {
      "channels-port": { type: "string" },
      "control-port": { type: "string" },
      "web-port": { type: "string" },
      cwd: { type: "string" },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(`Usage: pnpm dev [-- options]\n\nOptions:\n  --channels-port <port>  Channels API port (default 4310)\n  --control-port <port>   local control port (default 4311)\n  --web-port <port>       web client port (default 5174)\n  --cwd <path>            private review Workspace root\n  --no-open               print launch URL instead of opening a browser\n  -h, --help              show help`);
    return;
  }

  const channelsPort = port(values["channels-port"], 4310, "channels-port");
  const controlPort = port(values["control-port"], 4311, "control-port");
  const webPort = port(values["web-port"], 5174, "web-port");
  if (new Set([channelsPort, controlPort, webPort]).size !== 3) {
    throw new Error("Review service ports must be distinct");
  }
  const webUrl = `http://127.0.0.1:${webPort}/`;
  const app = await createLocalReviewApp({
    channelsPort,
    controlPort,
    webUrl,
    workspaceRoot: values.cwd,
    onAudit(event) {
      process.stderr.write(`${JSON.stringify({ source: "minu-channels-review", ...event })}\n`);
    },
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
    console.log("\nMinuChannels review app is ready");
    console.log(`  Web:      ${webUrl}`);
    console.log(`  Channels: ${app.channelsEndpoint}`);
    console.log(`  Control:  ${app.controlEndpoint}`);
    console.log("  Handles:  @you, @builder, @reviewer");
    console.log("  Agent:    @mention @builder for a simulated Relay response");
    console.log("  Context:  unaddressed messages do not wake agents");
    console.log("  Data:     disposable; removed on shutdown");
    if (values["no-open"]) {
      console.log("\nOpen this one-time URL within 60 seconds:");
      console.log(launchUrl);
    } else {
      await openBrowser(launchUrl);
      console.log("\nOpened the authenticated review Workspace in your browser.");
    }
    console.log("Press Ctrl-C to stop all review services.");
  } catch (error) {
    await close();
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
