import { describe, expect, it } from "vitest";
import { readThreadSelection, threadSelectionStorageKey, writeThreadSelection } from "../src/lib/thread-selection";

describe("remembered thread selection", () => {
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
