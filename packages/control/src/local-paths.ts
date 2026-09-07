import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

const LOCK_INITIALIZATION_GRACE_MS = 30_000;

export async function acquireChannelsDataDirectoryLock(
  dataDirectory: string,
): Promise<ProductDirectoryLock> {
  const lockPath = join(dataDirectory, "run", "instance.lock");
  const ownerPath = join(lockPath, "owner.json");
  const token = randomUUID();
  const contents = `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const temporaryOwner = join(lockPath, `.owner-${token}.tmp`);
      await writeFile(temporaryOwner, contents, { mode: 0o600 });
      await rename(temporaryOwner, ownerPath);
      let released = false;
      return {
        path: lockPath,
        async release() {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown };
            if (current.token === token) await rm(lockPath, { recursive: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await inspectLock(lockPath, ownerPath);
      const observedOwner = await readFile(ownerPath, "utf8").catch(() => undefined);
      if (existing.kind === "legacy-stale") {
        await rm(lockPath, { force: true });
        continue;
      }
      if (existing.kind === "live" || existing.kind === "initializing") {
        throw new Error(`MinuChannels is already using data directory: ${dataDirectory}`);
      }

      // Recovery is serialized inside the stale lock directory. Only its winner may rename it.
      const recoveryClaim = join(lockPath, "recovery.claim");
      let claim;
      try {
        claim = await open(recoveryClaim, "wx", 0o600);
        await claim.writeFile(token);
        await claim.close();
      } catch (claimError) {
        await claim?.close().catch(() => {});
        if ((claimError as NodeJS.ErrnoException).code === "EEXIST"
          || (claimError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw claimError;
      }
      const currentOwner = await readFile(ownerPath, "utf8").catch(() => undefined);
      if (currentOwner !== observedOwner) {
        await rm(recoveryClaim, { force: true }).catch(() => {});
        throw new Error(`MinuChannels is already using data directory: ${dataDirectory}`);
      }
      const quarantine = `${lockPath}.stale-${token}`;
      try {
        await rename(lockPath, quarantine);
        await rm(quarantine, { recursive: true, force: true });
      } catch (recoveryError) {
        if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw recoveryError;
      }
    }
  }
  throw new Error(`Unable to acquire MinuChannels data directory lock: ${dataDirectory}`);
}

type LockInspection = { kind: "live" | "stale" | "initializing" | "legacy-stale" };

async function inspectLock(lockPath: string, ownerPath: string): Promise<LockInspection> {
  try {
    const metadata = await stat(lockPath);
    if (metadata.isFile()) {
      const pid = await lockOwnerPid(lockPath);
      return pid !== undefined && processIsRunning(pid) ? { kind: "live" } : { kind: "legacy-stale" };
    }
    const pid = await lockOwnerPid(ownerPath);
    if (pid !== undefined) return processIsRunning(pid) ? { kind: "live" } : { kind: "stale" };
    return Date.now() - metadata.mtimeMs < LOCK_INITIALIZATION_GRACE_MS
      ? { kind: "initializing" }
      : { kind: "stale" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "stale" };
    throw error;
  }
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
