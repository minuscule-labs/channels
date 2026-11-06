import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ConversationClient, createConversationHttpServer, type ConversationMetadata } from "@minu/channels-core";
import { createLocalWebServer } from "../src/local-web-server.ts";

// Acceptance 3: exercise the real authenticated product gateway and core HTTP
// server together. Cookie signing already has separate control tests; only the
// session lookup is controlled here. No Runtime or production data is used.
interface Folder { id: string; workspaceId: string; name: string }
type FiledMetadata = ConversationMetadata & { folderId: string | null };

async function fixture(t: TestContext) {
  const backend = await createConversationHttpServer();
  t.after(() => backend.close());
  const client = new ConversationClient(backend.endpoint, { serviceToken: backend.serviceToken });
  const owner = await client.createIdentity({ type: "human" });
  const member = await client.createIdentity({ type: "human" });
  const workspace = await client.createWorkspace({ slug: "folder-gateway", name: "Folder gateway" });
  await client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
  await client.addWorkspaceMember(workspace.id, { identityId: member.id, mentionHandle: "member" });
  const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, member.id], actorIdentityId: owner.id });
  const directory = await mkdtemp(join(tmpdir(), "minu-folder-gateway-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.html"), "<main>Folder gateway fixture</main>");
  const web = await createLocalWebServer({
    conversationsEndpoint: backend.endpoint,
    controlEndpoint: backend.endpoint,
    conversationsServiceToken: backend.serviceToken,
    webDirectory: directory,
    port: 0,
    authenticateBrowser: (cookie) => cookie === "fixture=owner" ? { identityId: owner.id }
      : cookie === "fixture=member" ? { identityId: member.id } : undefined,
  });
  t.after(() => web.close());
  const catalogue = `/workspaces/${workspace.id}/folders`;
  const assignment = `/conversations/${conversation.id}/folder`;
  const request = async <T>(path: string, status: number, method = "GET", body?: unknown, cookie = "fixture=owner", headers: Record<string, string> = {}): Promise<T> => {
    const response = await fetch(`${web.endpoint}${path}`, {
      method, headers: { cookie, origin: web.endpoint, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return JSON.parse(text) as T;
  };
  const createFolder = async () => (await request<{ folder: Folder }>(catalogue, 201, "POST", { actorIdentityId: owner.id, name: "Engineering" })).folder;
  return { backend, client, web, owner, member, workspace, conversation, catalogue, assignment, request, createFolder };
}

test("folder gateway routes reject missing sessions and foreign origins before reaching collaboration APIs", async (t) => {
  const f = await fixture(t);
  const before = await f.client.listWorkspaceConversations(f.workspace.id);
  for (const [path, method, body] of [
    [f.catalogue, "GET", undefined],
    [f.catalogue, "POST", { actorIdentityId: f.owner.id, name: "Forbidden" }],
    [`${f.catalogue}/folder_unknown`, "PATCH", { actorIdentityId: f.owner.id, name: "Forbidden" }],
    [f.assignment, "PATCH", { actorIdentityId: f.owner.id, folderId: null }],
    ["/conversations", "POST", { actorIdentityId: f.owner.id, workspaceId: f.workspace.id, participantIds: [f.owner.id], folderId: "folder_unknown" }],
  ] as const) {
    await f.request(path, 401, method, body, "", {
      // Neither a supplied service token nor an actor header may bypass the session.
      authorization: `Bearer ${f.backend.serviceToken}`, "x-minu-actor-id": f.owner.id,
    });
    const response = await fetch(`${f.web.endpoint}${path}`, {
      method, headers: { cookie: "fixture=owner", origin: "https://hostile.example", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 403);
    await response.text();
  }
  assert.deepEqual(await f.client.listWorkspaceConversations(f.workspace.id), before);
});

test("folder gateway uses the current human, permits member navigation and denies member administration", async (t) => {
  const f = await fixture(t);
  // An incoming actor header must be overwritten by the authenticated session.
  const { folder } = await f.request<{ folder: Folder }>(f.catalogue, 201, "POST", {
    actorIdentityId: f.owner.id, name: "Engineering",
  }, "fixture=owner", { "x-minu-actor-id": f.member.id });
  const { folders } = await f.request<{ folders: Folder[] }>(f.catalogue, 200, "GET", undefined, "fixture=member");
  assert.deepEqual(folders, [folder]);
  await f.request(`${f.catalogue}/${folder.id}`, 200, "PATCH", { actorIdentityId: f.owner.id, name: "Platform" });
  const { conversation } = await f.request<{ conversation: FiledMetadata }>(f.assignment, 200, "PATCH", { actorIdentityId: f.owner.id, folderId: folder.id });
  assert.equal(conversation.folderId, folder.id);
  const before = await f.client.getConversation(f.conversation.id);
  for (const [path, method, body] of [
    [f.catalogue, "POST", { actorIdentityId: f.member.id, name: "Not allowed" }],
    [`${f.catalogue}/${folder.id}`, "PATCH", { actorIdentityId: f.member.id, name: "Not allowed" }],
    [f.assignment, "PATCH", { actorIdentityId: f.member.id, folderId: null }],
  ] as const) {
    await f.request(path, 400, method, body, "fixture=member");
  }
  const catalogue = await f.request<{ folders: Folder[] }>(f.catalogue, 200);
  assert.equal(catalogue.folders.length, 1);
  assert.equal(catalogue.folders[0]?.name, "Platform");
  assert.deepEqual(await f.client.getConversation(f.conversation.id), before);
});

test("folder gateway rejects forged body/header actors on every new mutation without partial writes", async (t) => {
  const f = await fixture(t);
  const folder = await f.createFolder();
  const before = await f.client.listWorkspaceConversations(f.workspace.id);
  const beforeCatalogue = await f.request<{ folders: Folder[] }>(f.catalogue, 200);
  for (const [cookie, actorIdentityId, forgedHeader] of [
    ["fixture=member", f.owner.id, f.owner.id],
    ["fixture=owner", f.member.id, f.member.id],
  ] as const) {
    for (const [path, method, body] of [
      [f.catalogue, "POST", { actorIdentityId, name: "Forged folder" }],
      [`${f.catalogue}/${folder.id}`, "PATCH", { actorIdentityId, name: "Forged rename" }],
      [f.assignment, "PATCH", { actorIdentityId, folderId: folder.id }],
      ["/conversations", "POST", { actorIdentityId, workspaceId: f.workspace.id, participantIds: [f.owner.id, f.member.id], folderId: folder.id }],
    ] as const) {
      const error = await f.request<{ error: string }>(path, 400, method, body, cookie, { "x-minu-actor-id": forgedHeader });
      assert.match(error.error, /authenticated browser identity/);
      assert.deepEqual(await f.client.listWorkspaceConversations(f.workspace.id), before);
      assert.deepEqual(await f.request(f.catalogue, 200), beforeCatalogue);
    }
  }
});
