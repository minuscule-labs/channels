import type { MessageAttachment } from "@minu/channels-core/types";
import { useState } from "react";
import { imageContentUrl } from "../lib/image-draft";

function MessageImage({ attachment, conversationId }: { attachment: MessageAttachment; conversationId: string }) {
  const [failed, setFailed] = useState(false);
  const src = imageContentUrl(conversationId, attachment.id);
  if (!src || failed) return <span role="img" aria-label={`Image unavailable: ${attachment.filename}`} className="text-xs text-[var(--muted)]">{attachment.filename} — image unavailable</span>;
  return <a href={src} target="_blank" rel="noopener noreferrer" aria-label={`Open image ${attachment.filename}`} className="block w-fit max-w-full rounded focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
    <img src={src} alt={attachment.filename} loading="lazy" decoding="async" onError={() => setFailed(true)}
      className="max-h-96 max-w-full rounded border border-[var(--border)] object-contain" />
  </a>;
}

export function MessageImages({ attachments, conversationId }: { attachments: MessageAttachment[]; conversationId: string }) {
  if (!attachments.length) return null;
  return <div className="mt-2 flex flex-col items-start gap-2" aria-label="Attached images">
    {attachments.map((attachment) => <MessageImage key={attachment.id} attachment={attachment} conversationId={conversationId} />)}
  </div>;
}
