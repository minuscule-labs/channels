import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureAuthoredContext, InMemoryRelayBindingStore, type AuthoredSkillInvocation, type RelayBindingStore } from "@minu/channels-relay";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "../src/storage.ts";

const timestamp = "2026-11-03T12:00:00.000Z";
async function prepare(store: RelayBindingStore): Promise<AuthoredSkillInvocation> {
  await store.createAuthoredDocument({ id: "skill", workspaceId: "workspace", kind: "skill", name: "Decision note", description: "Capture a decision",
    content: "PRIVATE_PROCEDURE", state: "active", version: 1, createdBy: "owner", updatedBy: "owner", createdAt: timestamp, updatedAt: timestamp });
  await store.mutateAuthoredDocument("workspace", "skill", { action: "publish", expectedVersion: 1, actorIdentityId: "owner", timestamp });
  const snapshot = await captureAuthoredContext(store, "workspace", "channel");
  for (const id of ["one", "two"]) {
    await store.putAgentConfig({ id: `config-${id}`, workspaceId: "workspace", agentIdentityId: id, status: "active", createdAt: timestamp, updatedAt: timestamp });
    await store.putBinding({ id: `binding-${id}`, workspaceAgentConfigId: `config-${id}`, workspaceId: "workspace", conversationId: "channel",
      agentIdentityId: id, runtimeAdapter: "fixture", runtimeSessionId: `PRIVATE_RUNTIME_${id}`, runtimeOwnerId: "PRIVATE_OWNER", generation: 1,
      state: id === "one" ? "connected" : "paused", wakePolicy: "mentions", createdAt: timestamp, updatedAt: timestamp }, { authoredContext: snapshot });
  }
  return { id: "operation", workspaceId: "workspace", conversationId: "channel", channelId: "channel", actorIdentityId: "owner",
    requestId: "request", requestHash: "a".repeat(64), documentId: "skill", source: "workspace", revision: 1,
    contentHash: snapshot.documents[0]!.contentHash, name: "Decision note", arguments: "Capture the decision", acceptedAt: timestamp,
    targets: ["one", "two"].map(identityId => ({ identityId, bindingId: `binding-${identityId}`, generation: 1 })) };
}

