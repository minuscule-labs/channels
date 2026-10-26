import type { MessageAttachment } from "@minu/channels-core/types";
import { useEffect, useRef, useState } from "react";
import { conversations } from "./api";

import { MAX_IMAGE_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_MESSAGE_ATTACHMENT_BYTES } from "@minu/channels-core/image-validation";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const IMAGE_BYTES = MAX_IMAGE_BYTES;
export const IMAGE_TOTAL_BYTES = MAX_MESSAGE_ATTACHMENT_BYTES;
export const IMAGE_COUNT = MAX_ATTACHMENTS_PER_MESSAGE;

interface DraftImage {
  key: string;
  filename: string;
  size: number;
  preview?: string;
  attachment?: MessageAttachment;
  error?: string;
}

function restore(key: string): DraftImage[] {
  try {
    const records: MessageAttachment[] = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(records)) return [];
    return records.filter((record) => record && /^attachment_[0-9a-f]{32}$/.test(record.id)
      && typeof record.filename === "string" && IMAGE_TYPES.includes(record.mimeType)
      && Number.isSafeInteger(record.size) && record.size > 0 && record.size <= IMAGE_BYTES)
      .slice(0, IMAGE_COUNT).map((attachment) => ({ key: attachment.id, filename: attachment.filename, size: attachment.size, attachment }));
  } catch { return []; }
}

export function useImageDraft(storageKey: string, conversationId: string, participantId: string) {
  const [images, setImages] = useState<DraftImage[]>(() => restore(storageKey));
  const [error, setError] = useState<string>();
  const imagesRef = useRef(images);
  const controllers = useRef(new Map<string, AbortController>());
  const previews = useRef(new Map<string, string>());
  const update = (next: DraftImage[]) => {
    imagesRef.current = next;
    setImages(next);
    // Only server-owned metadata; never put image bytes or blob URLs in localStorage.
    localStorage.setItem(storageKey, JSON.stringify(next.flatMap((image) => image.attachment ? [image.attachment] : [])));
  };
  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort();
    for (const preview of previews.current.values()) URL.revokeObjectURL(preview);
  }, []);

  const release = (key: string) => {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    const preview = previews.current.get(key);
    if (preview) URL.revokeObjectURL(preview);
    previews.current.delete(key);
  };
  const remove = (key: string) => {
    release(key);
    update(imagesRef.current.filter((image) => image.key !== key));
  };
  const clear = () => {
    for (const image of imagesRef.current) release(image.key);
    update([]);
  };
  const add = (files: File[]) => {
    if (!participantId) return;
    setError(undefined);
    for (const file of files) {
      const current = imagesRef.current;
      if (!IMAGE_TYPES.includes(file.type) || !file.size || file.size > IMAGE_BYTES) {
        setError("Choose PNG, JPEG, GIF, or WebP images up to 10 MiB each.");
        continue;
      }
      if (current.length >= IMAGE_COUNT || current.reduce((sum, image) => sum + image.size, 0) + file.size > IMAGE_TOTAL_BYTES) {
        setError("A message can contain up to four images and 20 MiB total.");
        continue;
      }
      const key = crypto.randomUUID();
      const controller = new AbortController();
      const preview = URL.createObjectURL(file);
      controllers.current.set(key, controller);
      previews.current.set(key, preview);
      update([...current, { key, filename: file.name, size: file.size, preview }]);
      void file.arrayBuffer().then((buffer) => {
        controller.signal.throwIfAborted();
        return conversations.uploadAttachment(conversationId, { filename: file.name,
          mimeType: file.type as MessageAttachment["mimeType"], bytes: new Uint8Array(buffer),
          actorIdentityId: participantId, signal: controller.signal });
      }).then((attachment) => {
        update(imagesRef.current.map((image) => image.key === key ? { ...image, attachment } : image));
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) update(imagesRef.current.map((image) => image.key === key
          ? { ...image, error: cause instanceof Error ? cause.message : "Image upload failed" } : image));
      }).finally(() => { controllers.current.delete(key); });
    }
  };
  return { images, add, remove, clear, error, dismissError: () => setError(undefined),
    ids: images.flatMap((image) => image.attachment ? [image.attachment.id] : []),
    ready: images.every((image) => Boolean(image.attachment)) };
}

/** Never render a URL supplied by Markdown or persisted draft metadata. */
export function imageContentUrl(conversationId: string, id: string): string | undefined {
  if (!/^attachment_[0-9a-f]{32}$/.test(id)) return undefined;
  return `${conversations.endpoint}/conversations/${encodeURIComponent(conversationId)}/attachments/${id}/content`;
}
