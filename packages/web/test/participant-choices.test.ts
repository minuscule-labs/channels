import { describe, expect, it } from "vitest";
import { isConversationParticipantChoice, participantDiagnosticsHref } from "../src/lib/participants";

const identities = [
  { id: "current-human", type: "human" },
  { id: "other-human", type: "human" },
  { id: "agent", type: "agent" },
  { id: "service", type: "service" },
] as const;

describe("participant diagnostic URLs", () => {
  it("uses compact browser IDs and preserves issue context and legacy channel IDs", () => {
    const payload = "550e8400e29b41d4a716446655440000";
    expect(participantDiagnosticsHref(`workspace_${payload}`, `conversation_${payload}`, "identity_legacy", {
      triggerSequence: 42, failedAt: "2026-11-11T12:00:00Z",
    })).toBe(`/workspaces/${payload}/conversations/${payload}/participants/identity_legacy/diagnostics?triggerSequence=42&failedAt=2026-11-11T12%3A00%3A00Z`);
    expect(participantDiagnosticsHref("workspace_legacy", `channel_${payload}`, "identity_legacy"))
      .toBe(`/workspaces/workspace_legacy/conversations/channel_${payload}/participants/identity_legacy/diagnostics`);
  });
});

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
