import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationClient, createConversationHttpServer } from "@minu/channels-core";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { createLocalControlDaemon, type LocalControlDaemon } from "../src/daemon.ts";
import type { LocalAgentDeliveryTrails } from "../src/contracts.ts";

test("real daemon records an eligible fake-managed turn and serves its trail through authenticated HTTP with temporary SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delivery-daemon-")), workspaceRoot = join(dir, "workspace");
  await mkdir(workspaceRoot);
  const core = await createConversationHttpServer({ port: 0 });
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  let daemon: LocalControlDaemon | undefined;
  try {
    const owner = await client.createIdentity({ type: "human", displayName: "Owner" }), agent = await client.createIdentity({ type: "agent", displayName: "Agent" });
    const workspace = await client.createWorkspace({ slug: "delivery-integration", name: "Delivery integration" });
    await client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
    await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
    const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, agent.id] });
    const path = join(dir, "relay.db"), store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(path) });
    const now = new Date().toISOString();
    await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: workspaceRoot, createdAt: now, updatedAt: now });
    await store.putAgentConfig({ id: "integration-config", workspaceId: workspace.id, agentIdentityId: agent.id, runtimeAdapter: "fake", status: "active", createdAt: now, updatedAt: now });
    await store.close();
    const sessions = new Map<string, { ownerId: string; messages: Array<{ role: "assistant"; content: string }> }>();
    let starts = 0;
    const runtime = {
      async start() { throw new Error("must use fake managed session"); },
      async startManaged(_config: unknown, ownerId: string) { const id = `fake-session-${++starts}`; sessions.set(id, { ownerId, messages: [] }); return { id, ownerId }; },
      async listManagedSessions(ownerId: string) { return [...sessions].filter(([, value]) => value.ownerId === ownerId).map(([id]) => ({ id, ownerId, state: "active" as const })); },
      async status() { return "idle" as const; },
      async send(id: string) { sessions.get(id)!.messages.push({ role: "assistant", content: "CANARY_PUBLIC_REPLY" }); },
      async messages(id: string) { return [...sessions.get(id)!.messages]; },
      async startTurn() { throw new Error("this fake uses the legacy callback boundary"); },
      async turn() { return undefined; },
    };
    // Omit recoverable-turn methods from this controlled adapter, rather than starting any harness process.
    const { startTurn: _startTurn, turn: _turn, ...legacy } = runtime;
    daemon = await createLocalControlDaemon({ relayDatabasePath: path, currentHumanIdentityId: owner.id, conversationsEndpoint: core.endpoint,
      conversationsServiceToken: core.serviceToken, port: 0, webUrl: "http://127.0.0.1:5174/", runtimes: { fake: legacy } });
    const exchange = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
    const headers = { cookie: exchange.headers.get("set-cookie")!.split(";", 1)[0]!, origin: "http://127.0.0.1:5174" };
    const base = `${daemon.endpoint}/local/conversations/${conversation.id}/agents/${agent.id}`;
    const started = await fetch(`${base}/start`, { method: "POST", headers }); assert.equal(started.status, 201); await started.arrayBuffer();
    const trigger = await client.postMessage(conversation.id, { participantId: owner.id, body: "@agent CANARY_PRIVATE_INPUT" });
    let result: LocalAgentDeliveryTrails | undefined; const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const response = await fetch(`${base}/delivery-trails`, { headers }); assert.equal(response.status, 200);
      result = await response.json() as LocalAgentDeliveryTrails;
      if (result.selected?.outcome === "delivered") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(result?.selected?.outcome, "delivered"); assert.equal(result?.selected?.triggerSequence, trigger.sequence);
    assert.ok(result?.selected?.events.some(event => event.stage === "response_committed"));
    assert.ok(result?.selected?.events.some(event => event.stage === "cursor_committed"));
    assert.equal(starts, 1); assert.equal((await client.listMessages(conversation.id)).length, 2);
    assert.doesNotMatch(JSON.stringify(result), /CANARY|bindingId|sessionId|ownerId|triggerId|epoch/);
    assert.equal((await fetch(`${base}/delivery-trails`)).status, 401);
  } finally { await daemon?.close(); await core.close(); await rm(dir, { recursive: true, force: true }); }
});
