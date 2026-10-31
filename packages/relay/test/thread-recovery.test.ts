import assert from "node:assert/strict";
import test from "node:test";
import { ConversationClient, InMemoryConversationStorage, createConversationHttpServer } from "@minu/channels-core";
import { ConversationRuntimeRelay } from "../src/relay.ts";

for (const attachment of ["start", "attach"] as const) {
 for (const delayed of ["cursor", "final metadata"] as const) {
  test(`thread ${attachment} reconciles a delayed ${delayed} against roster revisions before catch-up`, { timeout: 10_000 }, async () => {
    const server = await createConversationHttpServer();
    const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
    const privateCursors = new InMemoryConversationStorage();
    let releaseFloor!: () => void;
    const floorReleased = new Promise<void>((resolve) => { releaseFloor = resolve; });
    let captureFloor!: () => void;
    const floorCaptured = new Promise<void>((resolve) => { captureFloor = resolve; });
    let releaseRoster!: () => void;
    const rosterReleased = new Promise<void>((resolve) => { releaseRoster = resolve; });
    let observeRoster!: () => void;
    const rosterObserved = new Promise<void>((resolve) => { observeRoster = resolve; });
    let relay: ConversationRuntimeRelay | undefined;
    try {
      const human = await client.createIdentity({ type: "human" });
      const agent = await client.createIdentity({ type: "agent" });
      const workspace = await client.createWorkspace({ slug: "revision-recovery", name: "Revision recovery" });
      await client.addWorkspaceMember(workspace.id, { identityId: human.id, mentionHandle: "human", accessRole: "owner" });
      await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
      const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [human.id, agent.id] });
      const root = await client.postMessage(parent.id, { participantId: human.id, body: "Root" });
      const thread = await client.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: root.id });
      const stale = await client.postMessage(thread.id, { participantId: human.id, body: "@agent Retired trigger" });
      const prompts: string[] = [];
      const history: Array<{ role: "assistant"; content: string }> = [];
      const runtime = {
        async status() { return "idle" as const; },
        async send(_id: string, input: string) { prompts.push(input); history.push({ role: "assistant", content: "Fresh answer" }); },
        async messages() { return [...history]; },
      };
      let subscribed = false;
      const originalEvents = client.events.bind(client);
      client.events = (id, options) => {
        const events = originalEvents(id, { ...options, onReady() { subscribed = true; options?.onReady?.(); } });
        return (async function* () {
          for await (const event of events) {
            // Coalesce live roster notifications deliberately: attachment must be
            // safe even when the removal has already been followed by re-addition.
            if (delayed === "cursor" && event.type === "roster.updated") await rosterReleased;
            yield event;
            if (event.type === "roster.updated" && event.rosterRevision === 3) observeRoster();
          }
        })();
      };
      const originalMetadata = client.getConversation.bind(client);
      const originalCursor = client.getCursor.bind(client);
      let reads = 0;
      let capturedMetadata = false;
      client.getConversation = async (id) => {
        const metadata = await originalMetadata(id);
        if (delayed === "final metadata" && reads > 0 && !capturedMetadata) {
          capturedMetadata = true;
          assert.equal(metadata.rosterRevision, 1);
          captureFloor();
          await floorReleased;
        }
        return metadata;
      };
      client.getCursor = async (id, participantId) => {
        assert.equal(subscribed, true, "Retirement reconciliation must follow subscription readiness");
        const floor = await originalCursor(id, participantId);
        if (++reads === 1 && delayed === "cursor") {
          captureFloor();
          await floorReleased;
        }
        return floor;
      };
      const binding = { participantId: agent.id, sessionId: "thread-session", runtime };
      relay = new ConversationRuntimeRelay({ client, conversationId: thread.id, cursorStore: privateCursors,
        bindings: attachment === "start" ? [binding] : [] });
      if (attachment === "attach") await relay.start();
      const initializing = attachment === "start" ? relay.start() : relay.attach(binding);
      await Promise.race([floorCaptured, initializing.then(() => assert.fail("Attachment never read the retirement floor"))]);
      const retirementHead = delayed === "final metadata"
        ? await client.postMessage(thread.id, { participantId: human.id, body: "Message event preceding roster invalidation" }) : stale;
      await client.updateConversationParticipants(parent.id, { actorIdentityId: human.id, participantIds: [human.id], expectedRosterRevision: 1 });
      await client.updateConversationParticipants(parent.id, { actorIdentityId: human.id, participantIds: [human.id, agent.id], expectedRosterRevision: 2 });
      if (delayed === "final metadata") await rosterObserved;
      releaseFloor();
      await initializing;
      await relay.waitForIdle();
      assert.ok(reads >= 2, "A revision change must invalidate and repeat the captured floor read");
      assert.equal(await privateCursors.getCursor(thread.id, agent.id), retirementHead.sequence);
      assert.equal(prompts.length, 0, "Catch-up must not execute the retired trigger");
      assert.equal((await client.listMessages(thread.id)).filter((message) => message.participantId === agent.id).length, 0);
      releaseRoster();
      const fresh = await client.postMessage(thread.id, { participantId: human.id, body: "@agent Fresh trigger" });
      const deadline = Date.now() + 3_000;
      while ((await privateCursors.getCursor(thread.id, agent.id)) < fresh.sequence && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await relay.waitForIdle();
      assert.equal(prompts.length, 1);
      assert.match(prompts[0]!, new RegExp(`Message ${fresh.sequence} .*addressed you`));
      assert.equal((await client.listMessages(thread.id)).filter((message) => message.participantId === agent.id).length, 1);
    } finally {
      releaseFloor(); releaseRoster();
      await relay?.stop(); await server.close();
    }
  });
 }
}

