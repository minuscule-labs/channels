import { chmod, lstat, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_MAXIMUM_BYTES = 1_048_576;

/** Serialized, owner-only rolling output bounded across the current and previous files. */
export class BoundedServiceLog {
  private pending = Promise.resolve();

  constructor(
    readonly path: string,
    readonly maximumBytes = DEFAULT_MAXIMUM_BYTES,
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 2) {
      throw new RangeError("maximumBytes must be an integer of at least two bytes");
    }
  }

  append(value: string): Promise<void> {
    const line = Buffer.from(value.endsWith("\n") ? value : `${value}\n`, "utf8");
    const operation = this.pending.catch(() => undefined).then(() => this.write(line));
    this.pending = operation;
    return operation;
  }

  close(): Promise<void> {
    return this.pending;
  }

  private async write(input: Buffer): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new Error("Service log directory must be a private local directory");
    }
    await chmod(directory, 0o700);
    const outputMetadata = await lstat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (outputMetadata && (!outputMetadata.isFile() || outputMetadata.isSymbolicLink())) {
      throw new Error("Service log must be a private local file");
    }

    const segmentBytes = Math.floor(this.maximumBytes / 2);
    const line = input.length > segmentBytes ? input.subarray(input.length - segmentBytes) : input;
    const currentBytes = await stat(this.path).then(({ size }) => size).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
    if (currentBytes > 0 && currentBytes + line.length > segmentBytes) {
      const previous = `${this.path}.previous`;
      await rm(previous, { force: true });
      await rename(this.path, previous);
      await chmod(previous, 0o600);
    }
    const file = await open(this.path, "a", 0o600);
    try { await file.write(line); }
    finally { await file.close(); }
    await chmod(this.path, 0o600);
  }
}
