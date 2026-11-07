import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRelayBindingStore } from "../src/binding-store.ts";
import { captureAuthoredContext, resolveAuthoredInstructions, validateAuthoredContext, AuthoredContextUnavailableError } from "../src/authored-context.ts";
import type { AuthoredDocument } from "../src/authored-documents.ts";

const now = "2026-11-03T12:00:00.000Z";
async function published(store: InMemoryRelayBindingStore, id: string, content: string, options: Partial<AuthoredDocument> = {}) {
  await store.createAuthoredDocument({ id, workspaceId: "W1", kind: "instructions", name: id, description: "Description", content,
    version: 1, state: "active", createdBy: "owner", updatedBy: "owner", createdAt: now, updatedAt: now, ...options });
  await store.mutateAuthoredDocument(options.workspaceId ?? "W1", id, { action: "publish", expectedVersion: 1, actorIdentityId: "owner", timestamp: now });
}

test("authored context selects published scoped revisions, not drafts or whole playbook bodies", async () => {
  const store = new InMemoryRelayBindingStore();
  await published(store, "workspace", "WORKSPACE_V1");
  await published(store, "channel", "CHANNEL_V1", { conversationId: "C1" });
  await published(store, "sibling", "SIBLING_ONLY", { conversationId: "C2" });
  await published(store, "foreign", "FOREIGN_ONLY", { workspaceId: "W2" });
  await published(store, "playbook", "PROCEDURE_NOT_STANDING_INSTRUCTIONS", { kind: "skill" });
  const snapshot = await captureAuthoredContext(store, "W1", "C1");
  assert.deepEqual(snapshot.documents.map((ref) => ref.documentId), ["playbook", "workspace", "channel"]);
  let guidance = await resolveAuthoredInstructions(store, snapshot);
  assert.match(guidance!, /WORKSPACE_V1/);
  assert.match(guidance!, /CHANNEL_V1/);
  assert.ok(guidance!.indexOf("WORKSPACE_V1") < guidance!.indexOf("CHANNEL_V1"));
  assert.doesNotMatch(guidance!, /SIBLING_ONLY|FOREIGN_ONLY|PROCEDURE_NOT/);
  await store.mutateAuthoredDocument("W1", "workspace", { action: "save", expectedVersion: 2, name: "workspace", description: "", content: "UNPUBLISHED_DRAFT", actorIdentityId: "owner", timestamp: now });
  assert.match((await resolveAuthoredInstructions(store, await captureAuthoredContext(store, "W1", "C1")))!, /WORKSPACE_V1/);
  await store.mutateAuthoredDocument("W1", "workspace", { action: "publish", expectedVersion: 3, actorIdentityId: "owner", timestamp: now });
  guidance = await resolveAuthoredInstructions(store, snapshot);
  assert.match(guidance!, /WORKSPACE_V1/);
  assert.doesNotMatch(guidance!, /UNPUBLISHED_DRAFT/);
  assert.match((await resolveAuthoredInstructions(store, await captureAuthoredContext(store, "W1", "C1")))!, /UNPUBLISHED_DRAFT/);
});

test("empty publications clear future guidance without changing pinned instructions", async () => {
  const store = new InMemoryRelayBindingStore();
  assert.equal(await resolveAuthoredInstructions(store, await captureAuthoredContext(store, "W1", "C1")), undefined);
  await published(store, "workspace", "ORIGINAL");
  const snapshot = await captureAuthoredContext(store, "W1", "C1");
  await store.mutateAuthoredDocument("W1", "workspace", { action: "save", expectedVersion: 2, name: "workspace", description: "", content: "", actorIdentityId: "owner", timestamp: now });
  await store.mutateAuthoredDocument("W1", "workspace", { action: "publish", expectedVersion: 3, actorIdentityId: "owner", timestamp: now });
  assert.equal(await resolveAuthoredInstructions(store, await captureAuthoredContext(store, "W1", "C1")), undefined);
  assert.match((await resolveAuthoredInstructions(store, snapshot))!, /ORIGINAL/);
});

test("missing, foreign, corrupt, or ambiguous pinned context fails rather than resolving latest", async () => {
  const store = new InMemoryRelayBindingStore();
  await published(store, "workspace", "ORIGINAL");
  const snapshot = await captureAuthoredContext(store, "W1", "C1");
  assert.throws(() => validateAuthoredContext(snapshot, "W2", "C1"), AuthoredContextUnavailableError);
  assert.throws(() => validateAuthoredContext(snapshot, "W1", "C2"), AuthoredContextUnavailableError);
  for (const change of [{ revision: 9 }, { documentId: "missing" }, { contentHash: "0".repeat(64) }]) {
    const bad = structuredClone(snapshot);
    Object.assign(bad.documents[0]!, change);
    await assert.rejects(resolveAuthoredInstructions(store, bad), AuthoredContextUnavailableError);
  }
  const duplicate = structuredClone(snapshot);
  duplicate.documents.push({ ...duplicate.documents[0]! });
  assert.throws(() => validateAuthoredContext(duplicate, "W1", "C1"), AuthoredContextUnavailableError);
  const history = store.listAuthoredDocumentRevisions.bind(store);
  store.listAuthoredDocumentRevisions = async (...args) => (await history(...args)).map((record) => ({ ...record, content: "CORRUPTED" }));
  await assert.rejects(resolveAuthoredInstructions(store, snapshot), AuthoredContextUnavailableError);
});
