import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureAuthoredContext, InMemoryRelayBindingStore, type AuthoredDocument, type RelayBindingStore } from "@minu/channels-relay";
import { defaultRelayMigrationsFolder, DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "../src/storage.ts";

const timestamp = "2026-11-03T12:00:00.000Z";
function draft(overrides: Partial<AuthoredDocument> = {}): AuthoredDocument {
  return {
    id: "skill-1", workspaceId: "workspace-1", conversationId: undefined, publishedRevision: undefined, kind: "skill", name: "Decision note",
    description: "Capture a decision", content: "Save under the workspace's permitted folder.",
    state: "active", version: 1, createdBy: "owner", updatedBy: "owner", createdAt: timestamp, updatedAt: timestamp,
    ...overrides,
  };
}

for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend}: draft/publication scope, CAS, immutable history, and archive`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "minu-authored-store-"));
    const store: RelayBindingStore = backend === "memory" ? new InMemoryRelayBindingStore()
      : await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(directory, "relay.db")) });
    try {
      const original = draft();
      assert.deepEqual(await store.createAuthoredDocument(original), original);
      assert.equal(await store.createAuthoredDocument(original), undefined);
      assert.equal(await store.getAuthoredDocument("workspace-2", original.id), undefined);
      assert.deepEqual(await store.listAuthoredDocuments("workspace-2"), []);
      assert.deepEqual(await store.listAuthoredDocumentRevisions("workspace-1", original.id), []);
      assert.equal(await store.mutateAuthoredDocument("workspace-2", original.id, {
        action: "publish", expectedVersion: 1, actorIdentityId: "owner", timestamp,
      }), undefined);

      const published = await store.mutateAuthoredDocument("workspace-1", original.id, {
        action: "publish", expectedVersion: 1, actorIdentityId: "publisher", timestamp,
      });
      assert.equal(published?.version, 2);
      assert.equal(published?.publishedRevision, 1);
      const [revision] = await store.listAuthoredDocumentRevisions("workspace-1", original.id);
      assert.equal(revision?.publishedBy, "publisher");
      assert.equal(revision?.content, original.content);
      assert.equal(revision?.contentHash, createHash("sha256").update(JSON.stringify({
        name: original.name, description: original.description, content: original.content,
      })).digest("hex"));
      assert.deepEqual(await store.listAuthoredDocumentRevisions("workspace-2", original.id), []);

      // An uncertain successful publication is inspectable; replaying its old token cannot republish it.
      assert.equal(await store.mutateAuthoredDocument("workspace-1", original.id, {
        action: "publish", expectedVersion: 1, actorIdentityId: "publisher", timestamp,
      }), undefined);
      assert.equal((await store.listAuthoredDocumentRevisions("workspace-1", original.id)).length, 1);
      const saved = await store.mutateAuthoredDocument("workspace-1", original.id, {
        action: "save", expectedVersion: 2, actorIdentityId: "editor", timestamp,
        name: "Revised", description: "Revised description", content: "Draft revision two",
      });
      assert.equal(saved?.publishedRevision, 1);
      assert.equal(saved?.version, 3);
      assert.deepEqual((await store.listAuthoredDocumentRevisions("workspace-1", original.id))[0], revision);
      const stale = await store.mutateAuthoredDocument("workspace-1", original.id, {
        action: "save", expectedVersion: 2, actorIdentityId: "stale-editor", timestamp,
        name: "Overwrite", description: "Bad", content: "Must not persist",
      });
      assert.equal(stale, undefined);
      await store.mutateAuthoredDocument("workspace-1", original.id, {
        action: "publish", expectedVersion: 3, actorIdentityId: "publisher", timestamp,
      });
      assert.deepEqual((await store.listAuthoredDocumentRevisions("workspace-1", original.id)).map((r) => [r.revision, r.content]), [
        [1, original.content], [2, "Draft revision two"],
      ]);
      const archived = await store.mutateAuthoredDocument("workspace-1", original.id, {
        action: "archive", expectedVersion: 4, actorIdentityId: "owner", timestamp,
      });
      assert.equal(archived?.state, "archived");
      assert.equal(await store.mutateAuthoredDocument("workspace-1", original.id, {
        action: "publish", expectedVersion: 5, actorIdentityId: "owner", timestamp,
      }), undefined);
      const read = (await store.getAuthoredDocument("workspace-1", original.id))!;
      read.content = "caller mutation";
      const history = await store.listAuthoredDocumentRevisions("workspace-1", original.id);
      history[0]!.content = "caller mutation";
      assert.equal((await store.getAuthoredDocument("workspace-1", original.id))?.content, "Draft revision two");
      assert.equal((await store.listAuthoredDocumentRevisions("workspace-1", original.id))[0]?.content, original.content);

      await store.createAuthoredDocument(draft({ id: "workspace-instructions", kind: "instructions" }));
      assert.equal(await store.createAuthoredDocument(draft({ id: "duplicate", kind: "instructions" })), undefined);
      await store.createAuthoredDocument(draft({ id: "channel-instructions", kind: "instructions", conversationId: "channel-1" }));
      assert.equal(await store.createAuthoredDocument(draft({ id: "duplicate-channel", kind: "instructions", conversationId: "channel-1" })), undefined);
      assert.ok(await store.createAuthoredDocument(draft({ id: "other-channel", kind: "instructions", conversationId: "channel-2" })));
      assert.ok(await store.createAuthoredDocument(draft({ id: "other-workspace", kind: "instructions", workspaceId: "workspace-2" })));
    } finally {
      await store.close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`${backend}: competing writers cannot both publish the same draft`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "minu-authored-cas-"));
    const store: RelayBindingStore = backend === "memory" ? new InMemoryRelayBindingStore()
      : await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(directory, "relay.db")) });
    try {
      await store.createAuthoredDocument(draft());
      const results = await Promise.all(["editor-a", "editor-b"].map((actorIdentityId) => store.mutateAuthoredDocument("workspace-1", "skill-1", {
        action: "publish", expectedVersion: 1, actorIdentityId, timestamp,
      })));
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal((await store.listAuthoredDocumentRevisions("workspace-1", "skill-1")).length, 1);
      assert.equal((await store.getAuthoredDocument("workspace-1", "skill-1"))?.version, 2);
    } finally {
      await store.close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("SQLite publication rollback and reopen preserve head/history consistency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-authored-atomic-"));
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  let store = await DrizzleLibSqlRelayStorage.open({ url });
  const raw = createClient({ url });
  try {
    await store.createAuthoredDocument(draft());
    await raw.execute("CREATE TRIGGER reject_publication BEFORE INSERT ON authored_document_revisions BEGIN SELECT RAISE(ABORT, 'fixture-publication-failure'); END");
    await assert.rejects(store.mutateAuthoredDocument("workspace-1", "skill-1", {
      action: "publish", expectedVersion: 1, actorIdentityId: "owner", timestamp,
    }), (error: unknown) => error instanceof Error && error.cause instanceof Error && /fixture-publication-failure/.test(error.cause.message));
    assert.equal((await store.getAuthoredDocument("workspace-1", "skill-1"))?.version, 1);
    assert.deepEqual(await store.listAuthoredDocumentRevisions("workspace-1", "skill-1"), []);
    await raw.execute("DROP TRIGGER reject_publication");
    await store.mutateAuthoredDocument("workspace-1", "skill-1", {
      action: "publish", expectedVersion: 1, actorIdentityId: "owner", timestamp,
    });
    await store.close();
    store = await DrizzleLibSqlRelayStorage.open({ url });
    assert.equal((await store.getAuthoredDocument("workspace-1", "skill-1"))?.publishedRevision, 1);
    assert.equal((await store.listAuthoredDocumentRevisions("workspace-1", "skill-1"))[0]?.content, draft().content);
  } finally {
    raw.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("authored-content migration preserves existing private Workspace, agent configuration, presets and conversation settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-authored-migration-"));
  const migrationsFolder = join(directory, "old-migrations");
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  let store: DrizzleLibSqlRelayStorage | undefined;
  try {
    await cp(defaultRelayMigrationsFolder(), migrationsFolder, { recursive: true });
    const journalPath = join(migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 17);
    await writeFile(journalPath, JSON.stringify(journal));
    store = await DrizzleLibSqlRelayStorage.open({ url, migrationsFolder });
    await store.putWorkspaceConfig({ workspaceId: "workspace-1", rootUri: "file:///private/source", notesFolderId: "notes-base", createdAt: timestamp, updatedAt: timestamp });
    await store.putAgentConfig({ id: "agent-config", workspaceId: "workspace-1", agentIdentityId: "agent-1", personaPrompt: "Existing persona", skillIds: ["native-review"], status: "active", createdAt: timestamp, updatedAt: timestamp });
    const preset = { id: "preset-1", workspaceId: "workspace-1", name: "Existing preset", revision: 1, participants: [], createdAt: timestamp, updatedAt: timestamp };
    const setup = { workspaceId: "workspace-1", conversationId: "channel-1", actorIdentityId: "owner", name: "Existing setup", participants: [] };
    assert.equal(await store.putConversationPreset(preset, null), true);
    await store.putConversationCreationSetup(setup);
    const settings = { workspaceId: "workspace-1", conversationId: "channel-1", revision: 1, participants: [], guidance: "Existing guidance", turnTimeoutMs: 60_000 };
    assert.equal(await store.putConversationSettings(settings, 0), true);
    const workspace = await store.getWorkspaceConfig("workspace-1");
    const agent = await store.getAgentConfig("agent-config");
    await store.close();
    store = await DrizzleLibSqlRelayStorage.open({ url });
    assert.deepEqual(await store.getWorkspaceConfig("workspace-1"), workspace);
    assert.deepEqual(await store.getAgentConfig("agent-config"), agent);
    assert.deepEqual(await store.listConversationPresets("workspace-1"), [preset]);
    assert.deepEqual(await store.getConversationCreationSetup("workspace-1", "channel-1"), setup);
    assert.deepEqual(await store.getConversationSettings("workspace-1", "channel-1"), settings);
    assert.deepEqual(await store.listAuthoredDocuments("workspace-1"), []);
    assert.ok(await store.createAuthoredDocument(draft()));
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend}: activation manifests are immutable copies and survive persistent reopen`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "minu-authored-activation-"));
    const url = localRelayLibSqlUrl(join(directory, "relay.db"));
    let store: RelayBindingStore = backend === "memory" ? new InMemoryRelayBindingStore()
      : await DrizzleLibSqlRelayStorage.open({ url });
    try {
      await store.createAuthoredDocument(draft({ kind: "instructions" }));
      await store.mutateAuthoredDocument("workspace-1", "skill-1", { action: "publish", expectedVersion: 1, actorIdentityId: "owner", timestamp });
      const snapshot = await captureAuthoredContext(store, "workspace-1", "channel-1");
      await store.putAgentConfig({ id: "agent-config", workspaceId: "workspace-1", agentIdentityId: "agent", status: "active", createdAt: timestamp, updatedAt: timestamp });
      await store.putBinding({ id: "binding", workspaceAgentConfigId: "agent-config", workspaceId: "workspace-1", conversationId: "channel-1", agentIdentityId: "agent",
        runtimeAdapter: "fixture", runtimeSessionId: "session", runtimeOwnerId: "owned", generation: 1, state: "connected", wakePolicy: "mentions", createdAt: timestamp, updatedAt: timestamp },
      { authoredContext: snapshot });
      snapshot.documents[0]!.revision = 99;
      if (backend === "sqlite") {
        await store.close?.();
        store = await DrizzleLibSqlRelayStorage.open({ url });
      }
      const first = (await store.listSessionHistory("channel-1"))[0]!;
      assert.equal(first.authoredContext?.documents[0]?.revision, 1);
      first.authoredContext!.documents[0]!.revision = 100;
      const inspection = await store.getSessionInspectionRecords("workspace-1", "channel-1", "agent");
      assert.equal(inspection.activation?.authoredContext?.documents[0]?.revision, 1);
      inspection.activation!.authoredContext!.documents[0]!.revision = 101;
      assert.equal((await store.listSessionHistory("channel-1"))[0]?.authoredContext?.documents[0]?.revision, 1);
    } finally { await store.close?.(); await rm(directory, { recursive: true, force: true }); }
  });
}
