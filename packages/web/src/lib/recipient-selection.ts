import type { Participant } from "@minu/channels-core/types";
import { hasChannelMentionCollision, mentionHandles } from "@minu/channels-core/mentions";
import { structuredTargets } from "./messages";

export function recipientStorageKey(workspaceId: string, conversationId: string, identityId: string): string {
  return `minu.conversations.recipient.${workspaceId}.${conversationId}.${identityId}`;
}

export function readRecipient(key: string): string | undefined {
  try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; }
}

export function writeRecipient(key: string, id: string): void {
  try { localStorage.setItem(key, id); } catch { /* Selection still works without persistence. */ }
}

export function readRecipientOverride(key: string, body: string): string[] | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value?.mentions === mentionHandles(body).join("\0") && Array.isArray(value.targets)
      && value.targets.every((id: unknown) => typeof id === "string") ? value.targets : undefined;
  } catch { return undefined; }
}

export function writeRecipientOverride(key: string, body: string, targets?: string[]): void {
  try {
    if (targets) localStorage.setItem(key, JSON.stringify({ mentions: mentionHandles(body).join("\0"), targets }));
    else localStorage.removeItem(key);
  } catch { /* A draft's explicit target still works for this page lifetime. */ }
}

export function messageRecipients(body: string, participants: Participant[], selected: string, override?: string[]) {
  if (override) return { targets: override, invalid: [] as string[] };
  const handles = mentionHandles(body);
  const collision = hasChannelMentionCollision(participants);
  const invalid = handles.filter((handle) => {
    const name = handle.toLowerCase();
    if (name === "conversation" || (name === "channel" && !collision)) return false;
    return !participants.some((participant) => participant.status !== "disabled"
      && (participant.handle ?? participant.id).toLowerCase() === name);
  });
  const targets = structuredTargets(body, participants);
  return { targets: handles.length ? targets : selected ? [selected] : [], invalid };
}
