import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConversationClient, ConversationClientError } from "../src/client.ts";
import { ConversationValidationError } from "../src/conversation-service.ts";
import { createConversationHttpServer } from "../src/http-server.ts";
import { createResourceId } from "../src/ids.ts";
import type { ConversationEvent, UpdateConversationInput } from "../src/types.ts";

async function fixture(t: TestContext) {
  const server = await createConversationHttpServer();
  t.after(() => server.close());
  const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
  const owner = await client.createIdentity({ type: "human" });
  const workspace = await client.createWorkspace({ slug: "folder-client", name: "Folder client" });
  await client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
  const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id], actorIdentityId: owner.id, name: "Keep this name" });
  return { server, client, owner, workspace, conversation };
}

const status = (expected: number) => (error: unknown) => error instanceof ConversationClientError && error.status === expected;

test("typed folder client round-trips catalogue and assignments and preserves HTTP error statuses", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.listWorkspaceFolders(f.workspace.id), []);
  const folder = await f.client.createWorkspaceFolder(f.workspace.id, { actorIdentityId: f.owner.id, name: " Roadmap " });
  assert.equal(folder.name, "Roadmap");
  const renamed = await f.client.updateWorkspaceFolder(f.workspace.id, folder.id, { actorIdentityId: f.owner.id, name: " Delivery " });
  assert.equal(renamed.id, folder.id);
  assert.equal(renamed.name, "Delivery");
  assert.deepEqual(await f.client.listWorkspaceFolders(f.workspace.id), [renamed]);
  const created = await f.client.createConversation({ workspaceId: f.workspace.id, participantIds: [f.owner.id], actorIdentityId: f.owner.id, folderId: folder.id });
  assert.equal(created.folderId, folder.id);
  for (const folderId of [folder.id, null]) {
    const assigned = await f.client.assignConversationFolder(f.conversation.id, { actorIdentityId: f.owner.id, folderId });
    assert.equal(assigned.folderId, folderId);
    assert.equal((await f.client.getConversation(f.conversation.id)).folderId, folderId);
  }
  await assert.rejects(f.client.createWorkspaceFolder(f.workspace.id, { actorIdentityId: f.owner.id, name: " delivery " }), status(409));
  await assert.rejects(f.client.assignConversationFolder(f.conversation.id, { actorIdentityId: f.owner.id, folderId: createResourceId("folder") }), status(404));
  for (const name of ["\u0000Delivery", "Delivery\u0000another"]) {
    await assert.rejects(f.client.createWorkspaceFolder(f.workspace.id, { actorIdentityId: f.owner.id, name }), status(400));
    await assert.rejects(f.client.updateWorkspaceFolder(f.workspace.id, folder.id, { actorIdentityId: f.owner.id, name }), status(400));
  }
  assert.deepEqual(await f.client.listWorkspaceFolders(f.workspace.id), [renamed]);
  assert.equal((await f.client.getConversation(f.conversation.id)).folderId, null);
});

test("typed folder assignment delivers a committed conversation.updated event over HTTP SSE", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  const folder = await f.client.createWorkspaceFolder(f.workspace.id, { actorIdentityId: f.owner.id, name: "Delivery" });
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const received = (async () => {
    for await (const event of f.client.events(f.conversation.id, { signal: controller.signal, onReady: ready })) return event;
    throw new Error("SSE stream ended before the folder update");
  })();
  try {
    await started;
    const assigned = await f.client.assignConversationFolder(f.conversation.id, { actorIdentityId: f.owner.id, folderId: folder.id });
    const event = await received;
    assert.equal(event.type, "conversation.updated");
    assert.equal(event.conversationId, f.conversation.id);
    assert.equal(assigned.folderId, folder.id);
    assert.equal((await f.client.getConversation(f.conversation.id)).folderId, folder.id);
    assert.deepEqual(await f.client.listMessages(f.conversation.id), []);
  } finally {
    controller.abort();
    await received.catch(() => undefined);
  }
});

