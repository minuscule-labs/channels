import { describe, expect, it } from "vitest";
import { conversationThreadSearch, readThreadSelection, threadSelectionStorageKey, writeThreadSelection } from "../src/lib/thread-selection";

describe("remembered thread selection", () => {
  it("keeps explicit thread and parent URLs distinct from remembered selection", () => {
    expect(conversationThreadSearch({})).toEqual({});
    expect(conversationThreadSearch({ threadId: null, threadMessage: 9 })).toEqual({ threadId: null });
    expect(conversationThreadSearch({ threadId: "" })).toEqual({ threadId: null });
    expect(conversationThreadSearch({ threadId: "thread-a", threadMessage: 3, ignored: true })).toEqual({ threadId: "thread-a", threadMessage: 3 });
  });

  it("rejects malformed thread intent instead of falling back to a remembered thread", () => {
    for (const threadId of [123, false, [], {}]) expect(() => conversationThreadSearch({ threadId })).toThrow("Invalid thread link");
  });

  it("accepts only positive safe message targets attached to an explicit thread", () => {
    for (const threadMessage of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "2"]) {
      expect(conversationThreadSearch({ threadId: "thread", threadMessage })).toEqual({ threadId: "thread" });
    }
    expect(conversationThreadSearch({ threadMessage: 2 })).toEqual({});
  });
  it("scopes a selection to its workspace, channel and human identity", () => {
    const keys = [
      threadSelectionStorageKey("workspace", "channel", "human"),
      threadSelectionStorageKey("other-workspace", "channel", "human"),
      threadSelectionStorageKey("workspace", "other-channel", "human"),
      threadSelectionStorageKey("workspace", "channel", "other-human"),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it("stores only the thread ID and clears it on close without changing other selections", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    writeThreadSelection("channel-a", "thread-a", storage);
    writeThreadSelection("channel-b", "thread-b", storage);
    expect(readThreadSelection("channel-a", storage)).toBe("thread-a");
    writeThreadSelection("channel-a", undefined, storage);
    expect(readThreadSelection("channel-a", storage)).toBeUndefined();
    expect(readThreadSelection("channel-b", storage)).toBe("thread-b");
  });

  it("treats missing or empty selections as closed", () => {
    expect(readThreadSelection("key", { getItem: () => null })).toBeUndefined();
    expect(readThreadSelection("key", { getItem: () => "" })).toBeUndefined();
  });

  it("does not block the UI when browser storage is unavailable", () => {
    const denied = () => { throw new Error("Storage denied"); };
    expect(readThreadSelection("key", { getItem: denied })).toBeUndefined();
    const storage = { setItem: denied, removeItem: denied };
    expect(() => writeThreadSelection("key", "thread", storage)).not.toThrow();
    expect(() => writeThreadSelection("key", undefined, storage)).not.toThrow();
  });
});
