import type { ChannelMessage } from "@minu/channels-core/types";
import { describe, expect, test } from "vitest";
import { readSequence, readSound, unreadFor, writeReadSequence, writeSound } from "../src/lib/channel-notifications";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}
const message = (sequence: number, participantId: string, to: string[] = []): ChannelMessage => ({
  id: `message-${sequence}`,
  channelId: "channel-1",
  sequence,
  participantId,
  to,
  body: "hello",
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("local Channel notifications", () => {
  test("counts only genuinely unread peer messages and distinguishes mentions", () => {
    expect(unreadFor([
      message(1, "human"),
      message(2, "agent"),
      message(3, "agent", ["human"]),
      message(3, "agent", ["human"]),
    ], "human", 1)).toEqual({ count: 2, mentionCount: 1 });
  });

  test("reconciles a read cursor beyond reseeded history", () => {
    expect(unreadFor([message(1, "agent")], "human", 99)).toEqual({ count: 1, mentionCount: 0 });
  });

  test("persists read state per identity and Channel", () => {
    const local = storage();
    writeReadSequence(local, "human-a", "channel-a", 7);
    writeReadSequence(local, "human-a", "channel-a", 3);
    expect(readSequence(local, "human-a", "channel-a")).toBe(7);
    expect(readSequence(local, "human-b", "channel-a")).toBe(0);
    expect(readSequence(local, "human-a", "channel-b")).toBe(0);
  });

  test("defaults sound off and persists an explicit preference per identity", () => {
    const local = storage();
    expect(readSound(local, "human-a")).toBe("off");
    writeSound(local, "human-a", "mentions");
    expect(readSound(local, "human-a")).toBe("mentions");
    expect(readSound(local, "human-b")).toBe("off");
  });
});
