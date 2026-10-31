import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationClient, ConversationService, InMemoryConversationStorage, createConversationHttpServer, type ConversationStorage } from "@minu/channels-core";
import { DrizzleLibSqlConversationStorage } from "@minu/channels-storage-drizzle";
import { ConversationRuntimeRelay } from "@minu/channels-relay";

for (const kind of ["memory", "libsql"] as const) {
  test(`parent removal retires every thread cursor before no-subscriber recovery (${kind})`, { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "thread-cursor-recovery-"));
    const url = `file:${join(directory, "collaboration.db")}`;
    let storage: ConversationStorage = kind === "memory" ? new InMemoryConversationStorage()
      : await DrizzleLibSqlConversationStorage.open({ url });
    let server = await createConversationHttpServer({ service: new ConversationService(storage) });
    let client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
    const relays: ConversationRuntimeRelay[] = [];
    try {
      const human = await client.createIdentity({ type: "human" });
      const agent = await client.createIdentity({ type: "agent" });
      const workspace = await client.createWorkspace({ slug: "cursor-recovery", name: "Cursor recovery" });
      await client.addWorkspaceMember(workspace.id, { identityId: human.id, mentionHandle: "human", accessRole: "owner" });
      await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
      const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [human.id, agent.id] });
      const first = await client.postMessage(parent.id, { participantId: human.id, body: "First root" });
      const second = await client.postMessage(parent.id, { participantId: human.id, body: "Second root" });
      const a = await client.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: first.id });
      const b = await client.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: second.id });
      const staleMain = await client.postMessage(parent.id, { participantId: human.id, body: "@agent Obsolete main request" });
      await client.postMessage(a.id, { participantId: human.id, body: "@agent Obsolete A request one" });
      const staleA = await client.postMessage(a.id, { participantId: human.id, body: "@agent Obsolete A request two" });
      const staleB = await client.postMessage(b.id, { participantId: human.id, body: "@agent Obsolete B request" });
      // Deliberately no Relay/listener exists during removal and re-addition.
      await client.updateConversationParticipants(parent.id, { actorIdentityId: human.id, participantIds: [human.id], expectedRosterRevision: 1 });
      await client.updateConversationParticipants(parent.id, { actorIdentityId: human.id, participantIds: [human.id, agent.id], expectedRosterRevision: 2 });
      if (kind === "libsql") {
        await server.close(); await storage.close?.();
        storage = await DrizzleLibSqlConversationStorage.open({ url });
        server = await createConversationHttpServer({ service: new ConversationService(storage) });
        client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
      }
      for (const [scope, head] of [[parent.id, staleMain.sequence], [a.id, staleA.sequence], [b.id, staleB.sequence]] as const) {
        assert.equal(await storage.getCursor(scope, agent.id), head, `Removal must retire ${scope} through its own head`);
      }
      const histories = new Map<string, Array<{ role: "assistant"; content: string }>>();
      const sends: string[] = [];
      const runtime = {
        async status() { return "idle" as const; },
        async send(sessionId: string) {
          sends.push(sessionId);
          histories.set(sessionId, [...(histories.get(sessionId) ?? []), { role: "assistant", content: "Public recovery reply" }]);
        },
        async messages(sessionId: string) { return [...(histories.get(sessionId) ?? [])]; },
      };
      for (const scope of [parent.id, a.id, b.id]) {
        const relay = new ConversationRuntimeRelay({ client, conversationId: scope, cursorStore: storage,
          bindings: [{ participantId: agent.id, sessionId: scope, runtime }] });
        relays.push(relay);
        await relay.start();
      }
      for (const scope of [parent.id, a.id, b.id]) {
        const fresh = await client.postMessage(scope, { participantId: human.id, body: "@agent New request after recovery" });
        const deadline = Date.now() + 3_000;
        while ((await storage.getCursor(scope, agent.id)) < fresh.sequence && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok((await storage.getCursor(scope, agent.id)) >= fresh.sequence);
        assert.equal((await client.listMessages(scope)).filter((message) => message.participantId === agent.id).length, 1,
          "Only the fresh request may dispatch; stale requests stay history, not queued work");
      }
      assert.equal(sends.length, 3);
      assert.deepEqual(new Set(sends), new Set([parent.id, a.id, b.id]));
    } finally {
      await Promise.all(relays.map((relay) => relay.stop()));
      await server.close(); await storage.close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
