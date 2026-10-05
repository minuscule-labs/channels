import { describe, expect, it } from "vitest";
import { isConversationParticipantChoice } from "../src/lib/participants";

const identities = [
  { id: "current-human", type: "human" },
  { id: "other-human", type: "human" },
  { id: "agent", type: "agent" },
  { id: "service", type: "service" },
] as const;

describe("agent-first Conversation participant choices", () => {
  it("offers agents and the current human for new Conversations", () => {
    expect(identities.filter((identity) => isConversationParticipantChoice(identity, "current-human"))
      .map(({ id }) => id)).toEqual(["current-human", "agent"]);
  });

  it("keeps existing humans and services editable rather than silently dropping them", () => {
    const existing = new Set(["other-human", "service"]);
    expect(identities.filter((identity) => isConversationParticipantChoice(identity, "current-human", existing))
      .map(({ id }) => id)).toEqual(["current-human", "other-human", "agent", "service"]);
  });

  it("does not offer new human or service identities when no browser identity is available", () => {
    expect(identities.filter((identity) => isConversationParticipantChoice(identity))
      .map(({ id }) => id)).toEqual(["agent"]);
  });
});
