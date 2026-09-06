import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ChannelsDataDirectoryOptions {
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

export interface ProductDirectoryLock {
  path: string;
  release(): Promise<void>;
}

function configuredPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function resolveFromHome(value: string, homeDirectory: string): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/")) return resolve(homeDirectory, value.slice(2));
  return resolve(value);
}

/** Resolves Channels state without writing directly into the shared Minu root. */
export function resolveChannelsDataDirectory(
  options: ChannelsDataDirectoryOptions = {},
): string {
  const env = options.env ?? process.env;
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const explicit = configuredPath(options.explicit);
  if (explicit) return resolveFromHome(explicit, homeDirectory);
  const productHome = configuredPath(env.MINU_CHANNELS_HOME);
  if (productHome) return resolveFromHome(productHome, homeDirectory);
  const minuHome = configuredPath(env.MINU_HOME);
  return minuHome
    ? join(resolveFromHome(minuHome, homeDirectory), "channels")
    : join(homeDirectory, ".minu", "channels");
}

export async function prepareChannelsDataDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const runDirectory = join(path, "run");
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await chmod(runDirectory, 0o700);
}

export async function acquireChannelsDataDirectoryLock(
  dataDirectory: string,
): Promise<ProductDirectoryLock> {
  const lockPath = join(dataDirectory, "run", "instance.lock");
  const token = randomUUID();
  const contents = `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(lockPath, 0o600);
      let released = false;
      return {
        path: lockPath,
        async release() {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
            if (current.token === token) await rm(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = await lockOwnerPid(lockPath);
      if (pid !== undefined && processIsRunning(pid)) {
        throw new Error(`MinuChannels is already using data directory: ${dataDirectory}`);
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error(`Unable to acquire MinuChannels data directory lock: ${dataDirectory}`);
}

async function lockOwnerPid(path: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
