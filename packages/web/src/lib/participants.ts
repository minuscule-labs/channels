import type { Participant } from "@minu/channels-core/types";
import { shortId } from "./messages";

export function participantLabel(participant: Participant | undefined, identityId: string): string {
  if (!participant) return shortId(identityId);
  return participant.displayName ?? `@${participant.handle ?? shortId(participant.id)}`;
}

export function participantHandle(participant: Participant | undefined, identityId: string): string {
  return participant?.handle ?? shortId(identityId);
}
