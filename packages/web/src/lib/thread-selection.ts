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