test("coalesced thread removal/re-addition fences an already-running response", { timeout: 10_000 }, async () => {
  const server = await createConversationHttpServer();
  const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
  const cursors = new InMemoryConversationStorage();
  let releaseSend!: () => void;
  const sendReleased = new Promise<void>((resolve) => { releaseSend = resolve; });
  let observeSend!: () => void;
  const sendObserved = new Promise<void>((resolve) => { observeSend = resolve; });
  let releaseMetadata!: () => void;
  const metadataReleased = new Promise<void>((resolve) => { releaseMetadata = resolve; });
  let captureMetadata!: () => void;
  const metadataCaptured = new Promise<void>((resolve) => { captureMetadata = resolve; });
  let relay: ConversationRuntimeRelay | undefined;
  try {
    const human = await client.createIdentity({ type: "human" });
    const agent = await client.createIdentity({ type: "agent" });
    const workspace = await client.createWorkspace({ slug: "coalesced-retirement", name: "Coalesced retirement" });
    await client.addWorkspaceMember(workspace.id, { identityId: human.id, mentionHandle: "human", accessRole: "owner" });
    await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
    const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [human.id, agent.id] });
    const root = await client.postMessage(parent.id, { participantId: human.id, body: "Root" });
    const thread = await client.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: root.id });
    const history: Array<{ role: "assistant"; content: string }> = [];
    let sends = 0;
    const runtime = {
      async status() { return "idle" as const; },
      async send() {
        if (++sends === 1) { observeSend(); await sendReleased; }
        history.push({ role: "assistant", content: `Answer ${sends}` });
      },
      async messages() { return [...history]; },
    };
    let observeReaddition!: () => void;
    const readditionObserved = new Promise<void>((resolve) => { observeReaddition = resolve; });
    const originalEvents = client.events.bind(client);
    client.events = (id, options) => (async function* () {
      for await (const event of originalEvents(id, options)) {
        yield event;
        if (event.type === "roster.updated" && event.rosterRevision === 3) observeReaddition();
      }
    })();
    let holdMetadata = false;
    const originalMetadata = client.getConversation.bind(client);
    client.getConversation = async (id) => {
      const metadata = await originalMetadata(id);
      if (holdMetadata) {
        holdMetadata = false;
        captureMetadata();
        await metadataReleased;
      }
      return metadata;
    };
    relay = new ConversationRuntimeRelay({ client, conversationId: thread.id, cursorStore: cursors,
      bindings: [{ participantId: agent.id, sessionId: "coalesced-session", runtime }] });
    await relay.start();
    const retired = await client.postMessage(thread.id, { participantId: human.id, body: "@agent Start held work" });
    await sendObserved;
    holdMetadata = true;
    await client.updateConversationParticipants(parent.id, { actorIdentityId: human.id, participantIds: [human.id], expectedRosterRevision: 1 });
    await metadataCaptured;
    await client.updateConversationParticipants(parent.id, { actorIdentityId: human.id, participantIds: [human.id, agent.id], expectedRosterRevision: 2 });
    const fresh = await client.postMessage(thread.id, { participantId: human.id, body: "@agent Start fresh work" });
    await readditionObserved;
    releaseMetadata();
    const deadline = Date.now() + 3_000;
    while ((await cursors.getCursor(thread.id, agent.id)) < retired.sequence && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await cursors.getCursor(thread.id, agent.id), retired.sequence);
    releaseSend();
    await relay.waitForIdle();
    const freshDeadline = Date.now() + 3_000;
    while ((await cursors.getCursor(thread.id, agent.id)) < fresh.sequence && Date.now() < freshDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sends, 2);
    assert.deepEqual((await client.listMessages(thread.id)).filter((message) => message.participantId === agent.id).map((message) => message.body), ["Answer 2"],
      "Re-addition must fence the retired reply without discarding newly eligible work");
  } finally {
    releaseMetadata(); releaseSend();
    await relay?.stop(); await server.close();
  }
});
