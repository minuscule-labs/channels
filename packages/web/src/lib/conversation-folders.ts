import type { ConversationFolder, ConversationLifecycleState, ConversationMetadata } from "@minu/channels-core/types";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./query-keys";

export interface ConversationFolderGroup {
  folder?: ConversationFolder;
  conversations: ConversationMetadata[];
}

export function groupConversationFolders(
  folders: readonly ConversationFolder[],
  conversations: readonly ConversationMetadata[],
  lifecycle: ReadonlyMap<string, ConversationLifecycleState> = new Map(),
): ConversationFolderGroup[] {
  const unfiled: ConversationFolderGroup = { conversations: [] };
  const groups = [...folders]
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id))
    .map(folder => ({ folder, conversations: [] as ConversationMetadata[] }));
  const byId = new Map(groups.map(group => [group.folder.id, group]));
  for (const conversation of conversations) {
    if (conversation.thread || (lifecycle.get(conversation.id) ?? "active") !== "active") continue;
    // Keep a Conversation discoverable while its folder catalogue is catching up.
    const group = conversation.folderId ? byId.get(conversation.folderId) ?? unfiled : unfiled;
    group.conversations.push(conversation);
  }
  return [unfiled, ...groups];
}

export function folderUnread(
  conversations: readonly ConversationMetadata[],
  unread: ReadonlyMap<string, { count: number; mentionCount: number }> = new Map(),
) {
  return conversations.reduce((total, conversation) => {
    const value = unread.get(conversation.id);
    return { count: total.count + (value?.count ?? 0), mentionCount: total.mentionCount + (value?.mentionCount ?? 0) };
  }, { count: 0, mentionCount: 0 });
}

export function folderCollapseKey(identityId: string, workspaceId: string, folderId?: string | null): string {
  return `minu-channels:folder-collapsed:${identityId}:${workspaceId}:${folderId ?? "unfiled"}`;
}

export function readFolderCollapsed(storage: Pick<Storage, "getItem"> | undefined, key: string): boolean {
  try { return storage?.getItem(key) === "true"; }
  catch { return false; }
}

export function writeFolderCollapsed(storage: Pick<Storage, "setItem">, key: string, collapsed: boolean): void {
  try { storage.setItem(key, String(collapsed)); }
  catch { /* Navigation remains usable when optional browser storage is unavailable. */ }
}

export function cacheConversationMetadata(client: QueryClient, updated: ConversationMetadata): void {
  client.setQueryData(queryKeys.conversation(updated.id), updated);
  if (updated.thread) return;
  client.setQueryData<ConversationMetadata[]>(queryKeys.workspaceConversations(updated.workspaceId), current => {
    if (!current) return current;
    return current.some(item => item.id === updated.id)
      ? current.map(item => item.id === updated.id ? updated : item)
      : [...current, updated];
  });
}
