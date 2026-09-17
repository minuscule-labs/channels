import { lstat, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  acquireConversationsDataDirectoryLock,
  prepareConversationsDataDirectory,
} from "./local-paths.ts";

export function developmentDataDirectory(homeDirectory = homedir()): string {
  return join(resolve(homeDirectory), ".minu", "channels-dev");
}

export async function resetDevelopmentData(options: {
  homeDirectory?: string;
} = {}): Promise<"absent" | "removed"> {
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const dataDirectory = developmentDataDirectory(homeDirectory);
  let metadata;
  try {
    metadata = await lstat(dataDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Development data reset refused an unsafe data directory");
  }
  const [canonicalHome, canonicalData] = await Promise.all([
    realpath(homeDirectory),
    realpath(dataDirectory),
  ]);
  if (canonicalData !== join(canonicalHome, ".minu", "channels-dev")) {
    throw new Error("Development data reset refused a redirected data directory");
  }

  await prepareConversationsDataDirectory(dataDirectory);
  const runMetadata = await lstat(join(dataDirectory, "run"));
  if (runMetadata.isSymbolicLink() || !runMetadata.isDirectory()) {
    throw new Error("Development data reset refused an unsafe lock directory");
  }
  const lock = await acquireConversationsDataDirectoryLock(dataDirectory);
  try {
    await rm(dataDirectory, { recursive: true });
  } finally {
    await lock.release();
  }
  return "removed";
}
