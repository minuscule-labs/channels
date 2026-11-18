import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import { InMemoryRelayBindingStore, type ConversationAgentBindingRecord, type RelayBindingStore } from "@minu/channels-relay";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "../src/storage.ts";

const now = "2026-11-02T12:00:00.000Z";
const during = "2026-11-02T12:00:01.000Z";
const expiry = "2026-11-02T12:00:30.000Z";
const later = "2026-11-02T12:00:31.000Z";
const record: ConversationAgentBindingRecord = {
  id: "binding", workspaceAgentConfigId: "config", workspaceId: "workspace", conversationId: "conversation",
  agentIdentityId: "agent", runtimeAdapter: "pi", runtimeSessionId: "original-session", runtimeOwnerId: "runtime-owner",
  generation: 1, state: "connected", wakePolicy: "mentions", createdAt: now, updatedAt: now,
};
async function seed(store: RelayBindingStore) {
  await store.putAgentConfig({ id: "config", workspaceId: "workspace", agentIdentityId: "agent", runtimeAdapter: "pi",
    status: "active", createdAt: now, updatedAt: now });
  await store.putBinding(record, { contextMode: "with_context", conversationSequence: 0 });
}

for (const persistent of [false, true]) {
  test(`recovery reservation fences other owners and rejects stale commits (persistent=${persistent})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "recovery-lease-contract-"));
    const store = persistent ? await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(directory, "relay.db")) }) : new InMemoryRelayBindingStore();
    try {
      await seed(store);
      await store.acquireBindingLease(record.id, "old-delivery", now, expiry);
      const recovery = await store.beginBindingRecovery(record.id, 1, "connected", "recovery-a", now, expiry);
      assert.equal(recovery?.state, "stopping");
      assert.equal(recovery?.leaseOwner, "recovery-a");
      assert.equal(await store.renewBindingLease(record.id, 1, "old-delivery", during, expiry), false);
      await store.releaseBindingLease(record.id, 1, "old-delivery");
      assert.equal((await store.getBinding(record.id))?.leaseOwner, "recovery-a", "Old route teardown must not release the recovery reservation");
      assert.equal(await store.acquireBindingLease(record.id, "another-host", during, expiry), undefined);
      assert.equal(await store.beginBindingRecovery(record.id, 1, "stopping", "recovery-b", during, expiry), undefined);
      assert.equal(await store.pauseBinding(record.id, 1, 9, during), undefined);
      assert.equal(await store.replaceBindingSession(record.id, 1, "pi", "replacement", during, "runtime-owner"), undefined);
      assert.equal(await store.replaceBindingSession(record.id, 1, "pi", "replacement", during, "runtime-owner",
        { conversationSequence: 9 }, "wrong-owner"), undefined);
      assert.equal(await store.completeBindingRecovery(record.id, 1, "wrong-owner", 9, "paused", during), undefined);
      assert.equal(await store.completeBindingRecovery(record.id, 1, "recovery-a", 9, "paused", later), undefined);
      const reclaimed = await store.beginBindingRecovery(record.id, 1, "stopping", "recovery-b", later, "2026-11-02T12:01:00.000Z");
      assert.equal(reclaimed?.leaseOwner, "recovery-b");
      assert.equal(await store.replaceBindingSession(record.id, 1, "pi", "stale-replacement", later, "runtime-owner",
        { conversationSequence: 9 }, "recovery-a"), undefined);
      assert.equal(await store.getCursor(record.conversationId, record.agentIdentityId), 0);
      const replaced = await store.replaceBindingSession(record.id, 1, "pi", "replacement", later, "runtime-owner",
        { conversationSequence: 9, contextMode: "with_context" }, "recovery-b");
      assert.equal(replaced?.generation, 2);
      assert.equal(replaced?.state, "replacing");
      assert.equal(replaced?.leaseOwner, undefined);
      assert.equal(await store.getCursor(record.conversationId, record.agentIdentityId), 9);
      assert.equal((await store.listSessionHistory(record.conversationId)).length, 2);
    } finally { await store.close?.(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("SQLite rolls back replacement identity and history when its no-replay boundary cannot commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recovery-atomic-boundary-"));
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  const store = await DrizzleLibSqlRelayStorage.open({ url });
  const connection = createClient({ url });
  try {
    await seed(store);
    await store.beginBindingRecovery(record.id, 1, "connected", "recovery-a", now, expiry);
    await connection.execute("CREATE TRIGGER fail_recovery_cursor BEFORE INSERT ON agent_host_cursors BEGIN SELECT RAISE(ABORT, 'recovery cursor unavailable'); END");
    await assert.rejects(store.replaceBindingSession(record.id, 1, "pi", "replacement", during, "runtime-owner",
      { conversationSequence: 9, contextMode: "with_context" }, "recovery-a"));
    const unchanged = (await store.getBinding(record.id))!;
    assert.equal(unchanged.generation, 1);
    assert.equal(unchanged.runtimeSessionId, record.runtimeSessionId);
    assert.equal(unchanged.state, "stopping");
    assert.equal(unchanged.leaseOwner, "recovery-a");
    assert.equal(await store.getCursor(record.conversationId, record.agentIdentityId), 0);
    const history = await store.listSessionHistory(record.conversationId);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.state, "active");
    await assert.rejects(store.completeBindingRecovery(record.id, 1, "recovery-a", 9, "paused", during));
    assert.equal((await store.getBinding(record.id))?.state, "stopping");
    await connection.execute("DROP TRIGGER fail_recovery_cursor");
    const stopped = await store.completeBindingRecovery(record.id, 1, "recovery-a", 9, "paused", during);
    assert.equal(stopped?.state, "paused");
    assert.equal(stopped?.leaseOwner, undefined);
    assert.equal(await store.getCursor(record.conversationId, record.agentIdentityId), 9);
  } finally { connection.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});
