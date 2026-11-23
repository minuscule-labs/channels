/** An explicit URL selection takes precedence over remembered panels; null means the parent view. */
export function conversationThreadSearch(search: Record<string, unknown>): { threadId?: string | null; threadMessage?: number } {
  if (search.threadId !== undefined && search.threadId !== null && typeof search.threadId !== "string") {
    throw new Error("Invalid thread link");
  }
  const threadId = search.threadId === undefined ? undefined : search.threadId || null;
  return {
    ...(threadId !== undefined ? { threadId } : {}),
    ...(threadId && typeof search.threadMessage === "number" && Number.isSafeInteger(search.threadMessage) && search.threadMessage > 0
      ? { threadMessage: search.threadMessage } : {}),
  };
}

export function threadSelectionStorageKey(workspaceId: string, conversationId: string, identityId: string): string {
  return `minu.conversations.open-thread.${workspaceId}.${conversationId}.${identityId}`;
}

export function readThreadSelection(key: string, storage?: Pick<Storage, "getItem">): string | undefined {
  try { return (storage ?? localStorage).getItem(key) || undefined; }
  catch { return undefined; }
}

export function writeThreadSelection(key: string, threadId: string | undefined, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try {
    const target = storage ?? localStorage;
    if (threadId) target.setItem(key, threadId);
    else target.removeItem(key);
  } catch { /* Remembering a panel must not prevent opening or closing it. */ }
}
