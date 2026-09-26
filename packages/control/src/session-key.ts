import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** One key per owner-private installation; never copy it into URLs, logs or browser storage. */
export async function loadBrowserSessionKey(path: string): Promise<Buffer> {
  let created = false;
  let file;
  try {
    file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || metadata.nlink !== 1) {
      throw new Error("Browser session key must be an owner-private regular file");
    }
    if (created) {
      const key = randomBytes(32);
      await file.writeFile(key);
      await file.sync();
      return key;
    }
    const key = await file.readFile();
    if (key.length !== 32) throw new Error("Browser session key is invalid");
    return key;
  } finally {
    await file.close();
  }
}
