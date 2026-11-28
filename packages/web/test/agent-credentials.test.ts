import type { ConversationMetadata } from "@minu/channels-core/types";
import type { LocalAgentCredentialSummary } from "@minu/channels-control/contracts";
import { LocalControlClientError } from "@minu/channels-control/client";
import { describe, expect, it } from "vitest";
import {
  addGrant, buildCreateInput, buildTargetCatalog, buildUpdateInput, classifyCredentialFailure, credentialIntents, credentialStatus,
  customExpiryBounds, draftFromCredential, findCreatedCredential, grantSummary, mapBounded, newDraft, rebaseDraft, resolveExpiry, searchTargets,
  setIncludeThreads, targetLabel,
} from "../src/lib/agent-credentials";

const now = Date.parse("2026-11-28T12:00:00.000Z");
const parent = { id: "conv_general", workspaceId: "w", name: "general", participants: [], rosterRevision: 1, createdAt: "" } satisfies ConversationMetadata;
const other = { ...parent, id: "conv_ops", name: "ops" };
const thread = { ...parent, id: "conv_thread", name: "Thread #4", thread: { parentConversationId: "conv_general", rootMessageId: "m", context: [] } };
const catalog = buildTargetCatalog([other, parent], [thread]);
const byId = new Map(catalog.map(target => [target.id, target]));
const credential: LocalAgentCredentialSummary = {
  id: "a".repeat(32), workspaceId: "w", principalIdentityId: "h", requestId: "ui_request_000001", name: "PM",
  capabilities: ["conversation.inspect"], scope: { mode: "generic", grants: [{ conversationId: "conv_hidden", includeThreads: true }, { conversationId: "conv_thread", includeThreads: false }] },
  revision: 3, secretGeneration: 2, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z",
};

describe("agent credential targets", () => {
  it("distinguishes threads from their parent Conversation and keeps parents first", () => {
    expect(catalog.map(target => [target.id, target.kind])).toEqual([["conv_general", "conversation"], ["conv_thread", "thread"], ["conv_ops", "conversation"]]);
    expect(targetLabel(byId.get("conv_thread"))).toBe("Thread #4 in #general");
    expect(targetLabel(byId.get("conv_general"))).toBe("#general");
    expect(targetLabel(undefined)).toBe("Unavailable target");
    expect(searchTargets(catalog, "general", new Set(["conv_general"])).map(target => target.id)).toEqual(["conv_thread"]);
    expect(searchTargets(catalog, " ", new Set())).toEqual([]);
  });

  it("adds grants unchecked and never includes threads for a direct thread grant", () => {
    let grants = addGrant([], byId.get("conv_general")!);
    grants = addGrant(addGrant(grants, byId.get("conv_thread")!), byId.get("conv_general")!);
    expect(grants).toEqual([{ conversationId: "conv_general", includeThreads: false }, { conversationId: "conv_thread", includeThreads: false }]);
    expect(setIncludeThreads(grants, "conv_thread", true, byId.get("conv_thread"))).toBe(grants);
    expect(setIncludeThreads(grants, "conv_missing", true, undefined)).toBe(grants);
    expect(setIncludeThreads(grants, "conv_general", true, byId.get("conv_general"))[0]).toEqual({ conversationId: "conv_general", includeThreads: true });
  });

  it("summarizes supported capability and scope without inventing usage", () => {
    expect(grantSummary(credential, byId)).toBe("Inspect status · 2 targets (1 with threads)");
    expect(grantSummary({ capabilities: [], scope: { mode: "locked", conversationId: "conv_general", includeThreads: true } }, byId))
      .toBe("Inspection off · Single target: #general + threads");
    expect(grantSummary({ capabilities: [], scope: { mode: "locked", conversationId: "conv_unloaded", includeThreads: false } }, byId)).toBe("Inspection off · Single target");
  });
});

