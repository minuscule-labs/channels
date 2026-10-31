import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationClient, ConversationService, createConversationHttpServer } from "@minu/channels-core";
import { DrizzleLibSqlConversationStorage } from "@minu/channels-storage-drizzle";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { createLocalControlDaemon, type LocalControlDaemon } from "../src/daemon.ts";
import type { ManagedRuntimeStartConfig } from "../src/agent-host.ts";

async function eventually(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

for (const delayed of ["subscription", "cursor", "final metadata"] as const) {
test(`daemon recovery cannot dispatch a retired thread request across a delayed ${delayed}`, { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "thread-attachment-recovery-"));
  const relayPath = join(directory, "relay.db");
  const storage = await DrizzleLibSqlConversationStorage.open({ url: `file:${join(directory, "core.db")}` });
  const core = await createConversationHttpServer({ service: new ConversationService(storage), port: 0 });
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  let daemon: LocalControlDaemon | undefined;
  let starting: Promise<LocalControlDaemon> | undefined;
  const originalFetch = globalThis.fetch;
  let releaseCursor!: () => void;
  const cursorReleased = new Promise<void>((resolve) => { releaseCursor = resolve; });
  let captureCursor!: () => void;
  const cursorCaptured = new Promise<void>((resolve) => { captureCursor = resolve; });
  const inputs: string[] = [];
  const messages: Array<{ role: "assistant"; content: string }> = [];
  let ownerId = "";
  let starts = 0;
  const runtime = {
    async start() { throw new Error("Managed sessions required"); },
    async startManaged(_config: ManagedRuntimeStartConfig, owner: string) {
      starts += 1;
      ownerId = owner;
      return { id: "recovery-session", ownerId };
    },
    async listManagedSessions(owner: string) {
      return [{ id: "recovery-session", ownerId: owner, state: "active" as const }];
    },
    async resume(id: string, owner: string) { return { id, ownerId: owner }; },
    async status() { return "idle" as const; },
    async send(_id: string, input: string) {
      inputs.push(input);
      messages.push({ role: "assistant", content: `Public reply ${inputs.length}` });
    },
    async messages() { return [...messages]; },
  };
  try {
    const human = await client.createIdentity({ type: "human" });
    const agent = await client.createIdentity({ type: "agent" });
    const workspace = await client.createWorkspace({ slug: "attachment-recovery", name: "Attachment recovery" });
    await client.addWorkspaceMember(workspace.id, { identityId: human.id, mentionHandle: "human", accessRole: "owner" });
    await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
    const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [human.id, agent.id] });
    const root = await client.postMessage(parent.id, { participantId: human.id, body: "Thread root" });
    const thread = await client.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: root.id });
    const store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(relayPath) });
    const now = new Date().toISOString();
    await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: directory, createdAt: now, updatedAt: now });
    await store.putAgentConfig({ id: "recovery-config", workspaceId: workspace.id, agentIdentityId: agent.id,
      runtimeAdapter: "controlled", status: "active", createdAt: now, updatedAt: now });
    await store.close();
    const launch = () => createLocalControlDaemon({ relayDatabasePath: relayPath, currentHumanIdentityId: human.id,
      conversationsEndpoint: core.endpoint, conversationsServiceToken: core.serviceToken,
      port: 0, webUrl: "http://127.0.0.1:5174/", runtimes: { controlled: runtime } });
    daemon = await launch();
    const login = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
    const response = await fetch(`${daemon.endpoint}/local/conversations/${thread.id}/agents/${agent.id}/start`, {
      method: "POST", headers: { cookie: login.headers.get("set-cookie")!.split(";", 1)[0]!, origin: "http://127.0.0.1:5174" },
    });
    assert.equal(response.status, 201);
    await response.body?.cancel();
    await daemon.close(); daemon = undefined;
    const stale = await client.postMessage(thread.id, { participantId: human.id, body: "@agent RETIRED_REQUEST" });

    let intercepted = false;
    let floorRead = false;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (delayed === "subscription" && !intercepted && url === `${core.endpoint}/conversations/${thread.id}/events`) {
        intercepted = true;
        captureCursor();
        await cursorReleased;
      }
      const result = await originalFetch(input, init);
      if (url === `${core.endpoint}/conversations/${thread.id}/cursors/${agent.id}`) {
        floorRead = true;
        if (delayed === "cursor" && !intercepted) {
          intercepted = true;
          assert.equal((await result.clone().json() as { sequence: number }).sequence, 0);
          captureCursor();
          await cursorReleased;
        }
      }
      if (delayed === "final metadata" && !intercepted && floorRead && url === `${core.endpoint}/conversations/${thread.id}`) {
        intercepted = true;
        assert.equal((await result.clone().json() as { conversation: { rosterRevision: number } }).conversation.rosterRevision, 1);
        captureCursor();
        await cursorReleased;
      }
      return result;
    };
    starting = launch();
    await Promise.race([cursorCaptured, starting.then(() => assert.fail("Recovery did not reconcile the public cursor"))]);
    await client.updateConversationParticipants(parent.id, { actorIdentityId: human.id, participantIds: [human.id], expectedRosterRevision: 1 });
    await client.updateConversationParticipants(parent.id, { actorIdentityId: human.id, participantIds: [human.id, agent.id], expectedRosterRevision: 2 });
    assert.equal(await storage.getCursor(thread.id, agent.id), stale.sequence);
    releaseCursor();
    daemon = await starting;
    const fresh = await client.postMessage(thread.id, { participantId: human.id, body: "@agent FRESH_REQUEST" });
    await eventually(async () => (await storage.getCursor(thread.id, agent.id)) >= fresh.sequence, "Fresh recovery request did not settle");
    assert.equal(starts, 1, "Recovery must reuse the existing Runtime session");
    assert.equal(inputs.length, 1, "A retired request must never execute, even once");
    assert.match(inputs[0]!, new RegExp(`Message ${fresh.sequence} .*addressed you`));
    assert.equal((await client.listMessages(thread.id)).filter((message) => message.participantId === agent.id).length, 1,
      "A retired request must not publish a public reply");
  } finally {
    releaseCursor();
    if (!daemon && starting) daemon = await starting.catch(() => undefined);
    await daemon?.close();
    globalThis.fetch = originalFetch;
    await core.close(); await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
}
