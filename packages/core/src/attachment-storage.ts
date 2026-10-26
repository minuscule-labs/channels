import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, opendir, rm } from "node:fs/promises";
import { MAX_IMAGE_BYTES } from "./image-validation.ts";
import { resolve, sep } from "node:path";

export interface AttachmentContentStore {
  put(attachmentId: string, bytes: Uint8Array): Promise<void>;
  get(attachmentId: string): Promise<Uint8Array | undefined>;
  delete(attachmentId: string): Promise<void>;
  cleanupOrphans?(cutoff: string, isReferenced: (id: string) => Promise<boolean>): Promise<void>;
}

function assertAttachmentId(attachmentId: string): void {
  if (!/^attachment_[0-9a-f]{32}$/.test(attachmentId)) {
    throw new Error("Invalid attachment id");
  }
}

/** Temporary/review storage. Production local state should use FilesystemAttachmentContentStore. */
export class InMemoryAttachmentContentStore implements AttachmentContentStore {
  private readonly objects = new Map<string, Uint8Array>();

  async put(attachmentId: string, bytes: Uint8Array): Promise<void> {
    assertAttachmentId(attachmentId);
    this.objects.set(attachmentId, Uint8Array.from(bytes));
  }

  async get(attachmentId: string): Promise<Uint8Array | undefined> {
    assertAttachmentId(attachmentId);
    const bytes = this.objects.get(attachmentId);
    return bytes ? Uint8Array.from(bytes) : undefined;
  }

  async delete(attachmentId: string): Promise<void> {
    assertAttachmentId(attachmentId);
    this.objects.delete(attachmentId);
  }
}

/** Owner-private file storage. IDs, never user filenames, are the only path components. */
export class FilesystemAttachmentContentStore implements AttachmentContentStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(attachmentId: string): string {
    assertAttachmentId(attachmentId);
    const path = resolve(this.root, attachmentId);
    if (!path.startsWith(`${this.root}${sep}`)) throw new Error("Attachment path escaped storage root");
    return path;
  }

  async put(attachmentId: string, bytes: Uint8Array): Promise<void> {
    const target = this.path(attachmentId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.root)).isDirectory()) throw new Error("Attachment root must be a real directory");
    await chmod(this.root, 0o700);
    const temporary = resolve(this.root, `.${attachmentId}.${randomUUID()}.tmp`);
    let linked = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      await link(temporary, target);
      linked = true;
      await chmod(target, 0o600);
    } catch (error) {
      if (linked) await rm(target, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async get(attachmentId: string): Promise<Uint8Array | undefined> {
    try {
      const path = this.path(attachmentId);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.size > MAX_IMAGE_BYTES) throw new Error("Invalid image file");
      const file = await open(path, "r");
      try { return new Uint8Array(await file.readFile()); }
      finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async delete(attachmentId: string): Promise<void> {
    await rm(this.path(attachmentId), { force: true });
  }

  async cleanupOrphans(cutoff: string, isReferenced: (id: string) => Promise<boolean>): Promise<void> {
    let directory;
    try { directory = await opendir(this.root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for await (const entry of directory) {
      const match = /^(attachment_[0-9a-f]{32})$|^\.(attachment_[0-9a-f]{32})\.[0-9a-f-]+\.tmp$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const path = resolve(this.root, entry.name);
      const metadata = await lstat(path).catch(() => undefined);
      if (!metadata || metadata.mtimeMs >= Date.parse(cutoff)) continue;
      // Temporary files and final bytes without metadata can survive an interrupted upload.
      if (match[2] || !(await isReferenced(match[1]!))) await rm(path, { force: true });
    }
  }
}
