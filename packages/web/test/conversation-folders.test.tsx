import type { ConversationFolder, ConversationLifecycleState, ConversationMetadata } from "@minu/channels-core/types";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { cacheConversationMetadata, folderCollapseKey, folderUnread, groupConversationFolders, readFolderCollapsed, writeFolderCollapsed } from "../src/lib/conversation-folders";
import { queryKeys } from "../src/lib/query-keys";

const folder = (id: string, name: string): ConversationFolder => ({ id, name, workspaceId: "workspace", createdAt: "2026-01-01", updatedAt: "2026-01-01" });
const conversation = (id: string, folderId?: string | null): ConversationMetadata => ({ id, folderId, workspaceId: "workspace", name: id, participants: [], rosterRevision: 1, createdAt: "2026-01-01" });

describe("Conversation folder navigation", () => {
  it("groups every active top-level item once, keeps Unfiled/empty folders and preserves Conversation order", () => {
    const folders = [folder("z", "Zulu"), folder("b", "Alpha"), folder("a", "alpha"), folder("empty", "Empty")];
    const items = [conversation("legacy"), conversation("second", "b"), conversation("first", "b"), conversation("future", "unknown"), conversation("snoozed", "b"), conversation("settled", "z")];
    items.push({ ...conversation("thread", "b"), thread: { parentConversationId: "first", rootMessageId: "root", context: [] } });
    const states = new Map<string, ConversationLifecycleState>([["snoozed", "snoozed"], ["settled", "settled"]]);
    const groups = groupConversationFolders(folders, items, states);
    expect(groups.map(group => group.folder?.id ?? "unfiled")).toEqual(["unfiled", "a", "b", "empty", "z"]);
    expect(groups[0]!.conversations.map(item => item.id)).toEqual(["legacy", "future"]);
    expect(groups[2]!.conversations.map(item => item.id)).toEqual(["second", "first"]);
    const visible = groups.flatMap(group => group.conversations.map(item => item.id));
    expect(new Set(visible).size).toBe(visible.length);
    expect(visible).toEqual(["legacy", "future", "second", "first"]);
    expect(folders.map(item => item.id)).toEqual(["z", "b", "a", "empty"]);
    expect(groupConversationFolders([], [conversation("old-cache")])[0]!.conversations).toHaveLength(1);
  });

  it("aggregates only a group's active unread state without altering Conversation/Workspace state", () => {
    const items = [conversation("a", "f"), conversation("b", "f"), conversation("sleeping", "f"), conversation("outside")];
    const unread = new Map([["a", { count: 2, mentionCount: 1 }], ["b", { count: 3, mentionCount: 2 }], ["sleeping", { count: 10, mentionCount: 4 }], ["outside", { count: 1, mentionCount: 0 }]]);
    const before = [...unread.entries()];
    const groups = groupConversationFolders([folder("f", "Folder")], items, new Map([["sleeping", "snoozed"]]));
    expect(folderUnread(groups[1]!.conversations, unread)).toEqual({ count: 5, mentionCount: 3 });
    expect(folderUnread(groups[0]!.conversations, unread)).toEqual({ count: 1, mentionCount: 0 });
    expect(folderUnread([])).toEqual({ count: 0, mentionCount: 0 });
    expect([...unread.entries()]).toEqual(before);
  });

  it("isolates collapse preferences by human, Workspace and stable folder ID", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const key = folderCollapseKey("owner", "workspace", "folder");
    expect(readFolderCollapsed(storage, key)).toBe(false);
    writeFolderCollapsed(storage, key, true);
    expect(readFolderCollapsed(storage, key)).toBe(true);
    for (const other of [folderCollapseKey("member", "workspace", "folder"), folderCollapseKey("owner", "other", "folder"), folderCollapseKey("owner", "workspace", "other"), folderCollapseKey("owner", "workspace", null)]) {
      expect(readFolderCollapsed(storage, other)).toBe(false);
    }
    writeFolderCollapsed(storage, key, false);
    expect(readFolderCollapsed(storage, key)).toBe(false);
    expect(readFolderCollapsed(undefined, key)).toBe(false);
    expect(readFolderCollapsed({ getItem: () => { throw new Error("unavailable"); } }, key)).toBe(false);
    expect(() => writeFolderCollapsed({ setItem: () => { throw new Error("full"); } }, key, true)).not.toThrow();
  });

  it("updates metadata/list caches without dropping other Conversations or touching messages", () => {
    const client = new QueryClient();
    try {
      const first = conversation("first"), other = conversation("other");
      client.setQueryData(queryKeys.workspaceConversations("workspace"), [first, other]);
      const messages = [{ id: "message", sequence: 1 }];
      client.setQueryData(queryKeys.conversationMessages(first.id), messages);
      const updated = { ...first, folderId: "new-folder" };
      cacheConversationMetadata(client, updated);
      expect(client.getQueryData(queryKeys.conversation(first.id))).toEqual(updated);
      expect(client.getQueryData(queryKeys.workspaceConversations("workspace"))).toEqual([updated, other]);
      expect(client.getQueryData(queryKeys.conversationMessages(first.id))).toBe(messages);
      const created = conversation("created", "new-folder");
      cacheConversationMetadata(client, created);
      expect(client.getQueryData(queryKeys.workspaceConversations("workspace"))).toEqual([updated, other, created]);
      cacheConversationMetadata(client, { ...conversation("thread"), thread: { parentConversationId: first.id, rootMessageId: "root", context: [] } });
      expect(client.getQueryData(queryKeys.workspaceConversations("workspace"))).toEqual([updated, other, created]);
      cacheConversationMetadata(client, { ...conversation("offscreen"), workspaceId: "unloaded" });
      expect(client.getQueryData(queryKeys.workspaceConversations("unloaded"))).toBeUndefined();
    } finally { client.clear(); }
  });
});
