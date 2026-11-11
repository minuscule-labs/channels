import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationClient, ConversationService, createConversationHttpServer } from "@minu/channels-core";
import { DrizzleLibSqlConversationStorage } from "@minu/channels-storage-drizzle";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { captureAuthoredContext, ConversationRuntimeRelay, restoreConversationBindings,
  type AgentRuntimePort, type RuntimePortTurn } from "@minu/channels-relay";
import { LocalAgentHostConfiguration } from "../src/configuration.ts";
import { LocalControlBrowserSessions, LocalControlService, createLocalControlHttpServer } from "../src/server.ts";
import type { LocalAuthoredSkillInvocationReceipt, LocalAuthoredSkillInvocationPublicationReceipt } from "../src/contracts.ts";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Thread authored invocation condition timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("HTTP inherited channel skill runs only in the selected thread session with live parent and all_messages observer", { timeout: 20_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "channels-authored-thread-")));
  let coreStorage!: DrizzleLibSqlConversationStorage;
  let core!: Awaited<ReturnType<typeof createConversationHttpServer>>;
  let store!: DrizzleLibSqlRelayStorage;
  let control: Awaited<ReturnType<typeof createLocalControlHttpServer>> | undefined;
  const relays: ConversationRuntimeRelay[] = [];
  const restored: Awaited<ReturnType<typeof restoreConversationBindings>>[] = [];
  try {
    coreStorage = await DrizzleLibSqlConversationStorage.open({ url: `file:${join(directory, "core.db")}` });
    core = await createConversationHttpServer({ service: new ConversationService(coreStorage), port: 0 });
    const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
    store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(directory, "relay.db")) });
    const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
    const member = await client.createIdentity({ type: "human", displayName: "Invoker" });
    const selected = await client.createIdentity({ type: "agent", displayName: "Selected" });
    const peer = await client.createIdentity({ type: "agent", displayName: "Observer" });
    const workspace = await client.createWorkspace({ slug: "authored-thread", name: "Authored thread" });
    for (const [identity, accessRole] of [[owner, "owner"], [member, "member"], [selected, "member"], [peer, "member"]] as const) {
      await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: identity.displayName!.toLowerCase(), accessRole });
    }
    const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, member.id, selected.id, peer.id] });
    const root = await client.postMessage(parent.id, { participantId: member.id, body: "Thread root", to: [] });
    const thread = await client.createThread(parent.id, { actorIdentityId: member.id, rootMessageId: root.id });
    const now = new Date().toISOString();
    await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: directory, createdAt: now, updatedAt: now });
    for (const identity of [selected, peer]) await store.putAgentConfig({ id: `config-${identity.id}`, workspaceId: workspace.id,
      agentIdentityId: identity.id, runtimeAdapter: "fixture", status: "active", createdAt: now, updatedAt: now });
    const configuration = new LocalAgentHostConfiguration({ client, store });
    const skill = await configuration.createAuthoredDocument(workspace.id, owner.id, { conversationId: parent.id,
      kind: "skill", name: "Decision note", description: "Inherited channel procedure", content: "PRIVATE_CHANNEL_PROCEDURE_V1" });
    await configuration.updateAuthoredDocument(workspace.id, skill.id, owner.id, { action: "publish", expectedVersion: 1 });
    const decoy = await configuration.createAuthoredDocument(workspace.id, owner.id, {
      kind: "skill", name: "Decision note", description: "Same-name workspace decoy", content: "PRIVATE_WORKSPACE_DECOY" });
    await configuration.updateAuthoredDocument(workspace.id, decoy.id, owner.id, { action: "publish", expectedVersion: 1 });
    const manifest = await captureAuthoredContext(store, workspace.id, parent.id);
    assert.equal(manifest.channelId, parent.id);
    assert.ok(manifest.documents.some(ref => ref.documentId === skill.id && ref.source === "channel" && ref.revision === 1));
    const seeds = [
      { id: "parent-selected", scope: parent.id, identityId: selected.id, wakePolicy: "mentions" as const },
      { id: "thread-selected", scope: thread.id, identityId: selected.id, wakePolicy: "mentions" as const },
      { id: "thread-observer", scope: thread.id, identityId: peer.id, wakePolicy: "all_messages" as const },
    ];
    const sessions = new Map(seeds.map(seed => [
      `PRIVATE_SESSION_${seed.id}`, { ownerId: `PRIVATE_OWNER_${seed.id}` },
    ]));
    for (const seed of seeds) await store.putBinding({ id: seed.id, workspaceAgentConfigId: `config-${seed.identityId}`,
      workspaceId: workspace.id, conversationId: seed.scope, agentIdentityId: seed.identityId, runtimeAdapter: "fixture",
      runtimeSessionId: `PRIVATE_SESSION_${seed.id}`, runtimeOwnerId: `PRIVATE_OWNER_${seed.id}`, generation: 1,
      state: "connected", wakePolicy: seed.wakePolicy, createdAt: now, updatedAt: now }, { authoredContext: manifest });
    const calls: Array<{ sessionId: string; turnId: string; input: string }> = [];
    const turns = new Map<string, { sessionId: string; turn: RuntimePortTurn }>();
    let legacySends = 0;
    let newSessions = 0;
    let interrupts = 0;
    const runtime: AgentRuntimePort & { startManaged(): Promise<never> } = {
      async startManaged(): Promise<never> { newSessions += 1; throw new Error("Session replacement is forbidden"); },
      async status(id) { assert.ok(sessions.has(id)); return "idle"; },
      async getManagedSession(id, ownerId) { return sessions.get(id)?.ownerId === ownerId ? { id, ownerId, state: "active" } : undefined; },
      async resume(id, ownerId) { assert.equal(sessions.get(id)?.ownerId, ownerId); return { id, ownerId }; },
      async messages() { return [{ role: "assistant", content: "PRIVATE_RUNTIME_TRANSCRIPT" }]; },
      async send() { legacySends += 1; throw new Error("No legacy send"); },
      async interrupt() { interrupts += 1; },
      async turn(sessionId, turnId) {
        const existing = turns.get(turnId);
        if (existing) assert.equal(existing.sessionId, sessionId);
        return existing?.turn;
      },
      async startTurn(sessionId, turnId, input) {
        calls.push({ sessionId, turnId, input });
        assert.ok(sessions.has(sessionId));
        assert.equal(turns.has(turnId), false, "No duplicate Runtime start");
        const timestamp = new Date().toISOString();
        const turn: RuntimePortTurn = { id: turnId, input, status: "completed", createdAt: timestamp, updatedAt: timestamp,
          response: { role: "assistant", content: input.includes("PRIVATE_CHANNEL_PROCEDURE_V1") ? "Thread decision captured" : "Liveness control complete" } };
        turns.set(turnId, { sessionId, turn });
        return turn;
      },
    };
    for (const scope of [parent.id, thread.id]) {
      const bindingSet = await restoreConversationBindings({ client, store, conversationId: scope,
        leaseOwner: `thread-test:${scope}`, runtimes: { fixture: runtime } });
      restored.push(bindingSet);
      assert.equal(bindingSet.bindings.length, scope === parent.id ? 1 : 2);
      assert.ok(bindingSet.bindings.every(binding => binding.prepareAuthoredTurn && binding.verifyLease));
      const relay = new ConversationRuntimeRelay({ client, conversationId: scope, bindings: bindingSet.bindings, cursorStore: store, turnPollIntervalMs: 5 });
      relays.push(relay);
      await relay.start();
    }
    assert.equal(restored[1]!.bindings.find(binding => binding.participantId === peer.id)?.wakePolicy, "all_messages");
    const settle = async () => {
      await until(async () => {
        for (const [index, scope] of [parent.id, thread.id].entries()) {
          const head = (await client.listMessages(scope)).at(-1)?.sequence ?? 0;
          for (const binding of restored[index]!.bindings) relays[index]!.observeConversationHead(binding.participantId, head);
        }
        return relays.every(relay => {
          const work = relay.workSnapshot();
          return work.activeTurns === 0 && work.queuedTurns === 0 && work.queuedTurnsExact;
        });
      });
      await Promise.all(relays.map(relay => relay.waitForIdle()));
    };
    // Positive controls prove both scopes are live and the unaddressed all_messages peer can really run.
    const parentControl = await client.postMessage(parent.id, { participantId: member.id, body: "PARENT_LIVENESS_CONTROL", to: [selected.id] });
    await until(async () => (await store.getCursor(parent.id, selected.id)) >= parentControl.sequence);
    const peerControl = await client.postMessage(thread.id, { participantId: member.id, body: "OBSERVER_ELIGIBILITY_CONTROL", to: [] });
    await until(async () => (await store.getCursor(thread.id, peer.id)) >= peerControl.sequence);
    await settle();
    assert.deepEqual(calls.map(call => call.sessionId), ["PRIVATE_SESSION_parent-selected", "PRIVATE_SESSION_thread-observer"]);
    assert.ok(calls.every(call => !call.input.includes("PRIVATE_CHANNEL_PROCEDURE") && !call.input.includes("PRIVATE_WORKSPACE_DECOY")));
    const baselineCalls = calls.length;
    const parentMessagesBefore = await client.listMessages(parent.id);
    const parentCursor = await store.getCursor(parent.id, selected.id);
    const peerCursor = await store.getCursor(thread.id, peer.id);
    const identities = async () => Promise.all(seeds.map(async seed => {
      const binding = (await store.getBinding(seed.id))!;
      const { activation } = await store.getSessionInspectionRecords(workspace.id, seed.scope, seed.identityId);
      assert.ok(activation?.authoredContext);
      return { id: binding.id, generation: binding.generation, sessionId: binding.runtimeSessionId,
        ownerId: binding.runtimeOwnerId, context: activation.authoredContext };
    }));
    const before = await identities();
    const serviceOptions = { conversations: client, bindings: store, runtimes: { fixture: runtime }, configuration };
    assert.equal(new LocalControlService(serviceOptions).authoredSkillPublicationEnabled, false);
    // Opt in only this disposable HTTP fixture; no daemon/production gate or composer wiring changes.
    const service = new LocalControlService({ ...serviceOptions, authoredSkillPublicationEnabled: true });
    const browser = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174/", currentHumanIdentityId: member.id });
    control = await createLocalControlHttpServer({ service, browserSessions: browser, allowedOrigins: [browser.browserOrigin], port: 0 });
    const bootstrap = await fetch(browser.issueLaunchUrl(control.endpoint), { redirect: "manual" });
    assert.equal(bootstrap.status, 303);
    const headers = { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!, origin: browser.browserOrigin, "content-type": "application/json" };
    const requestId = "thread-inherited-skill";
    const argumentsText = "THREAD_ARGUMENTS: @observer @channel are task text";
    const acceptance = await fetch(`${control.endpoint}/local/conversations/${thread.id}/skill-invocations`, {
      method: "POST", headers: { ...headers, "idempotency-key": requestId }, body: JSON.stringify({
        documentId: skill.id, source: "channel", revision: 1, arguments: argumentsText, to: [selected.id],
      }),
    });
    assert.equal(acceptance.status, 202);
    const receipt = await acceptance.json() as LocalAuthoredSkillInvocationReceipt;
    const operation = (await store.getAuthoredSkillInvocation(thread.id, member.id, requestId))!;
    assert.equal(operation.id, receipt.id);
    assert.equal(operation.conversationId, thread.id);
    assert.equal(operation.channelId, parent.id);
    assert.equal(operation.documentId, skill.id);
    assert.equal(operation.source, "channel");
    assert.equal(operation.revision, 1);
    assert.equal(operation.arguments, argumentsText);
    assert.deepEqual(operation.targets.map(target => [target.identityId, target.bindingId, target.generation]),
      [[selected.id, "thread-selected", 1]]);
    assert.equal(operation.contentHash, manifest.documents.find(ref => ref.documentId === skill.id)!.contentHash);
    await configuration.updateAuthoredDocument(workspace.id, skill.id, owner.id, { action: "save", expectedVersion: 2,
      name: "Renamed V2", description: "New publication", content: "PRIVATE_CHANNEL_PROCEDURE_V2" });
    await configuration.updateAuthoredDocument(workspace.id, skill.id, owner.id, { action: "publish", expectedVersion: 3 });
    const publication = await fetch(`${control.endpoint}/local/conversations/${thread.id}/skill-invocation-publications`, {
      method: "POST", headers, body: JSON.stringify({ requestId: receipt.requestId, invocationId: receipt.id }),
    });
    assert.equal(publication.status, 200);
    const published = await publication.json() as LocalAuthoredSkillInvocationPublicationReceipt;
    assert.equal(published.status, "observed");
    const link = await store.getAuthoredInvocationMessageLink(receipt.id);
    assert.deepEqual(link, { invocationId: receipt.id, messageId: published.messageId });
    const trigger = (await client.listMessages(thread.id)).find(message => message.id === published.messageId)!;
    assert.equal(trigger.authoredInvocationId, receipt.id);
    assert.equal(trigger.participantId, member.id);
    assert.equal(trigger.body, argumentsText);
    assert.deepEqual(trigger.to, [selected.id]);
    await until(async () => (await store.getCursor(thread.id, selected.id)) >= trigger.sequence
      && (await client.listMessages(thread.id)).some(message => message.replyTo === trigger.id));
    await settle();
    const measured = calls.slice(baselineCalls);
    assert.equal(measured.length, 1);
    assert.equal(measured[0]!.sessionId, "PRIVATE_SESSION_thread-selected");
    assert.equal(measured[0]!.turnId, `conversation:${thread.id}:${selected.id}:${trigger.id}`);
    assert.match(measured[0]!.input, /Playbook: Decision note \(channel, revision 1\)/);
    assert.match(measured[0]!.input, /Procedure:\nPRIVATE_CHANNEL_PROCEDURE_V1/);
    assert.ok(measured[0]!.input.includes(`User arguments:\n${argumentsText}`));
    assert.doesNotMatch(measured[0]!.input, /PRIVATE_WORKSPACE_DECOY|PRIVATE_CHANNEL_PROCEDURE_V2/);
    assert.equal(measured.filter(call => call.sessionId === "PRIVATE_SESSION_parent-selected").length, 0);
    assert.equal(measured.filter(call => call.sessionId === "PRIVATE_SESSION_thread-observer").length, 0);
    assert.equal(legacySends, 0);
    assert.equal(newSessions, 0);
    assert.equal(interrupts, 0);
    assert.equal(sessions.size, 3);
    assert.deepEqual(await identities(), before);
    assert.deepEqual(await store.getAuthoredSkillInvocation(thread.id, member.id, requestId), operation);
    assert.deepEqual(await store.getAuthoredInvocationMessageLink(receipt.id), link);
    assert.equal(await store.getCursor(parent.id, selected.id), parentCursor);
    assert.equal(await store.getCursor(thread.id, peer.id), peerCursor);
    assert.deepEqual(await client.listMessages(parent.id), parentMessagesBefore);
    const threadMessages = await client.listMessages(thread.id);
    assert.deepEqual(threadMessages.find(message => message.id === trigger.id), trigger);
    assert.equal(threadMessages.filter(message => message.replyTo === trigger.id).length, 1);
    assert.equal(threadMessages.find(message => message.replyTo === trigger.id)?.body, "Thread decision captured");
    assert.doesNotMatch(JSON.stringify([parentMessagesBefore, threadMessages, await client.getConversation(parent.id), await client.getConversation(thread.id)]),
      /PRIVATE_CHANNEL_PROCEDURE|PRIVATE_WORKSPACE_DECOY|PRIVATE_RUNTIME_TRANSCRIPT|PRIVATE_SESSION_|PRIVATE_OWNER_/);
    assert.ok(relays.every(relay => relay.workSnapshot().activeTurns === 0 && relay.workSnapshot().queuedTurns === 0 && relay.workSnapshot().queuedTurnsExact));
    console.log("G1: authenticated thread invocation selected=1, parent=0, all_messages peer=0 after settled queues; both excluded sessions proved live by ordinary controls; original V1/IDs/sessions/cursors/privacy retained");
  } finally {
    await control?.close();
    await Promise.all(relays.map(relay => relay.stop()));
    await Promise.all(restored.map(bindingSet => bindingSet.close()));
    await store?.close();
    await core?.close();
    await coreStorage?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
