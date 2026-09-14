import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REQUEST_INTERVAL_MS = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const REQUEST_MAX_AGE_MS = 30_000;
const TOKEN = /^[a-f0-9]{32}$/;

interface ServiceOpenRecord {
  token: string;
  createdAt: string;
  url?: string;
}

export interface ServiceOpenBroker { close(): Promise<void>; }

/**
 * Exchanges owner-only filesystem requests for short-lived browser bootstrap URLs.
 * The URL never appears in process arguments, launchd metadata, or service output.
 */
export async function startServiceOpenBroker(
  dataDirectory: string,
  issueBrowserLaunchUrl: () => string,
): Promise<ServiceOpenBroker> {
  const directory = join(dataDirectory, "run", "open");
  await preparePrivateDirectory(directory);
  const readyPath = join(directory, "ready.json");
  const readyToken = randomBytes(16).toString("hex");
  const readyTemporary = `${readyPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(readyTemporary, `${JSON.stringify({ pid: process.pid, token: readyToken })}\n`, { mode: 0o600, flag: "wx" });
  await chmod(readyTemporary, 0o600);
  await rename(readyTemporary, readyPath);
  let closed = false;
  let working = false;
  const inspect = async (): Promise<void> => {
    if (closed || working) return;
    working = true;
    try {
      for (const name of await readdir(directory)) {
        const match = /^request-([a-f0-9]{32})\.json$/.exec(name);
        if (!match) {
          if (/^response-[a-f0-9]{32}\.json(?:\.\d+\.[a-f0-9]{8}\.tmp)?$/.test(name)) {
            const stalePath = join(directory, name);
            const age = Date.now() - (await stat(stalePath)).mtimeMs;
            if (age > REQUEST_MAX_AGE_MS) await rm(stalePath, { force: true });
          }
          continue;
        }
        const path = join(directory, name);
        let record: ServiceOpenRecord | undefined;
        try {
          record = JSON.parse(await readFile(path, "utf8")) as ServiceOpenRecord;
        } catch {
          await rm(path, { force: true });
          continue;
        }
        const createdAt = Date.parse(record.createdAt);
        if (record.token !== match[1] || !TOKEN.test(record.token)
          || !Number.isFinite(createdAt) || Math.abs(Date.now() - createdAt) > REQUEST_MAX_AGE_MS) {
          await rm(path, { force: true });
          continue;
        }
        const response = join(directory, `response-${record.token}.json`);
        const temporary = `${response}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(temporary, `${JSON.stringify({
          token: record.token,
          createdAt: new Date().toISOString(),
          url: issueBrowserLaunchUrl(),
        })}\n`, { mode: 0o600, flag: "wx" });
        await chmod(temporary, 0o600);
        await rename(temporary, response);
        await rm(path, { force: true });
      }
    } finally {
      working = false;
    }
  };
  const timer = setInterval(() => void inspect().catch(() => undefined), REQUEST_INTERVAL_MS);
  timer.unref();
  await inspect();
  return {
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      while (working) await delay(10);
      try {
        const current = JSON.parse(await readFile(readyPath, "utf8")) as { token?: unknown };
        if (current.token === readyToken) await rm(readyPath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

export async function requestServiceBrowserLaunchUrl(
  dataDirectory: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const directory = join(dataDirectory, "run", "open");
  await preparePrivateDirectory(directory);
  const token = randomBytes(16).toString("hex");
  const request = join(directory, `request-${token}.json`);
  const response = join(directory, `response-${token}.json`);
  await writeFile(request, `${JSON.stringify({ token, createdAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
  const deadline = Date.now() + (options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    while (Date.now() < deadline) {
      try {
        const record = JSON.parse(await readFile(response, "utf8")) as ServiceOpenRecord;
        if (record.token !== token || typeof record.url !== "string") throw new Error("Invalid service response");
        const url = new URL(record.url);
        if (url.protocol !== "http:" || url.hostname !== "minu-channels.localhost") {
          throw new Error("Invalid service browser URL");
        }
        return url.href;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(REQUEST_INTERVAL_MS);
    }
    throw new Error("MinuChannels did not become ready in time");
  } finally {
    await Promise.all([rm(request, { force: true }), rm(response, { force: true })]);
  }
}

async function preparePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Service open exchange must use a private local directory");
  }
  await chmod(directory, 0o700);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
