import type { Identity, Participant } from "@minu/channels-core/types";
import { shortId } from "./messages";

/** New roster choices are agents; keep the current human and existing non-agent members editable. */
export function isConversationParticipantChoice(
  identity: Pick<Identity, "id" | "type">,
  currentHumanIdentityId?: string,
  existingParticipantIds?: ReadonlySet<string>,
): boolean {
  return identity.type === "agent"
    || identity.id === currentHumanIdentityId
    || Boolean(existingParticipantIds?.has(identity.id));
}

export function participantLabel(participant: Participant | undefined, identityId: string): string {
  if (!participant) return shortId(identityId);
  return participant.displayName ?? `@${participant.handle ?? shortId(participant.id)}`;
}

export function participantHandle(participant: Participant | undefined, identityId: string): string {
  return participant?.handle ?? shortId(identityId);
}
