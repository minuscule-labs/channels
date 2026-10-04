import assert from "node:assert/strict";
import test from "node:test";
import { ConversationClient } from "../src/client.ts";
import { createConversationHttpServer } from "../src/http-server.ts";

async function workspace(client: ConversationClient) {
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const agent = await client.createIdentity({ type: "agent", displayName: "Builder" });
  const workspace = await client.createWorkspace({ slug: "broadcast-test", name: "Broadcast Test" });
  await client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
  const member = await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "builder" });
  return { owner, agent, workspace, member };
}

test("the real API canonicalizes channel and legacy broadcast mentions in messages and responses", async () => {
  const server = await createConversationHttpServer();
  try {
    const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
    const { owner, agent, workspace: space } = await workspace(client);
    const conversation = await client.createConversation({
      workspaceId: space.id, name: "broadcast", participantIds: [owner.id, agent.id], actorIdentityId: owner.id,
    });
    for (const body of ["@channel hello", "@CHANNEL hello", "@conversation hello", "@CONVERSATION hello", "@channel, hello", "@channel!", "@conversation."]) {
      const message = await client.postMessage(conversation.id, { participantId: owner.id, body, to: ["@conversation"] });
      assert.deepEqual(message.to, ["@conversation"]);
      assert.equal(message.body, body);
    }
    for (const to of [["@channel"], ["channel"], ["@CHANNEL", "@conversation"], ["@CONVERSATION"]]) {
      const message = await client.postMessage(conversation.id, { participantId: owner.id, body: "Structured broadcast", to });
      assert.deepEqual(message.to, ["@conversation"]);
    }
    const trigger = await client.postMessage(conversation.id, { participantId: owner.id, body: "@channel inspect" });
    const response = await client.postResponse(conversation.id, {
      participantId: agent.id, triggerMessageId: trigger.id, triggerSequence: trigger.sequence, body: "@channel result",
    });
    assert.deepEqual(response.message.to, ["@conversation"]);
  } finally {
    await server.close();
  }
});

test("complete trailing-hyphen handles stay direct in messages and responses", async () => {
  const server = await createConversationHttpServer();
  try {
    const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
    const { owner, agent, workspace: space } = await workspace(client);
    const bystander = await client.createIdentity({ type: "agent", displayName: "Bystander" });
    await client.addWorkspaceMember(space.id, { identityId: bystander.id, mentionHandle: "bystander" });
    const conversation = await client.createConversation({
      workspaceId: space.id, name: "direct-handles", participantIds: [owner.id, agent.id, bystander.id], actorIdentityId: owner.id,
    });
    for (const handle of ["channel-", "channel--", "channel-_", "conversation-", "builder-"]) {
      await client.updateWorkspaceMember(space.id, agent.id, { actorIdentityId: owner.id, mentionHandle: handle });
      for (const spelling of [handle, handle.toUpperCase()]) {
        const body = `@${spelling}, direct only`;
        const textual = await client.postMessage(conversation.id, { participantId: owner.id, body });
        assert.deepEqual(textual.to, [agent.id]);
        const explicit = await client.postMessage(conversation.id, { participantId: owner.id, body, to: [agent.id] });
        assert.deepEqual(explicit.to, [agent.id], "text cannot widen an explicit direct target into broadcast");
        const response = await client.postResponse(conversation.id, {
          participantId: agent.id, triggerMessageId: explicit.id, triggerSequence: explicit.sequence,
          body: `Result for @${spelling}`,
        });
        assert.deepEqual(response.message.to, [agent.id]);
      }
    }
    await assert.rejects(client.postMessage(conversation.id, {
      participantId: owner.id, body: "@channel--- unknown full handle", to: [agent.id],
    }), /Target participant is not in conversation: channel---/);
    await client.updateWorkspaceMember(space.id, agent.id, {
      actorIdentityId: owner.id, mentionHandle: "channel-", status: "disabled",
    });
    await assert.rejects(client.postMessage(conversation.id, {
      participantId: owner.id, body: "@CHANNEL- cannot broadcast",
    }), /Target participant is disabled/);
  } finally {
    await server.close();
  }
});