for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend}: invocation uniqueness is actor scoped and accepted intent is immutable`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "minu-invocation-store-"));
    const store: RelayBindingStore = backend === "memory" ? new InMemoryRelayBindingStore()
      : await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(directory, "relay.db")) });
    try {
      const input = await prepare(store);
      const second = await store.reserveAuthoredSkillInvocation({ ...input, id: "admin-operation", actorIdentityId: "admin",
        targets: [{ identityId: "one", bindingId: "binding-one", generation: 1 }] });
      assert.equal(second?.id, "admin-operation");
      const outcomes = await Promise.all([store.reserveAuthoredSkillInvocation(input), store.reserveAuthoredSkillInvocation({ ...input, id: "competing-id" })]);
      assert.ok(outcomes.some(Boolean));
      const accepted = (await store.getAuthoredSkillInvocation("channel", "owner", "request"))!;
      assert.ok(accepted.id === "operation" || accepted.id === "competing-id");
      assert.ok(outcomes.every(result => !result || result.id === accepted.id));
      assert.equal(await store.getAuthoredSkillInvocation("other-channel", "owner", "request"), undefined);
      assert.equal(await store.getAuthoredSkillInvocation("channel", "other-actor", "request"), undefined);
      assert.equal((await store.reserveAuthoredSkillInvocation({ ...input, id: "different-payload", arguments: "must not replace", requestHash: "b".repeat(64) }))?.id, accepted.id);
      const next = { ...input, id: "after-contention", requestId: "after-contention" };
      let continued = await store.reserveAuthoredSkillInvocation(next);
      if (!continued) {
        // Simulate a caller explicitly inspecting absence before one exact retry, not an internal retry loop.
        assert.equal(await store.getAuthoredSkillInvocation("channel", "owner", next.requestId), undefined);
        continued = await store.reserveAuthoredSkillInvocation(next);
      }
      assert.equal(continued?.id, next.id);
      input.targets[0]!.generation = 99;
      accepted.targets[0]!.identityId = "caller mutation";
      assert.equal((await store.getAuthoredSkillInvocation("channel", "owner", "request"))?.targets[0]?.identityId, "one");
      assert.equal((await store.getAuthoredSkillInvocation("channel", "owner", "request"))?.targets[0]?.generation, 1);
      assert.equal((await store.getAuthoredSkillInvocation("channel", "admin", "request"))?.id, "admin-operation");
      assert.equal((await store.getAuthoredSkillInvocation("channel", "owner", "request"))?.arguments, "Capture the decision");
    } finally { await store.close?.(); await rm(directory, { recursive: true, force: true }); }
  });

  test(`${backend}: invocation commit rejects scope/reference/session mismatches as one group`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "minu-invocation-fence-"));
    const store: RelayBindingStore = backend === "memory" ? new InMemoryRelayBindingStore()
      : await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(directory, "relay.db")) });
    try {
      const input = await prepare(store);
      const invalid: AuthoredSkillInvocation[] = [
        { ...input, source: "channel" }, { ...input, contentHash: "wrong-hash" }, { ...input, revision: 2 }, { ...input, channelId: "other-channel" },
        { ...input, targets: [] }, { ...input, targets: [input.targets[0]!, input.targets[0]!] },
        { ...input, targets: [{ ...input.targets[0]!, identityId: "wrong-identity" }] },
        { ...input, targets: [input.targets[0]!, { ...input.targets[1]!, generation: 99 }] },
      ];
      for (const candidate of invalid) {
        assert.equal(await store.reserveAuthoredSkillInvocation(candidate), undefined);
        assert.equal(await store.getAuthoredSkillInvocation("channel", "owner", "request"), undefined);
      }
      await store.beginStopBinding("binding-one", 1, "connected", timestamp);
      assert.equal(await store.reserveAuthoredSkillInvocation(input), undefined);
      assert.equal(await store.getAuthoredSkillInvocation("channel", "owner", "request"), undefined);
    } finally { await store.close?.(); await rm(directory, { recursive: true, force: true }); }
  });

  test(`${backend}: archival rejects new operations but does not rewrite an accepted receipt`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "minu-invocation-archive-"));
    const store: RelayBindingStore = backend === "memory" ? new InMemoryRelayBindingStore()
      : await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(directory, "relay.db")) });
    try {
      const input = await prepare(store);
      const accepted = await store.reserveAuthoredSkillInvocation(input);
      await store.mutateAuthoredDocument("workspace", "skill", { action: "archive", expectedVersion: 2, actorIdentityId: "owner", timestamp });
      assert.deepEqual(await store.reserveAuthoredSkillInvocation(input), accepted);
      assert.equal(await store.reserveAuthoredSkillInvocation({ ...input, id: "new-operation", requestId: "new-request" }), undefined);
      assert.equal(await store.getAuthoredSkillInvocation("channel", "owner", "new-request"), undefined);
    } finally { await store.close?.(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("SQLite invocation rollback, persistent reopen, and cross-connection uniqueness preserve exact accepted intent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-invocation-persistent-"));
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  let store = await DrizzleLibSqlRelayStorage.open({ url });
  const raw = createClient({ url });
  let competitor: DrizzleLibSqlRelayStorage | undefined;
  try {
    const input = await prepare(store);
    await raw.execute("CREATE TRIGGER reject_invocation BEFORE INSERT ON authored_skill_invocations BEGIN SELECT RAISE(ABORT, 'fixture-invocation-failure'); END");
    await assert.rejects(store.reserveAuthoredSkillInvocation(input));
    assert.equal(await store.getAuthoredSkillInvocation("channel", "owner", "request"), undefined);
    assert.equal((await store.listConversationBindings("channel")).find(binding => binding.agentIdentityId === "one")?.generation, 1);
    await raw.execute("DROP TRIGGER reject_invocation");
    competitor = await DrizzleLibSqlRelayStorage.open({ url });
    const outcomes = await Promise.all([store.reserveAuthoredSkillInvocation(input), competitor.reserveAuthoredSkillInvocation({ ...input, id: "competitor" })]);
    assert.ok(outcomes.some(Boolean));
    const accepted = await store.getAuthoredSkillInvocation("channel", "owner", "request");
    assert.ok(accepted);
    assert.equal((await raw.execute("SELECT count(*) AS n FROM authored_skill_invocations")).rows[0]?.n, 1);
    await store.close();
    store = await DrizzleLibSqlRelayStorage.open({ url });
    assert.deepEqual(await store.getAuthoredSkillInvocation("channel", "owner", "request"), accepted);
    assert.deepEqual(await store.reserveAuthoredSkillInvocation(input), accepted);
    assert.equal((await raw.execute("SELECT count(*) AS n FROM authored_skill_invocations")).rows[0]?.n, 1);
  } finally { raw.close(); await competitor?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});
