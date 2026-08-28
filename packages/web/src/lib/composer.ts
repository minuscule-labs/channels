import type { CreateMessageInput, Participant } from "@minu/channels-core/types";
import { structuredTargets } from "./messages";

export const MAX_MESSAGE_BYTES = 64 * 1024;

export interface MentionQuery {
  start: number;
  end: number;
  value: string;
}

export interface MessageSubmission {
  idempotencyKey: string;
  input: CreateMessageInput;
}

export function messageByteLength(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

export function mentionQueryAt(body: string, cursor: number): MentionQuery | undefined {
  const safeCursor = Math.max(0, Math.min(cursor, body.length));
  const match = body.slice(0, safeCursor).match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/);
  if (!match) return undefined;
  const value = match[1] ?? "";
  return { start: safeCursor - value.length - 1, end: safeCursor, value: value.toLowerCase() };
}

export function replaceMention(body: string, query: MentionQuery, handle: string): { body: string; cursor: number } {
  const replacement = `@${handle} `;
  const suffix = body.slice(query.end);
  const remaining = /^\s/.test(suffix) ? suffix.slice(1) : suffix;
  return {
    body: `${body.slice(0, query.start)}${replacement}${remaining}`,
    cursor: query.start + replacement.length,
  };
}

export function draftStorageKey(workspaceId: string, channelId: string, authorIdentityId: string): string {
  return `minu.channels.draft.${workspaceId}.${channelId}.${authorIdentityId}`;
}

export function createMessageSubmission(
  authorIdentityId: string,
  body: string,
  participants: Participant[],
  createId: () => string = () => crypto.randomUUID(),
): MessageSubmission {
  return {
    idempotencyKey: createId(),
    input: {
      participantId: authorIdentityId,
      body,
      to: structuredTargets(body, participants),
    },
  };
}

export function submissionMatchesDraft(
  submission: MessageSubmission,
  authorIdentityId: string,
  body: string,
  participants: Participant[],
): boolean {
  const targets = structuredTargets(body, participants);
  const submissionTargets = submission.input.to ?? [];
  return submission.input.participantId === authorIdentityId
    && submission.input.body === body
    && submissionTargets.length === targets.length
    && submissionTargets.every((target, index) => target === targets[index]);
}