describe("agent credential drafts", () => {
  it("omits the default 30-day expiry and freezes explicit choices into the create payload", () => {
    const draft = { ...newDraft(), name: " Foreman ", grants: [{ conversationId: "conv_general", includeThreads: false }] };
    expect(buildCreateInput(draft, "ui_request_000001", now).input).toEqual({
      requestId: "ui_request_000001", name: "Foreman", capabilities: ["conversation.inspect"],
      scope: { mode: "generic", grants: [{ conversationId: "conv_general", includeThreads: false }] },
    });
    expect(buildCreateInput({ ...draft, expiry: { kind: "days", days: 7 } }, "ui_request_000001", now).input?.expiresAt).toBe("2026-12-05T12:00:00.000Z");
    expect(buildCreateInput({ ...draft, inspect: false }, "ui_request_000001", now).input?.capabilities).toEqual([]);
    expect(buildCreateInput({ ...draft, name: "" }, "r", now).error).toBe("Enter a key name.");
    expect(buildCreateInput({ ...draft, grants: [] }, "r", now).error).toMatch(/at least one/);
    expect(buildCreateInput({ ...draft, mode: "locked", grants: [...draft.grants, { conversationId: "conv_ops", includeThreads: false }] }, "r", now).error).toMatch(/exactly one/);
    expect(buildCreateInput({ ...draft, mode: "locked" }, "r", now).input?.scope).toEqual({ mode: "locked", conversationId: "conv_general", includeThreads: false });
  });

  it("bounds custom expiry to the 90-day maximum", () => {
    const bounds = customExpiryBounds(now);
    expect(resolveExpiry({ kind: "date", date: bounds.max }, now, true).expiresAt).toBeDefined();
    expect(resolveExpiry({ kind: "date", date: "2027-06-01" }, now, true).error).toMatch(/90 days/);
    expect(resolveExpiry({ kind: "date", date: "2026-11-01" }, now, true).error).toMatch(/future/);
    expect(resolveExpiry({ kind: "days", days: 91 }, now, true).error).toMatch(/90 days/);
    expect(resolveExpiry({ kind: "keep" }, now, false)).toEqual({});
  });

  it("sends only changed fields, preserving hidden grants and unchanged expiry", () => {
    const draft = draftFromCredential(credential);
    expect(buildUpdateInput(draft, credential, 3, now).error).toBe("No changes to save.");
    expect(buildUpdateInput({ ...draft, inspect: false }, credential, 3, now).input).toEqual({ expectedRevision: 3, capabilities: [] });
    const reordered = { ...draft, name: "PM 2", grants: [...draft.grants].reverse() };
    expect(buildUpdateInput(reordered, credential, 3, now).input).toEqual({ expectedRevision: 3, name: "PM 2" });
    const added = { ...draft, grants: addGrant(draft.grants, byId.get("conv_ops")!) };
    expect(buildUpdateInput(added, credential, 3, now).input?.scope).toEqual({ mode: "generic", grants: [
      { conversationId: "conv_hidden", includeThreads: true }, { conversationId: "conv_thread", includeThreads: false }, { conversationId: "conv_ops", includeThreads: false },
    ] });
    expect(buildUpdateInput({ ...draft, expiry: { kind: "days", days: 30 } }, credential, 3, now).input?.expiresAt).toBe("2026-12-28T12:00:00.000Z");
  });
});

describe("agent credential stale edits", () => {
  // Meanwhile another admin renamed the key and removed the hidden grant.
  const reduced: LocalAgentCredentialSummary = { ...credential, name: "PM (renamed)", revision: 4,
    scope: { mode: "generic", grants: [{ conversationId: "conv_thread", includeThreads: false }] } };

  it("does not restore concurrently removed access when keeping a stale name-only draft", () => {
    const stale = { ...draftFromCredential(credential), name: "Project manager" };
    const { draft, conflicts, scopeReset } = rebaseDraft(stale, credential, reduced);
    expect(draft.grants).toEqual([{ conversationId: "conv_thread", includeThreads: false }]);
    expect([conflicts, scopeReset]).toEqual([[], false]);
    expect(buildUpdateInput(draft, reduced, reduced.revision, now).input).toEqual({ expectedRevision: 4, name: "Project manager" });
  });

  it("takes untouched fields from current and keeps only the human's edits", () => {
    const disabled = { ...reduced, capabilities: [] as [] };
    const untouched = rebaseDraft(draftFromCredential(credential), credential, disabled).draft;
    expect([untouched.name, untouched.inspect, untouched.expiry]).toEqual(["PM (renamed)", false, { kind: "keep" }]);
    expect(buildUpdateInput(untouched, disabled, 4, now).error).toBe("No changes to save.");
  });

  it("rebases target edits onto current grants and keeps current access where both sides changed a target", () => {
    const opened = draftFromCredential(credential);
    // The human adds #ops and turns threads off for the hidden grant that the other admin removed.
    const edited = { ...opened, grants: [
      { conversationId: "conv_hidden", includeThreads: false }, { conversationId: "conv_thread", includeThreads: false }, { conversationId: "conv_ops", includeThreads: false },
    ] };
    const { draft, conflicts } = rebaseDraft(edited, credential, reduced);
    expect(draft.grants).toEqual([{ conversationId: "conv_thread", includeThreads: false }, { conversationId: "conv_ops", includeThreads: false }]);
    expect(conflicts).toEqual(["conv_hidden"]);
    // Mode changes on both sides cannot be combined target by target.
    const locked: LocalAgentCredentialSummary = { ...reduced, scope: { mode: "locked", conversationId: "conv_thread", includeThreads: false } };
    const reset = rebaseDraft(edited, credential, locked);
    expect([reset.scopeReset, reset.draft.mode, reset.draft.grants]).toEqual([true, "locked", [{ conversationId: "conv_thread", includeThreads: false }]]);
  });
});

