import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationClient, ConversationService, createConversationHttpServer } from "@minu/channels-core";
import { DrizzleLibSqlConversationStorage } from "@minu/channels-storage-drizzle";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { createLocalControlDaemon } from "../src/daemon.ts";
import type { ManagedRuntimeStartConfig } from "../src/agent-host.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thread-first-send-"));
  const storage = await DrizzleLibSqlConversationStorage.open({ url: `file:${join(directory, "core.db")}` });
  const core = await createConversationHttpServer({ service: new ConversationService(storage), port: 0 });
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const a = await client.createIdentity({ type: "agent", displayName: "Agent A" });
  const b = await client.createIdentity({ type: "agent", displayName: "Agent B" });
  const workspace = await client.createWorkspace({ slug: "first-send", name: "First send" });
  await client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
  for (const [identity, handle] of [[a, "alpha"], [b, "beta"]] as const) {
    await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: handle });
  }
  const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, a.id, b.id] });
  const root = await client.postMessage(parent.id, { participantId: a.id, body: "ROOT_FROM_ALPHA" });
  await client.postMessage(parent.id, { participantId: owner.id, body: "DECISION_BEFORE_CREATION" });
  const thread = await client.createThread(parent.id, { actorIdentityId: owner.id, rootMessageId: root.id });
  await client.postMessage(parent.id, { participantId: owner.id, body: "LATER_PARENT_EXCLUDED" });
  const relayPath = join(directory, "relay.db");
  const store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(relayPath) });
  const now = new Date().toISOString();
  await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: await realpath(directory), createdAt: now, updatedAt: now });
  for (const identity of [a, b]) await store.putAgentConfig({ id: `config-${identity.id}`, workspaceId: workspace.id,
    agentIdentityId: identity.id, runtimeAdapter: "controlled", status: "active", createdAt: now, updatedAt: now });
  await store.close();
  const starts: Array<{ id: string; config: ManagedRuntimeStartConfig }> = [];
  let failedStarts = 0;
  let replyBody = "CONTROLLED_THREAD_ANSWER";
  const calls: Array<{ id: string; input: string }> = [];
  const sessions = new Map<string, { ownerId: string; messages: Array<{ role: "assistant"; content: string }> }>();
  const runtime = {
    async start() { throw new Error("Managed sessions required"); },
    async startManaged(config: ManagedRuntimeStartConfig, ownerId: string) {
      if (failedStarts) { failedStarts--; throw new Error("Controlled startup failure"); }
      const id = `controlled-${starts.length + 1}`;
      starts.push({ id, config }); sessions.set(id, { ownerId, messages: [] }); return { id, ownerId };
    },
    async listManagedSessions(ownerId: string) { return [...sessions].filter(([, s]) => s.ownerId === ownerId).map(([id]) => ({ id, ownerId, state: "active" as const })); },
    async status(id: string) { return sessions.has(id) ? "idle" as const : "offline" as const; },
    async send(id: string, input: string) { calls.push({ id, input }); sessions.get(id)!.messages.push({ role: "assistant", content: replyBody }); },
    async messages(id: string) { return [...sessions.get(id)!.messages]; },
    async destroy(id: string) { sessions.delete(id); },
  };
  const daemon = await createLocalControlDaemon({ conversationsEndpoint: core.endpoint, conversationsServiceToken: core.serviceToken,
    relayDatabasePath: relayPath, currentHumanIdentityId: owner.id, runtimes: { controlled: runtime }, port: 0,
    webUrl: "http://127.0.0.1:5174/", recordAgentDiagnostics: false,
    withConversationMessageAdmission: core.service.withConversationMessageAdmission.bind(core.service),
  });
  const exchange = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
  const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
  async function control(path: string, body: unknown, key?: string, targetConversationId = thread.id) {
    return fetch(`${daemon.endpoint}/local/conversations/${targetConversationId}${path}`, { method: "POST",
      headers: { cookie, origin: "http://127.0.0.1:5174", "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
  }
  return { owner, a, b, thread, parent, client, starts, calls,
    failNextStart: () => { failedStarts++; },
    setReplyBody: (value: string) => { replyBody = value; },
    sendIn: (id: string, body: string, key: string, to?: string[]) => control("/messages", { participantId: owner.id, body, to }, key, id),
    stopIn: (id: string, agent: string) => control(`/agents/${agent}/stop`, {}, undefined, id),
    async answersIn(id: string, triggerId: string, count: number) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const messages = (await client.listMessages(id)).filter(m => m.replyTo === triggerId);
        if (messages.length === count) return messages;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(`Expected ${count} answers for ${triggerId}`);
    },
    send: (body: string, key: string, to?: string[]) => control("/messages", { participantId: owner.id, body, to }, key),
    stop: (id: string) => control(`/agents/${id}/stop`, {}),
    async answered() {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if ((await client.listMessages(thread.id)).some(m => m.body === "CONTROLLED_THREAD_ANSWER")) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("First saved thread message was skipped rather than dispatched");
    },
    async close() { await daemon.close(); await core.close(); await storage.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("first unaddressed thread send starts only the root author, delivers the saved trigger and respects later Stop", async () => {
  const f = await fixture();
  try {
    assert.equal(f.starts.length, 0, "Creation/read does not start any agent");
    const first = await f.send("First follow-up", "first");
    assert.equal(first.status, 201, await first.clone().text());
    const { message } = await first.json();
    assert.deepEqual(message.to, [f.a.id]);
    await f.answered();
    assert.equal(f.starts.length, 1); assert.equal(f.calls.length, 1);
    assert.match(f.starts[0]!.config.appendSystemPrompt!, /ROOT_FROM_ALPHA/);
    assert.match(f.starts[0]!.config.appendSystemPrompt!, /DECISION_BEFORE_CREATION/);
    assert.doesNotMatch(f.starts[0]!.config.appendSystemPrompt!, /LATER_PARENT_EXCLUDED/);
    assert.equal((await f.client.listMessages(f.parent.id)).some(m => m.body === "CONTROLLED_THREAD_ANSWER"), false);
    const retry = await f.send("First follow-up", "first");
    assert.equal(retry.status, 201); assert.equal((await retry.json()).message.id, message.id);
    assert.equal(f.starts.length, 1); assert.equal(f.calls.length, 1);
    assert.equal((await f.stop(f.a.id)).status, 200);
    assert.equal((await f.send("First follow-up", "first")).status, 201);
    assert.equal((await f.send("After explicit Stop", "after-stop")).status, 201);
    assert.equal(f.starts.length, 1); assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("failed startup preserves the first question and same-key retry delivers it without duplication", async () => {
  const f = await fixture();
  try {
    f.failNextStart();
    assert.equal((await f.send("Recover the first question", "startup-retry")).status, 409);
    const saved = await f.client.listMessages(f.thread.id);
    assert.equal(saved.length, 1); assert.equal(saved[0]!.body, "Recover the first question");
    assert.equal(f.starts.length, 0); assert.equal(f.calls.length, 0);
    const retry = await f.send("Recover the first question", "startup-retry");
    assert.equal(retry.status, 201); assert.equal((await retry.json()).message.id, saved[0]!.id);
    await f.answered();
    assert.equal(f.starts.length, 1); assert.equal(f.calls.length, 1);
    assert.equal((await f.client.listMessages(f.thread.id)).filter(m => m.participantId === f.owner.id).length, 1);
  } finally { await f.close(); }
});

test("an explicit first recipient overrides the root, stays stable on followups and concurrent retries launch once", async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all([f.send("@beta First question", "same"), f.send("@beta First question", "same")]);
    for (const response of responses) assert.equal(response.status, 201, await response.clone().text());
    const messages = await Promise.all(responses.map(response => response.json()));
    assert.equal(messages[0].message.id, messages[1].message.id);
    assert.deepEqual(messages[0].message.to, [f.b.id]);
    await f.answered();
    assert.equal(f.starts.length, 1); assert.equal(f.calls.length, 1);
    const next = await f.send("Unaddressed follow-up", "next");
    assert.equal(next.status, 201); assert.deepEqual((await next.json()).message.to, [f.b.id]);
    assert.equal(f.starts.length, 1);
  } finally { await f.close(); }
});

test("main Send activates the displayed recipient, not text references; thread sessions stay separate", async () => {
  const f = await fixture();
  try {
    const response = await f.sendIn(f.parent.id, "@beta is referenced; Alpha is selected", "main-first", [f.a.id]);
    assert.equal(response.status, 201, await response.clone().text());
    const { message } = await response.json();
    assert.deepEqual(message.to, [f.a.id]);
    await f.answersIn(f.parent.id, message.id, 1);
    assert.equal(f.starts.length, 1);
    assert.match(f.calls[0]!.input, /Alpha is selected/);
    const child = await f.sendIn(f.thread.id, "A different thread recipient", "child-first", [f.b.id]);
    assert.equal(child.status, 201);
    const childMessage = (await child.json()).message;
    await f.answersIn(f.thread.id, childMessage.id, 1);
    assert.equal(f.starts.length, 2);
    assert.notEqual(f.calls[0]!.id, f.calls[1]!.id);
    assert.match(f.starts[1]!.config.appendSystemPrompt!, /ROOT_FROM_ALPHA/);
    assert.doesNotMatch(f.starts[1]!.config.appendSystemPrompt!, /LATER_PARENT_EXCLUDED/);
  } finally { await f.close(); }
});

test("empty and broadcast targets start nobody; a later addressed main Send starts once and respects Stop", async () => {
  const f = await fixture();
  try {
    for (const [key, to] of [["none", []], ["broadcast", ["@conversation"]]] as const) {
      const response = await f.sendIn(f.parent.id, "Shared history @alpha", key, [...to]);
      assert.equal(response.status, 201);
    }
    assert.equal(f.starts.length, 0); assert.equal(f.calls.length, 0);
    const sent = await f.sendIn(f.parent.id, "Now explicitly ask Beta", "beta", [f.b.id]);
    const message = (await sent.json()).message;
    await f.answersIn(f.parent.id, message.id, 1);
    assert.equal(f.starts.length, 1); assert.equal(f.calls.length, 1);
    assert.equal((await f.stopIn(f.parent.id, f.b.id)).status, 200);
    assert.equal((await f.sendIn(f.parent.id, "Still stopped", "after-stop", [f.b.id])).status, 201);
    assert.equal(f.starts.length, 1); assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("multiple explicit recipients recover a partial startup failure without duplicate sessions or generated routing", async () => {
  const f = await fixture();
  try {
    f.setReplyBody("@alpha @beta generated text must not route");
    f.failNextStart();
    const send = () => f.sendIn(f.parent.id, "Both agents receive this question", "multi", [f.a.id, f.b.id]);
    assert.equal((await send()).status, 409);
    const saved = (await f.client.listMessages(f.parent.id)).find(m => m.body === "Both agents receive this question")!;
    await f.answersIn(f.parent.id, saved.id, 1);
    assert.equal(f.starts.length, 1);
    const retry = await send();
    assert.equal(retry.status, 201); assert.equal((await retry.json()).message.id, saved.id);
    const answers = await f.answersIn(f.parent.id, saved.id, 2);
    assert.equal(f.starts.length, 2); assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every(call => call.input.includes(saved.body)));
    assert.ok(answers.every(answer => answer.to.length === 0));
    assert.equal((await send()).status, 201);
    assert.equal(f.starts.length, 2); assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test("starting on a later Send preserves earlier addressed questions instead of skipping queued work", async () => {
  const f = await fixture();
  try {
    const queued = await f.client.postMessage(f.parent.id, { participantId: f.owner.id, body: "Earlier saved question", to: [f.a.id] });
    const response = await f.sendIn(f.parent.id, "New triggering question", "later-trigger", [f.a.id]);
    assert.equal(response.status, 201);
    const message = (await response.json()).message;
    await f.answersIn(f.parent.id, queued.id, 1);
    await f.answersIn(f.parent.id, message.id, 1);
    assert.equal(f.starts.length, 1); assert.equal(f.calls.length, 2);
    assert.ok(f.calls.some(call => call.input.includes(queued.body)));
    assert.ok(f.calls.some(call => call.input.includes(message.body)));
  } finally { await f.close(); }
});

test("omitted-target startup retry keeps its original recipient after a later explicit switch", async () => {
  const f = await fixture();
  try {
    f.failNextStart();
    assert.equal((await f.send("Recover original Alpha question", "original-alpha")).status, 409);
    const original = (await f.client.listMessages(f.thread.id))[0]!;
    assert.deepEqual(original.to, [f.a.id]);
    const beta = await f.send("@beta A later explicit choice", "later-beta");
    assert.equal(beta.status, 201);
    await f.answersIn(f.thread.id, (await beta.json()).message.id, 1);
    const retry = await f.send("Recover original Alpha question", "original-alpha");
    assert.equal(retry.status, 201, await retry.clone().text());
    assert.equal((await retry.json()).message.id, original.id);
    await f.answersIn(f.thread.id, original.id, 1);
    assert.equal(f.starts.length, 2); assert.equal(f.calls.length, 2);
    assert.ok(f.calls.some(call => call.input.includes(original.body)));
    assert.equal((await f.client.listMessages(f.thread.id)).filter(m => m.participantId === f.owner.id).length, 2);
  } finally { await f.close(); }
});

test("omitted-target retry cannot acquire a recipient from a later message", async () => {
  const f = await fixture();
  try {
    const first = await f.sendIn(f.parent.id, "Originally no recipient", "original-none");
    assert.equal(first.status, 201);
    const original = (await first.json()).message;
    assert.deepEqual(original.to, []);
    const beta = await f.sendIn(f.parent.id, "@beta A later main choice", "later-main-beta");
    assert.equal(beta.status, 201);
    await f.answersIn(f.parent.id, (await beta.json()).message.id, 1);
    const retry = await f.sendIn(f.parent.id, "Originally no recipient", "original-none");
    assert.equal(retry.status, 201, await retry.clone().text());
    assert.equal((await retry.json()).message.id, original.id);
    assert.equal(f.starts.length, 1); assert.equal(f.calls.length, 1);
    assert.equal((await f.client.listMessages(f.parent.id)).filter(m => m.body === original.body).length, 1);
  } finally { await f.close(); }
});
