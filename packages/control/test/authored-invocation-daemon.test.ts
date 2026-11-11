import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationClient, createConversationHttpServer } from "@minu/channels-core";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { captureAuthoredContext, type RuntimePortTurn } from "@minu/channels-relay";
import { LocalAgentHostConfiguration } from "../src/configuration.ts";
import { createLocalControlDaemon } from "../src/daemon.ts";
import { createLocalProductApp } from "../src/local.ts";
import type { LocalManagedRuntimePort } from "../src/agent-host.ts";
import type { LocalAuthoredSkillInvocationReceipt, LocalControlCapabilities } from "../src/contracts.ts";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Daemon invocation condition timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const enabled of [undefined, false, true]) {
  test(`daemon authored publication ${String(enabled)} preserves gate and selected-only delivery`, { timeout: 20_000 }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "channels-authored-daemon-")));
    const core = await createConversationHttpServer({ port: 0 });
    const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
    const databasePath = join(directory, "relay.db");
    let store: DrizzleLibSqlRelayStorage | undefined;
    let daemon: Awaited<ReturnType<typeof createLocalControlDaemon>> | undefined;
    try {
      store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(databasePath) });
      const human = await client.createIdentity({ type: "human", displayName: "Owner" });
      const selected = await client.createIdentity({ type: "agent", displayName: "Selected" });
      const peer = await client.createIdentity({ type: "agent", displayName: "Observer" });
      const workspace = await client.createWorkspace({ slug: "daemon-skills", name: "Daemon skills" });
      for (const identity of [human, selected, peer]) await client.addWorkspaceMember(workspace.id, {
        identityId: identity.id, mentionHandle: identity.displayName!.toLowerCase(), accessRole: identity === human ? "owner" : "member",
      });
      const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [human.id, selected.id, peer.id] });
      const now = new Date().toISOString();
      await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: directory, createdAt: now, updatedAt: now });
      const configuration = new LocalAgentHostConfiguration({ client, store });
      const skill = await configuration.createAuthoredDocument(workspace.id, human.id, {
        kind: "skill", name: "Decision", description: "Daemon integration", content: "PRIVATE_DAEMON_PROCEDURE",
      });
      await configuration.updateAuthoredDocument(workspace.id, skill.id, human.id, { action: "publish", expectedVersion: 1 });
      const manifest = await captureAuthoredContext(store, workspace.id, conversation.id);
      for (const identity of [selected, peer]) {
        const configId = `config-${identity.id}`;
        await store.putAgentConfig({ id: configId, workspaceId: workspace.id, agentIdentityId: identity.id,
          runtimeAdapter: "fixture", status: "active", createdAt: now, updatedAt: now });
        await store.putBinding({ id: `binding-${identity.id}`, workspaceAgentConfigId: configId, workspaceId: workspace.id,
          conversationId: conversation.id, agentIdentityId: identity.id, runtimeAdapter: "fixture", runtimeSessionId: identity.id,
          runtimeOwnerId: `owner-${identity.id}`, generation: 1, state: "connected",
          wakePolicy: identity === peer ? "all_messages" : "mentions", createdAt: now, updatedAt: now }, { authoredContext: manifest });
      }
      const pinnedBefore = await store.listWorkspaceBindings(workspace.id);
      await store.close(); store = undefined;
      const calls: Array<{ sessionId: string; turnId: string; input: string }> = [];
      const turns = new Map<string, RuntimePortTurn>();
      const runtime: LocalManagedRuntimePort = {
        async start() { throw new Error("Replacement session forbidden"); },
        async status() { return "idle"; },
        async getManagedSession(id, ownerId) { return { id, ownerId, state: "active" }; },
        async resume(id, ownerId) { return { id, ownerId }; },
        async messages() { return []; },
        async send() { throw new Error("Legacy send forbidden"); },
        async startManaged() { throw new Error("Replacement session forbidden"); },
        async turn(_sessionId, turnId) { return turns.get(turnId); },
        async startTurn(sessionId, turnId, input) {
          assert.equal(turns.has(turnId), false);
          calls.push({ sessionId, turnId, input });
          const timestamp = new Date().toISOString();
          const turn: RuntimePortTurn = { id: turnId, input, status: "completed", createdAt: timestamp, updatedAt: timestamp,
            response: { role: "assistant", content: "Daemon result" } };
          turns.set(turnId, turn); return turn;
        },
      };
      daemon = await createLocalControlDaemon({ currentHumanIdentityId: human.id, conversationsEndpoint: core.endpoint,
        conversationsServiceToken: core.serviceToken, relayDatabasePath: databasePath, runtimes: { fixture: runtime },
        authoredSkillPublicationEnabled: enabled, recordAgentDiagnostics: false, port: 0, webUrl: "http://127.0.0.1:5174/" });
      const bootstrap = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
      assert.equal(bootstrap.status, 303);
      const headers = { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!, origin: "http://127.0.0.1:5174", "content-type": "application/json" };
      const capabilities = await (await fetch(`${daemon.endpoint}/local/capabilities`, { headers })).json() as LocalControlCapabilities;
      assert.equal(capabilities.features.authoredSkillPublication, enabled === true);
      // Prove the otherwise-unselected all_messages peer is attached and eligible before measuring isolation.
      const control = await client.postMessage(conversation.id, { participantId: human.id, body: "Liveness", to: [peer.id] });
      await until(async () => (await client.listMessages(conversation.id)).some(message => message.replyTo === control.id));
      const baseline = calls.length;
      assert.deepEqual(calls.map(call => call.sessionId), [peer.id]);
      const acceptance = await fetch(`${daemon.endpoint}/local/conversations/${conversation.id}/skill-invocations`, {
        method: "POST", headers: { ...headers, "idempotency-key": "daemon-invocation" },
        body: JSON.stringify({ documentId: skill.id, source: "workspace", revision: 1, arguments: "Task @observer", to: [selected.id] }),
      });
      assert.equal(acceptance.status, 202);
      const receipt = await acceptance.json() as LocalAuthoredSkillInvocationReceipt;
      const publicationUrl = `${daemon.endpoint}/local/conversations/${conversation.id}/skill-invocation-publications`;
      const publication = await fetch(publicationUrl, { method: "POST", headers, body: JSON.stringify({ requestId: receipt.requestId, invocationId: receipt.id }) });
      assert.equal(publication.status, enabled === true ? 200 : 405);
      if (enabled === true) {
        const result = await publication.json() as { status: string; messageId: string };
        assert.equal(result.status, "observed");
        await until(async () => (await client.listMessages(conversation.id)).some(message => message.replyTo === result.messageId));
        const inspection = await fetch(`${publicationUrl}?requestId=${encodeURIComponent(receipt.requestId)}`, { headers });
        assert.equal(inspection.status, 200);
        assert.equal((await inspection.json() as { messageId: string }).messageId, result.messageId);
        assert.deepEqual(calls.slice(baseline).map(call => call.sessionId), [selected.id]);
        assert.match(calls[baseline]!.input, /PRIVATE_DAEMON_PROCEDURE/);
        const trigger = (await client.listMessages(conversation.id)).find(message => message.id === result.messageId)!;
        assert.deepEqual(trigger.to, [selected.id]);
        assert.equal(trigger.authoredInvocationId, receipt.id);
        assert.equal(calls[baseline]!.turnId, `conversation:${conversation.id}:${selected.id}:${trigger.id}`);
      } else {
        assert.equal(publication.headers.get("allow"), "GET");
        assert.equal((await client.listMessages(conversation.id)).some(message => message.authoredInvocationId), false);
        assert.equal(calls.length, baseline);
      }
      await daemon.close(); daemon = undefined;
      assert.equal(calls.length, baseline + (enabled === true ? 1 : 0), "No unselected or duplicate turns after host shutdown");
      store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(databasePath) });
      const after = await store.listWorkspaceBindings(workspace.id);
      assert.deepEqual(after.map(binding => [binding.id, binding.generation, binding.runtimeSessionId]),
        pinnedBefore.map(binding => [binding.id, binding.generation, binding.runtimeSessionId]));
      assert.doesNotMatch(JSON.stringify(await client.listMessages(conversation.id)), /PRIVATE_DAEMON_PROCEDURE/);
    } finally {
      await daemon?.close(); await store?.close(); await core.close(); await rm(directory, { recursive: true, force: true });
    }
  });

  test(`product forwards authored publication startup option ${String(enabled)} without enabling defaults`, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "channels-authored-product-")));
    let app: Awaited<ReturnType<typeof createLocalProductApp>> | undefined;
    try {
      app = await createLocalProductApp({ dataDirectory: directory, conversationsPort: 0, controlPort: 0,
        webUrl: "http://127.0.0.1:5174/", runtimeAdapter: "fixture", runtime: { async status() { return "offline"; } },
        authoredSkillPublicationEnabled: enabled });
      const bootstrap = await fetch(app.issueBrowserLaunchUrl(), { redirect: "manual" });
      assert.equal(bootstrap.status, 303);
      const response = await fetch(`${app.controlEndpoint}/local/capabilities`, {
        headers: { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!, origin: "http://127.0.0.1:5174" },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as LocalControlCapabilities).features.authoredSkillPublication, enabled === true);
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