test("broadcast names are reserved on membership creation, handle changes, and the legacy creation path", async () => {
  const server = await createConversationHttpServer();
  try {
    const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
    const { owner, agent, workspace: space } = await workspace(client);
    const newcomer = await client.createIdentity({ type: "agent", displayName: "Newcomer" });
    for (const handle of ["channel", "CHANNEL", "conversation", "Conversation"]) {
      await assert.rejects(client.addWorkspaceMember(space.id, {
        identityId: newcomer.id, mentionHandle: handle,
      }), /reserved for broadcast mentions/);
      await assert.rejects(client.updateWorkspaceMember(space.id, agent.id, {
        actorIdentityId: owner.id, mentionHandle: handle,
      }), /reserved for broadcast mentions/);
      await assert.rejects(client.createConversation({
        name: "legacy", participants: [{ id: handle, type: "agent" }],
      }), /reserved for broadcast mentions/);
    }
    const members = await client.listWorkspaceMembers(space.id);
    assert.equal(members.length, 2);
    assert.equal(members.find(({ identityId }) => identityId === agent.id)?.mentionHandle, "builder");
    assert.equal((await client.listWorkspaces()).length, 1, "rejected legacy creation does not create a Workspace");
    await client.addWorkspaceMember(space.id, { identityId: newcomer.id, mentionHandle: "channel-agent" });
    await client.updateWorkspaceMember(space.id, agent.id, { actorIdentityId: owner.id, mentionHandle: "conversation-agent" });
  } finally {
    await server.close();
  }
});

test("existing channel handles stay direct, disabled collisions never broadcast, and renaming frees the alias", async () => {
  const server = await createConversationHttpServer();
  try {
    const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
    const { owner, agent, workspace: space, member } = await workspace(client);
    // Seed pre-reservation data through storage, not the now-protected public API.
    await server.service.storage.updateWorkspaceMember({
      ...member, mentionHandle: "channel", updatedAt: new Date(Date.parse(member.updatedAt) + 1).toISOString(),
    }, { id: agent.id, type: "agent", displayName: agent.displayName, handle: "channel", status: "active" }, member.updatedAt);
    const conversation = await client.createConversation({
      workspaceId: space.id, name: "legacy-collision", participantIds: [owner.id, agent.id], actorIdentityId: owner.id,
    });
    const edited = await client.updateWorkspaceMember(space.id, agent.id, {
      actorIdentityId: owner.id, mentionHandle: "CHANNEL", roleLabel: "Updated legacy role",
    });
    assert.equal(edited.mentionHandle, "channel", "unrelated edits remain possible for existing reserved handles");
    for (const input of [
      { body: "@channel direct", to: [agent.id] },
      { body: "@CHANNEL direct" },
      { body: "Structured direct", to: ["channel"] },
      { body: "Structured direct alias", to: ["@channel"] },
    ]) {
      const message = await client.postMessage(conversation.id, { participantId: owner.id, ...input });
      assert.deepEqual(message.to, [agent.id]);
    }
    const broadcast = await client.postMessage(conversation.id, { participantId: owner.id, body: "@conversation broadcast" });
    assert.deepEqual(broadcast.to, ["@conversation"]);
    await client.updateWorkspaceMember(space.id, agent.id, { actorIdentityId: owner.id, status: "disabled" });
    const count = (await client.listMessages(conversation.id)).length;
    for (const input of [{ body: "@channel cannot broadcast" }, { body: "Cannot broadcast", to: ["@channel"] }]) {
      await assert.rejects(client.postMessage(conversation.id, { participantId: owner.id, ...input }), /participant is disabled/);
    }
    assert.equal((await client.listMessages(conversation.id)).length, count);
    await client.updateWorkspaceMember(space.id, agent.id, {
      actorIdentityId: owner.id, mentionHandle: "renamed-agent", status: "active",
    });
    const released = await client.postMessage(conversation.id, { participantId: owner.id, body: "@channel now broadcasts" });
    assert.deepEqual(released.to, ["@conversation"]);
    await assert.rejects(client.updateWorkspaceMember(space.id, agent.id, {
      actorIdentityId: owner.id, mentionHandle: "channel",
    }), /reserved for broadcast mentions/);
  } finally {
    await server.close();
  }
});
