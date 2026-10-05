import { describe, expect, it } from "vitest";
import type { ConversationMessage, Participant } from "@minu/channels-core/types";
import { mergeMessages, structuredTargets } from "../src/lib/messages";

const participants: Participant[] = [
  { id: "human-id", handle: "david", type: "human", status: "active" },
  { id: "agent-id", handle: "builder", type: "agent", status: "active" },
  { id: "disabled-id", handle: "old-agent", type: "agent", status: "disabled" },
];

function message(id: string, sequence: number): ConversationMessage {
  return {
    id,
    conversationId: "conversation",
    sequence,
    participantId: "human-id",
    to: [],
    body: id,
    createdAt: new Date(sequence).toISOString(),
  };
}

describe("structuredTargets", () => {
  it("resolves active local handles and conversation without duplicates", () => {
    expect(structuredTargets("@builder hello @builder and @conversation", participants)).toEqual([
      "agent-id",
      "@conversation",
    ]);
  });

  it("routes @channel and legacy @conversation to one canonical broadcast target", () => {
    expect(structuredTargets("@CHANNEL @builder @conversation @channel", participants)).toEqual([
      "@conversation",
      "agent-id",
    ]);
  });

  it("keeps an existing channel handle direct instead of adding broadcast", () => {
    const legacy = [...participants, { id: "legacy-id", handle: "channel", type: "agent" as const, status: "active" as const }];
    expect(structuredTargets("@CHANNEL direct", legacy)).toEqual(["legacy-id"]);
    expect(structuredTargets("@channel direct and @conversation broadcast", legacy)).toEqual(["legacy-id", "@conversation"]);
  });

  it("does not broadcast through a disabled channel handle", () => {
    const legacy = [...participants, { id: "legacy-id", handle: "channel", type: "agent" as const, status: "disabled" as const }];
    expect(structuredTargets("@channel cannot wake anyone", legacy)).toEqual([]);
  });

  it.each(["channel-", "CHANNEL-", "channel--", "channel-_", "conversation-", "CONVERSATION-", "builder-"])(
    "keeps the full handle @%s direct, without broadcast",
    (handle) => {
      const roster: Participant[] = [...participants, { id: "hyphen-id", handle: handle.toLowerCase(), type: "agent", status: "active" }];
      expect(structuredTargets(`@${handle}, inspect and @${handle}`, roster)).toEqual(["hyphen-id"]);
    },
  );

  it("does not broadcast an unknown or disabled trailing-hyphen handle", () => {
    expect(structuredTargets("@channel--- @conversation-", participants)).toEqual([]);
    const roster: Participant[] = [...participants, { id: "hyphen-id", handle: "channel-", type: "agent", status: "disabled" }];
    expect(structuredTargets("@CHANNEL-", roster)).toEqual([]);
  });

  it("still resolves broadcasts next to punctuation, not embedded in other text", () => {
    expect(structuredTargets("@channel, @CONVERSATION!", participants)).toEqual(["@conversation"]);
    expect(structuredTargets("someone@channel- @@channel", participants)).toEqual([]);
  });

  it("does not route disabled or unknown handles", () => {
    expect(structuredTargets("@old-agent @missing", participants)).toEqual([]);
  });
});

describe("mergeMessages", () => {
  it("deduplicates fetched and streamed messages in sequence order", () => {
    expect(mergeMessages([message("two", 2)], [message("one", 1), message("two", 2)]).map(({ id }) => id))
      .toEqual(["one", "two"]);
  });
});
