import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface PiRuntimeHostConfig {
  extensionPaths: string[];
}

const MAX_CONFIG_BYTES = 64 * 1024;
const INVALID_CONFIG = "Invalid Pi Runtime host configuration: use only extensionPaths with at most 100 unique absolute paths or builtin:<name> entries";

/** Private, installation-wide Pi policy. Never returned through the control API. */
export async function readPiRuntimeHostConfig(options: {
  dataDirectory?: string;
  filePath?: string;
}): Promise<PiRuntimeHostConfig> {
  const path = options.filePath !== undefined
    ? resolve(options.filePath)
    : options.dataDirectory ? join(options.dataDirectory, "pi-runtime.json") : undefined;
  if (path === undefined) return { extensionPaths: [] };
  if (options.filePath !== undefined && !options.filePath.trim()) throw new Error(INVALID_CONFIG);

  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (options.filePath === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { extensionPaths: [] };
    }
    throw new Error("Pi Runtime host configuration could not be read");
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
      throw new Error("Pi Runtime host configuration must be an owner-only regular file (chmod 600)");
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) throw new Error("Pi Runtime host configuration exceeds 64 KiB");
    let config: unknown;
    try { config = JSON.parse(buffer.subarray(0, length).toString("utf8")); }
    catch { throw new Error(INVALID_CONFIG); }
    if (!config || typeof config !== "object" || Array.isArray(config)
      || Object.keys(config).some((key) => key !== "extensionPaths")) {
      throw new Error(INVALID_CONFIG);
    }
    const paths = (config as Record<string, unknown>).extensionPaths;
    if (paths === undefined) return { extensionPaths: [] };
    if (!Array.isArray(paths) || paths.length > 100
      || paths.some((value) => typeof value !== "string" || !value.trim() || value !== value.trim()
        || value.length > 4_096 || value.includes("\0")
        || (!isAbsolute(value) && !/^builtin:[a-z0-9_-]+$/.test(value)))) {
      throw new Error(INVALID_CONFIG);
    }
    const extensionPaths = paths.map((value: string) => value.startsWith("builtin:") ? value : resolve(value));
    if (new Set(extensionPaths).size !== extensionPaths.length) throw new Error(INVALID_CONFIG);
    return { extensionPaths };
  } finally {
    await file.close();
  }
}
