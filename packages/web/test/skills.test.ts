import { describe, expect, it, vi } from "vitest";
import type { Participant } from "@minu/channels-core/types";
import type { LocalAuthoredSkillInvocationReceipt, LocalConversationAuthoredSkillCatalog } from "@minu/channels-control/contracts";
import { createSkillRequest, inspectSkillRequest, publishSkillRequest, readSkillChoice, readSkillRequest, skillAvailability, skillPickerEntries, skillsCommand, submitSkillRequest, type SkillApi, type SkillRequest } from "../src/lib/skills";
import { draftStorageKey } from "../src/lib/composer";

const choice = { documentId: "channel-doc", source: "channel" as const, revision: 1, contentHash: "a".repeat(64), name: "Decision", description: "Published" };
const participants: Participant[] = [
  { id: "human", type: "human", status: "active" }, { id: "a", type: "agent", status: "active" },
  { id: "b", type: "service", status: "active" }, { id: "disabled", type: "agent", status: "disabled" },
];
const live = [{ identityId: "a", state: "idle" }, { identityId: "b", state: "running" }];
function catalog(): LocalConversationAuthoredSkillCatalog {
  return { workspaceId: "w", conversationId: "c", channelId: "c", availability: "not_checked", skills: [choice],
    agents: ["a", "b"].map(identityId => ({ identityId, state: "ready", supported: true, skills: [choice], harness: ["skill:review"] })) };
}
const request = () => createSkillRequest("human", choice, "Arguments @b @channel", ["a"], () => "opaque-key");
function receipt(q: SkillRequest): LocalAuthoredSkillInvocationReceipt {
  return { ...q.input, id: "invocation", requestId: q.requestId, workspaceId: "w", conversationId: "c", actorIdentityId: q.actorIdentityId,
    name: "Decision", acceptedAt: "2026-11-05T00:00:00.000Z", acceptance: "accepted" };
}
function api(q: SkillRequest) {
  return {
    acceptAuthoredSkillInvocation: vi.fn(async () => receipt(q)),
    publishAuthoredSkillInvocation: vi.fn(async () => ({ requestId: q.requestId, invocationId: "invocation", status: "observed" as const, messageId: "message" })),
    getAuthoredSkillInvocation: vi.fn(async () => receipt(q)),
    getAuthoredSkillInvocationPublication: vi.fn(async () => ({ requestId: q.requestId, invocationId: "invocation", status: "not_linked" as const })),
  } satisfies SkillApi;
}

describe("explicit skill selection", () => {
  it("opens skills from a leading slash, retains the /skills alias and preserves separate arguments", () => {
    expect(skillsCommand("/decision\nArguments\nmore")).toEqual({ query: "decision", arguments: "Arguments\nmore" });
    expect(skillsCommand("/skills decision\nArguments\nmore")).toEqual({ query: "decision", arguments: "Arguments\nmore" });
    for (const body of ["/", "/skills", "/skills "]) expect(skillsCommand(body)).toEqual({ query: "", arguments: "" });
    expect(skillsCommand("/skillsXYZ")).toEqual({ query: "skillsXYZ", arguments: "" });
    for (const body of ["$decision", "Please /skills", "`/skills`", "https://example.com"]) expect(skillsCommand(body)).toBeUndefined();
  });
  it("filters published metadata and retains unsupported Harness entries without exposing bodies", () => {
    const data = catalog();
    expect(skillPickerEntries(data, "channel")).toEqual([{ skill: choice }]);
    expect(skillPickerEntries(data, "published")).toEqual([{ skill: choice }]);
    expect(skillPickerEntries(data, "review")).toEqual([
      { identityId: "a", commandId: "skill:review" }, { identityId: "b", commandId: "skill:review" },
    ]);
    expect(skillPickerEntries(data, "missing")).toEqual([]);
    expect(skillPickerEntries(undefined, "")).toEqual([]);
  });
  it("keeps immutable IDs, revision and explicit recipients instead of interpreting task mentions", () => {
    const targets = ["b", "a"];
    const q = createSkillRequest("human", choice, "@channel @disabled", targets, () => "key");
    targets.push("disabled");
    expect(q.input).toEqual({ documentId: choice.documentId, source: "channel", revision: 1, arguments: "@channel @disabled", to: ["a", "b"] });
    expect(q.requestId).toBe("key");
  });
  it("distinguishes pending, retired, corrupt, unsupported and changing recipient states", () => {
    const data = catalog();
    expect(skillAvailability(choice, ["a", "b"], participants, data, live)).toBe("Ready");
    for (const targets of [[], ["@conversation"], ["human"], ["disabled"], ["a", "a"]]) expect(skillAvailability(choice, targets, participants, data, live)).toBe("Unavailable");
    expect(skillAvailability(choice, ["a"], participants, data)).toBe("Unavailable");
    expect(skillAvailability(choice, ["a"], participants, data, [{ identityId: "a", state: "offline" }])).toBe("Unavailable");
    data.agents![1]!.skills = [];
    expect(skillAvailability(choice, ["a", "b"], participants, data, live)).toBe("Pending");
    data.agents![1]!.supported = false;
    expect(skillAvailability(choice, ["a", "b"], participants, data, live)).toBe("Unavailable");
    data.skills = [];
    expect(skillAvailability(choice, ["a"], participants, data, live)).toBe("Unavailable");
  });
  it("retains an explicitly selected old pin after newer publication, without substituting it", () => {
    const data = catalog();
    const latest = { ...choice, revision: 2, contentHash: "b".repeat(64), name: "New name" };
    data.skills = [latest];
    expect(skillAvailability(choice, ["a"], participants, data, live)).toBe("Ready");
    expect(skillAvailability(latest, ["a"], participants, data, live)).toBe("Pending");
    expect(choice.revision).toBe(1);
  });
  it("scopes persisted choice/request to human and conversation, rejecting malformed state", () => {
    expect(readSkillChoice(JSON.stringify(choice))).toEqual(choice);
    expect(readSkillChoice('{"name":"Decision"}')).toBeUndefined();
    const q = request();
    expect(readSkillRequest(JSON.stringify(q), "human")).toEqual(q);
    expect(readSkillRequest(JSON.stringify(q), "other-human")).toBeUndefined();
    const keys = [draftStorageKey("w", "c", "human"), draftStorageKey("w", "thread", "human"), draftStorageKey("w", "c", "other-human")];
    expect(new Set(keys).size).toBe(3);
  });
});