describe("agent credential outcomes", () => {
  it("separates explicit rejections from unknown outcomes", () => {
    const failure = (status: number, code: string) => classifyCredentialFailure(new LocalControlClientError(code, status)).kind;
    expect(failure(403, "forbidden")).toBe("denied");
    expect(failure(401, "unauthenticated")).toBe("denied");
    expect(failure(400, "invalid_request")).toBe("invalid");
    expect(failure(404, "target_unavailable")).toBe("unavailable");
    expect(failure(409, "revision_conflict")).toBe("conflict");
    expect(failure(409, "credential_inactive")).toBe("inactive");
    expect(failure(409, "request_already_recorded")).toBe("recorded");
    expect(failure(503, "credential_admin_unavailable")).toBe("unknown");
    expect(failure(502, "Local control request failed (502)")).toBe("unknown");
    expect(classifyCredentialFailure(new DOMException("aborted", "AbortError")).kind).toBe("unknown");
    expect(classifyCredentialFailure(new TypeError("Failed to fetch")).kind).toBe("unknown");
  });

  it("never treats a denial as proof that a mutation was not committed", () => {
    // The backend re-authorizes and re-checks the session after persistence.
    const committed = (status: number, code: string) => classifyCredentialFailure(new LocalControlClientError(code, status)).mayHaveCommitted;
    expect(committed(401, "unauthenticated")).toBe(true);
    expect(committed(403, "forbidden")).toBe(true);
    expect(committed(503, "credential_admin_unavailable")).toBe(true);
    expect(classifyCredentialFailure(new TypeError("Failed to fetch")).mayHaveCommitted).toBe(true);
    for (const [status, code] of [[400, "invalid_request"], [404, "target_unavailable"], [404, "credential_unavailable"], [409, "revision_conflict"],
      [409, "credential_inactive"], [409, "request_already_recorded"]] as const) expect(committed(status, code)).toBe(false);
  });

  it("bounds concurrent reads and preserves result order", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapBounded([5, 1, 4, 2, 3, 0], 2, async value => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, value));
      active -= 1;
      return value * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });

  it("resolves an unknown creation only by its recorded request ID", () => {
    expect(findCreatedCredential([credential], "ui_request_000001")).toBe(credential);
    expect(findCreatedCredential([credential], "ui_request_000002")).toBeUndefined();
  });

  it("reports derived status honestly and keeps intents secret-free", () => {
    expect(credentialStatus(credential, now)).toBe("active");
    expect(credentialStatus(credential, Date.parse(credential.expiresAt))).toBe("expired");
    expect(credentialStatus({ ...credential, revokedAt: "2026-11-03T00:00:00.000Z" }, now)).toBe("revoked");
    expect(() => credentialIntents.set("k", { secret: "chak_x" } as never)).toThrow();
    let notified = 0;
    const stop = credentialIntents.subscribe(() => { notified += 1; });
    credentialIntents.set("k", { kind: "rotate", credentialId: credential.id, expectedRevision: 3, secretGeneration: 2, state: "unknown" });
    credentialIntents.clear("k");
    stop();
    expect(notified).toBe(2);
    expect(credentialIntents.get("k")).toBeUndefined();
  });
});
