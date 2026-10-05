import type { LocalTurnFailureNotice } from "@minu/channels-control/contracts";
import type { ConversationMessage, Participant } from "@minu/channels-core/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationTimeline } from "../src/components/conversation-timeline";

const human: Participant = { id: "human-id", type: "human", handle: "owner", displayName: "Owner", status: "active" };
const builder: Participant = { id: "builder-id", type: "agent", handle: "builder", displayName: "Builder", status: "active" };
const legacy: Participant = { id: "legacy-id", type: "agent", handle: "channel", displayName: "Former channel agent", status: "active" };
const attributionParticipants = [human, builder, legacy];
const messages: ConversationMessage[] = [
  {
    id: "historical", conversationId: "conversation-id", sequence: 1, participantId: legacy.id,
    body: "Historical update", to: [builder.id], createdAt: "2025-01-01T10:00:00.000Z",
  },
  {
    id: "broadcast", conversationId: "conversation-id", sequence: 2, participantId: human.id,
    body: "Broadcast", to: ["@conversation"], createdAt: "2025-01-01T10:01:00.000Z",
  },
  {
    id: "continuation", conversationId: "conversation-id", sequence: 3, participantId: human.id,
    body: "Continued broadcast", to: ["@conversation"], createdAt: "2025-01-01T10:01:10.000Z",
  },
];

function render(participants: Participant[]) {
  return renderToStaticMarkup(<ConversationTimeline messages={messages} participants={participants} attributionParticipants={attributionParticipants} />);
}

describe("Conversation broadcast labels", () => {
  it("ignores Workspace-only collisions while retaining historical author and recipient labels", () => {
    const html = render([human, builder]);
    expect(html.match(/>to @channel</g)).toHaveLength(2);
    expect(html).not.toContain(">to @conversation<");
    expect(html).toContain("Former channel agent");
    expect(html).toContain(">to @builder<");
  });

  it("restores @channel after removing a collision from the roster, without losing attribution", () => {
    const before = render([human, builder, legacy]);
    expect(before.match(/>to @conversation</g)).toHaveLength(2);
    const after = render([human, builder]);
    expect(after.match(/>to @channel</g)).toHaveLength(2);
    expect(after).toContain("Former channel agent");
    expect(after).not.toContain(">to @conversation<");
  });

  it("retains the explicit fallback for a disabled collision still in the roster", () => {
    const html = render([human, builder, { ...legacy, status: "disabled" }]);
    expect(html.match(/>to @conversation</g)).toHaveLength(2);
    expect(html).not.toContain(">to @channel<");
  });

  it("anchors a short clickable issue notice after its triggering message while keeping details gated", () => {
    const notice: LocalTurnFailureNotice = {
      participant: { identityId: builder.id, displayLabel: "Builder" },
      triggerSequence: 2,
      failedAt: "2025-01-01T10:02:00.000Z",
    };
    const ownerHtml = renderToStaticMarkup(<ConversationTimeline
      messages={messages}
      participants={[human, builder]}
      turnFailureNotices={[notice]}
      canOpenIssueDetails
      onViewIssueDetails={() => undefined}
    />);
    expect(ownerHtml).toContain('aria-label="View Runtime issue details for Builder"');
    expect(ownerHtml).toContain("Something went wrong with Builder");
    expect(ownerHtml).toContain("View details");
    expect(ownerHtml.indexOf("Broadcast")).toBeLessThan(ownerHtml.indexOf("Something went wrong with Builder"));
    expect(ownerHtml.indexOf("Something went wrong with Builder")).toBeLessThan(ownerHtml.indexOf("Continued broadcast"));

    const memberHtml = renderToStaticMarkup(<ConversationTimeline
      messages={messages}
      participants={[human, builder]}
      turnFailureNotices={[notice]}
    />);
    expect(memberHtml).toContain('aria-label="Issue notice for Builder"');
    expect(memberHtml).toContain("An owner or admin can review the details.");
    expect(memberHtml).not.toContain('aria-label="View Runtime issue details for Builder"');
  });
});