describe("submit and original receipt", () => {
  it("persists before both explicit mutations and publishes using accepted wire identity", async () => {
    const q = request(), client = api(q), snapshots: SkillRequest[] = [];
    client.acceptAuthoredSkillInvocation.mockImplementation(async () => { expect(snapshots[0]).toEqual(q); return receipt(q); });
    client.publishAuthoredSkillInvocation.mockImplementation(async () => {
      expect(snapshots.at(-1)?.publicationAttempted).toBe(true);
      return { requestId: q.requestId, invocationId: "invocation", status: "observed", messageId: "message" };
    });
    const result = await submitSkillRequest(client, "c", q, value => snapshots.push(value));
    expect(client.acceptAuthoredSkillInvocation).toHaveBeenCalledWith("c", q.input, { idempotencyKey: q.requestId });
    expect(client.publishAuthoredSkillInvocation).toHaveBeenCalledWith("c", receipt(q));
    expect(result.publication?.status).toBe("observed");
  });
  it("does not publish after lost acceptance acknowledgment; inspection is read-only", async () => {
    const q = request(), client = api(q);
    client.acceptAuthoredSkillInvocation.mockRejectedValue(new Error("lost acceptance acknowledgment"));
    let saved = q;
    await expect(submitSkillRequest(client, "c", q, value => { saved = value; })).rejects.toThrow();
    expect(saved).toEqual(q);
    const inspected = await inspectSkillRequest(client, "c", saved);
    expect(inspected.accepted?.id).toBe("invocation");
    expect(client.acceptAuthoredSkillInvocation).toHaveBeenCalledTimes(1);
    expect(client.publishAuthoredSkillInvocation).not.toHaveBeenCalled();
    await publishSkillRequest(client, "c", inspected, () => {}); // Separate, explicit user action.
    expect(client.publishAuthoredSkillInvocation).toHaveBeenCalledTimes(1);
  });
  it("retains attempted identity after uncertain publication and never resends from inspection/absence", async () => {
    const q = request(), client = api(q);
    client.publishAuthoredSkillInvocation.mockRejectedValue(new Error("lost Core acknowledgment"));
    let saved = q;
    await expect(submitSkillRequest(client, "c", q, value => { saved = value; })).rejects.toThrow();
    expect(saved.publicationAttempted).toBe(true);
    const observed = await inspectSkillRequest(client, "c", saved);
    expect(observed.publication?.status).toBe("not_linked");
    await expect(publishSkillRequest(client, "c", observed, () => {})).rejects.toThrow("Inspect the original receipt");
    expect(client.acceptAuthoredSkillInvocation).toHaveBeenCalledTimes(1);
    expect(client.publishAuthoredSkillInvocation).toHaveBeenCalledTimes(1);
  });
  it("does not interpret a missing receipt as permission to mutate", async () => {
    const q = request(), client = api(q);
    client.getAuthoredSkillInvocation.mockRejectedValue(new Error("Not found"));
    await expect(inspectSkillRequest(client, "c", q)).rejects.toThrow("Not found");
    expect(client.acceptAuthoredSkillInvocation).not.toHaveBeenCalled();
    expect(client.publishAuthoredSkillInvocation).not.toHaveBeenCalled();
  });
  it.each(["conversationId", "actorIdentityId", "documentId", "arguments", "requestId"])("rejects a mismatched %s receipt before publication", async field => {
    const q = request(), client = api(q);
    client.acceptAuthoredSkillInvocation.mockResolvedValue({ ...receipt(q), [field]: "different" });
    await expect(submitSkillRequest(client, "c", q, () => {})).rejects.toThrow("Receipt mismatch");
    expect(client.publishAuthoredSkillInvocation).not.toHaveBeenCalled();
  });
});
