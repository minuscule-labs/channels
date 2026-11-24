import { describe, expect, it } from "vitest";
import type { ActivityItem } from "@minu/channels-core";
import { activitySearch, uniqueActivityItems } from "../src/lib/activity";

const item = (id: string, conversationId = "thread", createdAt = "2026-01-01", parentConversationId: string | undefined = "parent") => ({
  id, conversationId, parentConversationId, createdAt,
}) as ActivityItem;

describe("Activity views", () => {
  it("uses only supported tabs and defaults old or malformed links to All", () => {
    expect(activitySearch({})).toEqual({});
    expect(activitySearch({ view: "all" })).toEqual({});
    expect(activitySearch({ view: ["threads"] })).toEqual({});
    expect(activitySearch({ view: "threads" })).toEqual({ view: "threads" });
    expect(activitySearch({ view: "mentions" })).toEqual({ view: "mentions" });
  });
  it("keeps the newest copy when a refreshed group moves between pages", () => {
    const newest = item("new", "thread", "2026-02-01");
    const other = item("other", "other-thread");
    expect(uniqueActivityItems([newest, other, item("old")])).toEqual([newest, other]);
    expect(uniqueActivityItems([item("old"), newest])).toEqual([newest]);
    expect(uniqueActivityItems([item("a"), item("z")])[0]?.id).toBe("z");
  });
  it("keeps separate threads and separate unthreaded mentions in the same Conversation", () => {
    const first = { ...item("first", "parent"), parentConversationId: undefined };
    const second = { ...item("second", "parent"), parentConversationId: undefined };
    const entries = [first, second, item("reply"), item("other", "other-thread"), first];
    expect(uniqueActivityItems(entries)).toEqual(entries.slice(0, 4));
  });
});
