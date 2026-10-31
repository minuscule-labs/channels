import assert from "node:assert/strict";
import test from "node:test";
import { ConversationClient, ConversationClientError, InMemoryConversationStorage, createConversationHttpServer } from "@minu/channels-core";
import { ConversationRuntimeRelay, type AgentRuntimePort, type RuntimePortMessage, type RuntimePortTurn } from "../src/relay.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

for (const adapter of ["recoverable", "legacy"] as const) {
  for (const timing of ["before dispatch", "before delivery"] as const) {
    test(`thread cancellation ${timing} survives reconciliation readiness (${adapter})`, { timeout: 10_000 }, async () => {
      const server = await createConversationHttpServer();
      const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
      const cursors = new InMemoryConversationStorage();
      const held = deferred(), release = deferred(), failedCursor = deferred();
      let relay: ConversationRuntimeRelay | undefined;
      let holdOnce = true, executions = 0, interrupts = 0;
      const history: RuntimePortMessage[] = [];
      const turns = new Map<string, RuntimePortTurn>();
      const pause = async () => {
        if (!holdOnce) return;
        holdOnce = false;
        held.resolve();
        await release.promise;
      };
      const runtime: AgentRuntimePort = {
        async status() {
          if (adapter === "recoverable" && timing === "before dispatch") await pause();
          return "idle";
        },
        async send() {
          assert.equal(adapter, "legacy");
          history.push({ role: "assistant", content: `Successful result ${++executions}` });
          if (timing === "before delivery") await pause();
        },
        async messages() {
          if (adapter === "legacy" && timing === "before dispatch") await pause();
          return [...history];
        },
        async interrupt() { interrupts += 1; },
        ...(adapter === "recoverable" ? {
          async startTurn(_sessionId: string, id: string, input: string) {
            const timestamp = new Date().toISOString();
            const turn: RuntimePortTurn = { id, input, status: "completed", createdAt: timestamp, updatedAt: timestamp,
              response: { role: "assistant", content: `Successful result ${++executions}` } };
            turns.set(id, turn);
            if (timing === "before delivery") await pause();
            return turn;
          },
          async turn(_sessionId: string, id: string) { return turns.get(id); },
        } : {}),
      };
      try {
        const human = await client.createIdentity({ type: "human" });
        const agent = await client.createIdentity({ type: "agent" });
        const writer = await client.createIdentity({ type: "human" });
        const workspace = await client.createWorkspace({ slug: "readiness-cancellation", name: "Readiness cancellation" });
        for (const [identity, handle] of [[human, "human"], [agent, "agent"], [writer, "writer"]] as const) {
          await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: handle,
            ...(identity === human ? { accessRole: "owner" as const } : {}) });
        }
        const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [human.id, agent.id] });
        const root = await client.postMessage(parent.id, { participantId: human.id, body: "Root" });
        const thread = await client.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: root.id });
        const retries: Array<() => void> = [];
        relay = new ConversationRuntimeRelay({ client, conversationId: thread.id, cursorStore: cursors,
          bindings: [{ participantId: agent.id, sessionId: "cancellation-session", runtime }],
          scheduleCatchUpRetryTimer(callback) { retries.push(callback); return { cancel() {} }; } });
        await relay.start();
        const original = await client.postMessage(thread.id, { participantId: human.id, body: "@agent Original request" });
        await held.promise;
        const originalCursor = client.getCursor.bind(client);
        let failOnce = true;
        client.getCursor = async (id, participantId) => {
          if (failOnce) {
            failOnce = false;
            failedCursor.resolve();
            throw new ConversationClientError("Temporary reconciliation failure", 503);
          }
          return originalCursor(id, participantId);
        };
        await client.updateConversationParticipants(parent.id, { actorIdentityId: human.id,
          participantIds: [human.id, agent.id, writer.id], expectedRosterRevision: 1 });
        await failedCursor.promise;
        await eventually(() => retries.length === 1, "Readiness did not enter reconciliation backoff");
        release.resolve();
        // The remaining adapter operations and empty image preparation are local
        // promises. Flush them so cancellation lands at the readiness wait, not
        // at an earlier cancellation check that was already covered.
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(executions, timing === "before dispatch" ? 0 : 1);
        await relay.cancelCurrent(agent.id, human.id);
        await relay.cancelCurrent(agent.id, human.id);
        assert.equal(interrupts, timing === "before dispatch" ? 0 : 1, "Duplicate cancellation must not issue another interrupt");
        const queued = await client.postMessage(thread.id, { participantId: human.id, body: "@agent Queued follow-up" });
        assert.equal((await client.listMessages(thread.id)).filter((message) => message.participantId === agent.id).length, 0,
          "Neither original nor cancellation outcome may bypass pending retirement reconciliation");
        retries[0]!();
        await eventually(async () => (await cursors.getCursor(thread.id, agent.id)) >= queued.sequence, "Later queued request did not complete");
        await relay.waitForIdle();
        const replies = (await client.listMessages(thread.id)).filter((message) => message.participantId === agent.id);
        assert.equal(replies.length, 2, "Exactly one outcome per original/follow-up request");
        assert.equal(replies[0]!.body, "Current request was canceled by @human.", "A canceled request must not publish its original answer");
        const expectedExecutions = timing === "before dispatch" ? 1 : 2;
        assert.equal(executions, expectedExecutions, "No canceled pre-dispatch request or duplicate work may execute");
        assert.equal(replies[1]!.body, `Successful result ${expectedExecutions}`);
        assert.equal(interrupts, timing === "before dispatch" ? 0 : 1);
        assert.ok((await cursors.getCursor(thread.id, agent.id)) >= original.sequence);
        assert.equal(relay.workSnapshot().activeTurns, 0);
      } finally {
        release.resolve();
        await relay?.stop(); await server.close();
      }
    });
  }
}