test("concurrent repeated HTTP folder assignments emit one committed update", async (t) => {
  const f = await fixture(t);
  const folder = await f.client.createWorkspaceFolder(f.workspace.id, { actorIdentityId: f.owner.id, name: "Delivery" });
  const events: ConversationEvent[] = [];
  const unsubscribe = await f.server.service.subscribe(f.conversation.id, event => { events.push(event); });
  t.after(unsubscribe);
  const results = await Promise.all([
    f.client.assignConversationFolder(f.conversation.id, { actorIdentityId: f.owner.id, folderId: folder.id }),
    f.client.assignConversationFolder(f.conversation.id, { actorIdentityId: f.owner.id, folderId: folder.id }),
  ]);
  assert.deepEqual(results.map(result => result.folderId), [folder.id, folder.id]);
  assert.deepEqual(events.map(event => event.type), ["conversation.updated"]);
});

test("the existing required-name Conversation update contract cannot silently file or unfile a Conversation", async (t) => {
  const f = await fixture(t);
  const folder = await f.client.createWorkspaceFolder(f.workspace.id, { actorIdentityId: f.owner.id, name: "Delivery" });
  await f.client.assignConversationFolder(f.conversation.id, { actorIdentityId: f.owner.id, folderId: folder.id });
  const before = await f.client.getConversation(f.conversation.id);
  await assert.rejects(f.client.updateConversation(f.conversation.id, { actorIdentityId: f.owner.id } as UpdateConversationInput), status(400));
  assert.deepEqual(await f.client.getConversation(f.conversation.id), before);
  const extra = { actorIdentityId: f.owner.id, name: "Renamed Conversation", folderId: null };
  const renamed = await f.client.updateConversation(f.conversation.id, extra);
  assert.equal(renamed.name, "Renamed Conversation");
  assert.equal(renamed.folderId, folder.id);
});

test("filed creation requires an explicit administrator and rejects legacy filing before provisioning side effects", async (t) => {
  const f = await fixture(t);
  const folder = await f.client.createWorkspaceFolder(f.workspace.id, { actorIdentityId: f.owner.id, name: "Delivery" });
  const before = {
    conversations: await f.client.listWorkspaceConversations(f.workspace.id),
    identities: await f.client.listIdentities(), workspaces: await f.client.listWorkspaces(),
  };
  await assert.rejects(f.client.createConversation({ workspaceId: f.workspace.id, participantIds: [f.owner.id], folderId: folder.id }), status(400));
  await assert.rejects(f.server.service.createConversation({ participants: [{ id: "unwanted-legacy-human", type: "human" }], actorIdentityId: f.owner.id, folderId: folder.id }), ConversationValidationError);
  assert.deepEqual(await f.client.listWorkspaceConversations(f.workspace.id), before.conversations);
  assert.deepEqual(await f.client.listIdentities(), before.identities);
  assert.deepEqual(await f.client.listWorkspaces(), before.workspaces);
});

test("Workspace-scoped filed creation binds to its path and both creation routes reject non-object JSON bodies", async (t) => {
  const f = await fixture(t);
  const folder = await f.client.createWorkspaceFolder(f.workspace.id, { actorIdentityId: f.owner.id, name: "Delivery" });
  const scoped = `/workspaces/${f.workspace.id}/conversations`;
  const headers = { authorization: `Bearer ${f.server.serviceToken}`, "content-type": "application/json" };
  const response = await fetch(`${f.server.endpoint}${scoped}`, {
    method: "POST", headers,
    body: JSON.stringify({ workspaceId: createResourceId("workspace"), actorIdentityId: f.owner.id, participantIds: [f.owner.id], folderId: folder.id }),
  });
  assert.equal(response.status, 201);
  const { conversation } = await response.json() as { conversation: { workspaceId: string; folderId: string } };
  assert.equal(conversation.workspaceId, f.workspace.id);
  assert.equal(conversation.folderId, folder.id);
  const before = await f.client.listWorkspaceConversations(f.workspace.id);
  for (const path of ["/conversations", scoped]) {
    for (const body of [null, [], 42, "not-an-object"]) {
      const rejected = await fetch(`${f.server.endpoint}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      assert.equal(rejected.status, 400);
      assert.equal(typeof (await rejected.json() as { error: string }).error, "string");
    }
  }
  assert.deepEqual(await f.client.listWorkspaceConversations(f.workspace.id), before);
});
