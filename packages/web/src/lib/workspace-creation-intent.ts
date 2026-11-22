type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const workspaceCreationIntentKey = (identityId: string) => `minu-channels:workspace-creation-intent:${identityId}`;

/** Only the opaque request ID is persisted, never names, folders or private plan content. */
export function readWorkspaceCreationIntent(storage: IntentStorage, identityId: string): string | undefined {
  const value = storage.getItem(workspaceCreationIntentKey(identityId));
  if (value === null) return undefined;
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(value)) throw new Error("Saved workspace creation identity is invalid");
  return value;
}

/** An unresolved identity from another dialog/tab must be inspected, not replaced. */
export function rememberWorkspaceCreationIntent(storage: IntentStorage, identityId: string, requestId: string): string {
  const existing = readWorkspaceCreationIntent(storage, identityId);
  if (existing) return existing;
  storage.setItem(workspaceCreationIntentKey(identityId), requestId);
  const saved = readWorkspaceCreationIntent(storage, identityId);
  if (saved !== requestId) throw new Error("Workspace creation identity could not be saved");
  return saved;
}

export function forgetWorkspaceCreationIntent(storage: IntentStorage, identityId: string, requestId: string): void {
  if (storage.getItem(workspaceCreationIntentKey(identityId)) === requestId) storage.removeItem(workspaceCreationIntentKey(identityId));
}
