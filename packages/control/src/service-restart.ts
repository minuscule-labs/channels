import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LocalAgentHostWorkSnapshot } from "./agent-host.ts";

const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 135_000;
const REQUEST_MAX_AGE_MS = 180_000;
const TOKEN = /^[a-f0-9]{32}$/;

export type ServiceQuiesceAction = "restart" | "stop_for_update";

type RestartRequest = {
  token: string;
  createdAt: string;
  waitForIdle: boolean;
  action: ServiceQuiesceAction;
};

export type ServiceRestartResult = {
  status: "ready" | "busy";
  activeTurns: number;
  queuedTurns: number;
  queuedTurnsExact: boolean;
  pendingLifecycle: number;
};

type RestartResponse = ServiceRestartResult & {
  token: string;
  createdAt: string;
};

export interface ServiceRestartBroker { close(): Promise<void>; }

export async function startServiceRestartBroker(
  dataDirectory: string,
  snapshot: () => LocalAgentHostWorkSnapshot,
  quiesce: () => Promise<LocalAgentHostWorkSnapshot>,
  options: { intervalMs?: number; onQuiesced?(action: ServiceQuiesceAction): void | Promise<void> } = {},
): Promise<ServiceRestartBroker> {
  const directory = join(dataDirectory, "run", "restart");
  await preparePrivateDirectory(directory);
  const intervalMs = positiveInteger(options.intervalMs ?? DEFAULT_INTERVAL_MS, "intervalMs");
  let closed = false;
  let working = false;
  let readyAction: ServiceQuiesceAction | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const inspect = async (): Promise<void> => {
    if (closed || working) return;
    working = true;
    try {
      for (const name of await readdir(directory)) {
        const match = /^request-([a-f0-9]{32})\.json$/.exec(name);
        if (!match) {
          if (/^(?:response|ack)-[a-f0-9]{32}\.json(?:\.\d+\.[a-f0-9]{8}\.tmp)?$/.test(name)) {
            const stalePath = join(directory, name);
            const metadata = await lstat(stalePath);
            if (metadata.isSymbolicLink() || !metadata.isFile()
              || Date.now() - metadata.mtimeMs > REQUEST_MAX_AGE_MS) {
              await rm(stalePath, { force: true });
            }
          }
          continue;
        }
        const path = join(directory, name);
        const request = await readRequest(path, match[1]!);
        if (!request) continue;
        const response = join(directory, `response-${request.token}.json`);
        const acknowledgement = join(directory, `ack-${request.token}.json`);
        if (await hasValidResponse(response, request.token)) {
          await rm(path, { force: true });
          continue;
        }
        const before = snapshot();
        const result = !request.waitForIdle && (before.activeTurns > 0 || before.pendingLifecycle > 0)
          ? project("busy", before)
          : project("ready", await quiesce());
        if (result.status === "ready" && request.action === "stop_for_update"
          && !(await requestRemainsValid(path, request.token))) {
          readyAction = "restart";
          break;
        }
        const temporary = `${response}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(temporary, `${JSON.stringify({
          token: request.token,
          createdAt: new Date().toISOString(),
          ...result,
        })}\n`, { mode: 0o600, flag: "wx" });
        await chmod(temporary, 0o600);
        await rename(temporary, response);
        if (result.status !== "ready") {
          await rm(path, { force: true });
          continue;
        }
        if (request.action === "stop_for_update") {
          readyAction = await awaitUpdateAcknowledgement(path, acknowledgement, request.token, intervalMs, () => closed);
          if (readyAction) break;
          continue;
        }
        await rm(path, { force: true });
        readyAction = "restart";
        break;
      }
    } finally {
      working = false;
      if (readyAction && !closed) {
        closed = true;
        if (timer) clearInterval(timer);
        const action = readyAction;
        queueMicrotask(() => void Promise.resolve(options.onQuiesced?.(action)).catch(() => undefined));
      }
    }
  };
  timer = setInterval(() => void inspect().catch(() => undefined), intervalMs);
  timer.unref();
  await inspect();
  return {
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      while (working) await delay(10);
    },
  };
}

export async function requestServiceRestart(
  dataDirectory: string,
  options: {
    waitForIdle: boolean;
    action?: ServiceQuiesceAction;
    timeoutMs?: number;
    intervalMs?: number;
    onUpdateStopClaimed?(): void;
  },
): Promise<ServiceRestartResult> {
  const action = options.action ?? "restart";
  if (action === "stop_for_update" && typeof options.onUpdateStopClaimed !== "function") {
    throw new Error("Update shutdown requires a recovery owner");
  }
  const directory = join(dataDirectory, "run", "restart");
  await preparePrivateDirectory(directory);
  const token = randomBytes(16).toString("hex");
  const request = join(directory, `request-${token}.json`);
  const response = join(directory, `response-${token}.json`);
  const acknowledgement = join(directory, `ack-${token}.json`);
  await writeFile(request, `${JSON.stringify({
    token,
    createdAt: new Date().toISOString(),
    waitForIdle: options.waitForIdle,
    action,
  })}\n`, { mode: 0o600, flag: "wx" });
  await chmod(request, 0o600);
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const intervalMs = positiveInteger(options.intervalMs ?? DEFAULT_INTERVAL_MS, "intervalMs");
  const deadline = performance.now() + timeoutMs;
  try {
    while (performance.now() < deadline) {
      try {
        const metadata = await lstat(response);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_024) {
          throw new Error("Invalid service restart response");
        }
        const record = JSON.parse(await readFile(response, "utf8")) as RestartResponse;
        if (record.token !== token || !validResult(record)) throw new Error("Invalid service restart response");
        if (action === "stop_for_update" && record.status === "ready") {
          if (performance.now() >= deadline) {
            throw new Error("MinuChannels did not become ready to restart in time");
          }
          // Transfer recovery ownership before allowing the service to exit successfully.
          // If this process times out after claiming the stop, its caller must wait for
          // the old service PID to leave and restart the selected LaunchAgent.
          options.onUpdateStopClaimed?.();
          await writeFile(acknowledgement, `${JSON.stringify({ token })}\n`, { mode: 0o600, flag: "wx" });
          await chmod(acknowledgement, 0o600);
          while (performance.now() < deadline) {
            try {
              await lstat(request);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
              throw error;
            }
            await delay(intervalMs);
          }
          try {
            await lstat(request);
            throw new Error("MinuChannels did not accept update shutdown in time");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        return {
          status: record.status,
          activeTurns: record.activeTurns,
          queuedTurns: record.queuedTurns,
          queuedTurnsExact: record.queuedTurnsExact,
          pendingLifecycle: record.pendingLifecycle,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(intervalMs);
    }
    throw new Error("MinuChannels did not become ready to restart in time");
  } finally {
    await Promise.all([
      rm(request, { force: true }),
      rm(response, { force: true }),
      rm(acknowledgement, { force: true }),
    ]);
  }
}

async function awaitUpdateAcknowledgement(
  requestPath: string,
  acknowledgementPath: string,
  token: string,
  intervalMs: number,
  isClosed: () => boolean,
): Promise<ServiceQuiesceAction | undefined> {
  while (!isClosed()) {
    if (await hasValidAcknowledgement(acknowledgementPath, token)) {
      await Promise.all([
        rm(requestPath, { force: true }),
        rm(acknowledgementPath, { force: true }),
      ]);
      return "stop_for_update";
    }
    if (!(await requestRemainsValid(requestPath, token))) return "restart";
    await delay(intervalMs);
  }
  return undefined;
}

async function requestRemainsValid(path: string, token: string): Promise<boolean> {
  return (await readRequest(path, token)) !== undefined;
}

async function hasValidAcknowledgement(path: string, token: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256) {
      await rm(path, { force: true });
      return false;
    }
    const record = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
    if (record.token === token) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  }
  await rm(path, { force: true });
  return false;
}

function project(status: ServiceRestartResult["status"], value: LocalAgentHostWorkSnapshot): ServiceRestartResult {
  return {
    status,
    activeTurns: value.activeTurns,
    queuedTurns: value.queuedTurns,
    queuedTurnsExact: value.queuedTurnsExact,
    pendingLifecycle: value.pendingLifecycle,
  };
}

async function readRequest(path: string, token: string): Promise<RestartRequest | undefined> {
  let request: RestartRequest;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_024) {
      await rm(path, { force: true });
      return undefined;
    }
    request = JSON.parse(await readFile(path, "utf8")) as RestartRequest;
  } catch {
    await rm(path, { force: true });
    return undefined;
  }
  const createdAt = Date.parse(request.createdAt);
  if (request.token !== token || !TOKEN.test(request.token)
    || typeof request.waitForIdle !== "boolean"
    || (request.action !== "restart" && request.action !== "stop_for_update")
    || !Number.isFinite(createdAt) || Math.abs(Date.now() - createdAt) > REQUEST_MAX_AGE_MS) {
    await rm(path, { force: true });
    return undefined;
  }
  return request;
}

async function hasValidResponse(path: string, token: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_024) {
      await rm(path, { force: true });
      return false;
    }
    const record = JSON.parse(await readFile(path, "utf8")) as RestartResponse;
    if (record.token === token && validResult(record)) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  }
  await rm(path, { force: true });
  return false;
}

function validResult(value: RestartResponse): boolean {
  return (value.status === "ready" || value.status === "busy")
    && Number.isSafeInteger(value.activeTurns) && value.activeTurns >= 0
    && Number.isSafeInteger(value.queuedTurns) && value.queuedTurns >= 0
    && typeof value.queuedTurnsExact === "boolean"
    && Number.isSafeInteger(value.pendingLifecycle) && value.pendingLifecycle >= 0;
}

async function preparePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Service restart exchange must use a private local directory");
  }
  await chmod(directory, 0o700);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
