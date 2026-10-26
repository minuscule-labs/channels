import type { MessageAttachment } from "@minu/channels-core/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageImages } from "../src/components/message-images";
import { createMessageSubmission, submissionMatchesDraft } from "../src/lib/composer";

const attachment: MessageAttachment = {
  id: `attachment_${"1".repeat(32)}`, filename: "screen.png", mimeType: "image/png", size: 68,
  contentUrl: "https://untrusted.invalid/tracker.png",
};

describe("structured images", () => {
  it("derives URLs from resource IDs, never persisted or remote content URLs", () => {
    const html = renderToStaticMarkup(<MessageImages conversationId="conversation-1" attachments={[attachment]} />);
    expect(html).toContain(`/conversations/conversation-1/attachments/${attachment.id}/content`);
    expect(html).not.toContain("untrusted.invalid");
    expect(html).toContain('alt="screen.png"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('aria-label="Open image screen.png"');
  });

  it("provides an accessible fallback for invalid IDs without issuing image requests", () => {
    const html = renderToStaticMarkup(<MessageImages conversationId="conversation-1" attachments={[{ ...attachment, id: "../../outside" }]} />);
    expect(html).toContain('aria-label="Image unavailable: screen.png"');
    expect(html).not.toContain("<img");
  });

  it("includes ordered image IDs in retry matching without changing the text body", () => {
    const ids = [attachment.id, `attachment_${"2".repeat(32)}`];
    const submission = createMessageSubmission("owner", "", [], () => "same-request", ids);
    expect(submission.input.body).toBe("");
    expect(submission.input.attachmentIds).toEqual(ids);
    expect(submissionMatchesDraft(submission, "owner", "", [], ids)).toBe(true);
    expect(submissionMatchesDraft(submission, "owner", "", [], [...ids].reverse())).toBe(false);
    expect(submissionMatchesDraft(submission, "owner", "", [], [])).toBe(false);
  });
});
