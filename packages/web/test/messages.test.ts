import { describe, expect, it } from "vitest";
import type { ChannelMessage, Participant } from "@minu/channels-core/types";
import { mergeMessages, structuredTargets } from "../src/lib/messages";

const participants: Participant[] = [
  { id: "human-id", handle: "david", type: "human", status: "active" },
  { id: "agent-id", handle: "builder", type: "agent", status: "active" },
  { id: "disabled-id", handle: "old-agent", type: "agent", status: "disabled" },
];

function message(id: string, sequence: number): ChannelMessage {
  return {
    id,
    channelId: "channel",
    sequence,
    participantId: "human-id",
    to: [],
    body: id,
    createdAt: new Date(sequence).toISOString(),
  };
}

describe("structuredTargets", () => {
  it("resolves active local handles and channel without duplicates", () => {
    expect(structuredTargets("@builder hello @builder and @channel", participants)).toEqual([
      "agent-id",
      "@channel",
    ]);
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
