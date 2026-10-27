import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ConversationsDataDirectoryOptions {
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

/** Resolves Conversations state without writing directly into the shared Minu root. */
export function resolveConversationsDataDirectory(
  options: ConversationsDataDirectoryOptions = {},
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

export async function prepareConversationsDataDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const runDirectory = join(path, "run");
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await chmod(runDirectory, 0o700);
}

const LOCK_INITIALIZATION_GRACE_MS = 30_000;
const heldLockDatabases = new Set<string>();

export async function acquireConversationsDataDirectoryLock(
  dataDirectory: string,
): Promise<ProductDirectoryLock> {
  // Hold the SQLite writer lock for the entire product lifetime, including marker recovery
  // and removal. The database inode must remain in place so every contender locks it.
  const releaseDatabaseLock = await acquireLockDatabase(dataDirectory);
  const lockPath = join(dataDirectory, "run", "instance.lock");
  const ownerPath = join(lockPath, "owner.json");
  const token = randomUUID();
  const contents = `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`;
  let createdMarker = false;
  try {
    // Preserve legacy live-owner and initialization checks for older installations that
    // do not take the SQLite lock. Stop those installations before upgrading.
    const existing = await inspectLock(lockPath, ownerPath);
    if (existing.kind === "live" || existing.kind === "initializing") {
      throw new Error(`MinuChannels is already using data directory: ${dataDirectory}`);
    }
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath, { mode: 0o700 });
    createdMarker = true;
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
        } finally {
          releaseDatabaseLock();
        }
      },
    };
  } catch (error) {
    try {
      if (createdMarker) await rm(lockPath, { recursive: true, force: true });
    } finally {
      releaseDatabaseLock();
    }
    throw error;
  }
}

async function acquireLockDatabase(dataDirectory: string): Promise<() => void> {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new Error("MinuChannels data-directory locking requires Node.js 22.13 or newer, or Node.js 22.5+ with --experimental-sqlite");
  }
  const databasePath = join(await realpath(join(dataDirectory, "run")), "instance-lock.sqlite");
  // Serialize same-process initialization too: closing a separate filesystem descriptor
  // for this inode could otherwise release that process's POSIX SQLite locks.
  if (heldLockDatabases.has(databasePath)) {
    throw new Error(`MinuChannels is already using data directory: ${dataDirectory}`);
  }
  heldLockDatabases.add(databasePath);
  try {
    try {
      const handle = await open(databasePath, "wx", 0o600);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(databasePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
      throw new Error("MinuChannels data-directory lock database is redirected or not owned by this user");
    }
    if ((metadata.mode & 0o777) !== 0o600) await chmod(databasePath, 0o600);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      database.close();
      throw error;
    }
    return () => {
      try {
        try {
          database.exec("ROLLBACK");
        } finally {
          database.close();
        }
      } finally {
        heldLockDatabases.delete(databasePath);
      }
    };
  } catch (error) {
    heldLockDatabases.delete(databasePath);
    const errcode = (error as { errcode?: unknown } | null)?.errcode;
    if (typeof errcode === "number" && (errcode & 0xff) === 5) {
      throw new Error(`MinuChannels is already using data directory: ${dataDirectory}`);
    }
    throw error;
  }
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
