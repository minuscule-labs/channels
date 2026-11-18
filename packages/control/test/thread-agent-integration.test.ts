import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationClient, ConversationService, createConversationHttpServer } from "@minu/channels-core";
import { DrizzleLibSqlConversationStorage } from "@minu/channels-storage-drizzle";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { createLocalControlDaemon, type LocalControlDaemon } from "../src/daemon.ts";
import type { ManagedRuntimeStartConfig } from "../src/agent-host.ts";

async function eventually(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test("thread Runtime scopes inherit a fixed public snapshot, route independently, recover and obey parent lifecycle", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "channels-thread-agent-"));
  const workspaceRoot = join(directory, "workspace"), project = join(workspaceRoot, "project");
  await mkdir(project, { recursive: true });
  const coreUrl = `file:${join(directory, "core.db")}`, relayPath = join(directory, "relay.db");
  let storage = await DrizzleLibSqlConversationStorage.open({ url: coreUrl });
  let core = await createConversationHttpServer({ service: new ConversationService(storage), port: 0 });
  let client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  let daemon: LocalControlDaemon | undefined;
  const sessions = new Map<string, {
    ownerId: string; label: string; config: ManagedRuntimeStartConfig; state: "active" | "suspended";
    working: boolean; inputs: string[]; messages: Array<{ role: "assistant"; content: string }>;
  }>();
  let starts = 0;
  let releaseBlocked: (() => void) | undefined;
  const runtime = {
    async start() { throw new Error("Managed sessions required"); },
    async startManaged(config: ManagedRuntimeStartConfig, ownerId: string) {
      const id = `controlled-session-${++starts}`;
      sessions.set(id, { ownerId, label: ["main", "A", "B"][starts - 1] ?? "replacement", config,
        state: "active", working: false, inputs: [], messages: [{ role: "assistant", content: "PRIVATE_RUNTIME_ONLY" }] });
      return { id, ownerId };
    },
    async listManagedSessions(ownerId: string) {
      return [...sessions].filter(([, session]) => session.ownerId === ownerId).map(([id, session]) => ({ id, ownerId, state: session.state }));
    },
    async resume(id: string, ownerId: string) {
      assert.equal(sessions.get(id)?.ownerId, ownerId);
      sessions.get(id)!.state = "active";
      return { id, ownerId };
    },
    async suspend(id: string, ownerId: string) {
      assert.equal(sessions.get(id)?.ownerId, ownerId);
      sessions.get(id)!.state = "suspended";
    },
    async status(id: string) {
      const session = sessions.get(id);
      return !session || session.state === "suspended" ? "offline" as const : session.working ? "working" as const : "idle" as const;
    },
    async send(id: string, prompt: string) {
      const session = sessions.get(id)!;
      session.inputs.push(prompt);
      if (prompt.includes("BLOCK_THREAD_TRIGGER")) {
        session.working = true;
        await new Promise<void>((resolve) => { releaseBlocked = resolve; });
        session.working = false;
      }
      session.messages.push({ role: "assistant", content: `Public answer from ${session.label}` });
    },
    async messages(id: string) { return [...sessions.get(id)!.messages]; },
  };
  try {
    const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
    const agent = await client.createIdentity({ type: "agent", displayName: "Agent" });
    const workspace = await client.createWorkspace({ slug: "thread-agent", name: "Thread agent" });
    await client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
    await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
    const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, agent.id] });
    await client.postMessage(parent.id, { participantId: owner.id, body: "SHARED_BACKGROUND" });
    const rootA = await client.postMessage(parent.id, { participantId: owner.id, body: "ROOT_A: focus on A" });
    const rootB = await client.postMessage(parent.id, { participantId: owner.id, body: "ROOT_B: focus on B" });
    const a = await client.createThread(parent.id, { actorIdentityId: owner.id, rootMessageId: rootA.id });
    const b = await client.createThread(parent.id, { actorIdentityId: owner.id, rootMessageId: rootB.id });
    await client.postMessage(parent.id, { participantId: owner.id, body: "PARENT_AFTER_THREAD_CREATION" });
    const store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(relayPath) });
    const now = new Date().toISOString();
    await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: workspaceRoot, createdAt: now, updatedAt: now });
    await store.putAgentConfig({ id: "thread-agent-config", workspaceId: workspace.id, agentIdentityId: agent.id,
      runtimeAdapter: "controlled", status: "active", createdAt: now, updatedAt: now });
    await store.replaceConversationWorkingFolders(workspace.id, parent.id, [{ workspaceId: workspace.id, conversationId: parent.id,
      relativePath: "project", position: 0, primary: true }]);
    await store.close();
    let headers: Record<string, string>;
    const launch = async () => {
      daemon = await createLocalControlDaemon({ relayDatabasePath: relayPath, currentHumanIdentityId: owner.id,
        conversationsEndpoint: core.endpoint, conversationsServiceToken: core.serviceToken,
        withConversationMessageAdmission: core.service.withConversationMessageAdmission.bind(core.service),
        port: 0, webUrl: "http://127.0.0.1:5174/", runtimes: { controlled: runtime } });
      const response = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
      assert.equal(response.status, 303);
      headers = { cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!, origin: "http://127.0.0.1:5174", "content-type": "application/json" };
    };
    const control = async (scope: string, suffix: string, init?: RequestInit) => {
      const response = await fetch(`${daemon!.endpoint}/local/conversations/${scope}${suffix}`, { ...init, headers });
      const body = await response.json();
      return { status: response.status, body };
    };
    const action = (scope: string, name: string) => control(scope, `/agents/${agent.id}/${name}`, { method: "POST" });
    const agentReplies = async (scope: string) => (await client.listMessages(scope)).filter((message) => message.participantId === agent.id);
    const trigger = async (scope: string, body: string, expectedReplies: number) => {
      const fresh = await client.postMessage(scope, { participantId: owner.id, body: `@agent ${body}` });
      await eventually(async () => {
        if ((await storage.getCursor(scope, agent.id)) < fresh.sequence) return false;
        assert.equal((await agentReplies(scope)).length, expectedReplies, "Unexpected obsolete or duplicate request dispatch");
        return true;
      }, `Missing reply in ${scope}`);
    };
    await launch();
    for (const scope of [parent.id, a.id, b.id]) assert.equal((await action(scope, "start")).status, 201);
    assert.equal(starts, 3);
    const [mainSession, aSession, bSession] = [...sessions.values()];
    for (const session of sessions.values()) assert.equal(session.config.cwd, await realpath(project));
    assert.match(aSession!.config.appendSystemPrompt!, /SHARED_BACKGROUND/);
    assert.match(aSession!.config.appendSystemPrompt!, /ROOT_A/);
    assert.match(aSession!.config.appendSystemPrompt!, /ROOT_B/, "Pre-creation parent background follows the selected root");
    assert.ok(aSession!.config.appendSystemPrompt!.includes(`[${rootA.sequence}] [THREAD ROOT]`));
    assert.ok(!aSession!.config.appendSystemPrompt!.includes(`[${rootB.sequence}] [THREAD ROOT]`));
    assert.match(bSession!.config.appendSystemPrompt!, /ROOT_B/);
    assert.ok(bSession!.config.appendSystemPrompt!.includes(`[${rootB.sequence}] [THREAD ROOT]`));
    for (const session of [aSession!, bSession!]) {
      assert.doesNotMatch(session.config.appendSystemPrompt!, /PARENT_AFTER_THREAD_CREATION|PRIVATE_RUNTIME_ONLY/);
      assert.match(session.config.appendSystemPrompt!, /untrusted reference/);
    }
    await trigger(a.id, "A_LATER_ONLY", 1);
    await trigger(parent.id, "MAIN_LATER_ONLY", 1);
    await trigger(b.id, "B_LATER_ONLY", 1);
    assert.doesNotMatch(aSession!.inputs.join("\n"), /B_LATER_ONLY|MAIN_LATER_ONLY|PARENT_AFTER_THREAD_CREATION/);
    assert.doesNotMatch(bSession!.inputs.join("\n"), /A_LATER_ONLY|MAIN_LATER_ONLY|PARENT_AFTER_THREAD_CREATION/);
    assert.doesNotMatch(mainSession!.inputs.join("\n"), /A_LATER_ONLY|B_LATER_ONLY/);
    assert.equal((await agentReplies(a.id))[0]!.body, "Public answer from A");
    assert.equal((await agentReplies(b.id))[0]!.body, "Public answer from B");
    assert.equal((await agentReplies(parent.id))[0]!.body, "Public answer from main");
    const folders = await control(a.id, "/working-folders");
    assert.equal(folders.status, 200);
    assert.equal(folders.body.folders[0].relativePath, "project");
    assert.equal((await control(a.id, "/working-folders", { method: "PUT", body: JSON.stringify({ folders: [] }) })).status, 409);
    assert.equal((await control(a.id, "/lifecycle", { method: "PATCH", body: JSON.stringify({ state: "settled" }) })).status, 409);
    assert.equal((await action(a.id, "stop")).status, 200);
    assert.equal((await control(a.id, "/agents")).body.agents[0]?.state, "stopped");
    assert.equal((await control(b.id, "/agents")).body.agents[0]?.state, "idle");
    assert.equal((await action(a.id, "start")).status, 201);
    assert.equal(starts, 3, "Start resumes only A's existing session");

    await daemon!.close(); daemon = undefined;
    await core.close(); await storage.close();
    storage = await DrizzleLibSqlConversationStorage.open({ url: coreUrl });
    core = await createConversationHttpServer({ service: new ConversationService(storage), port: 0 });
    client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
    await launch();
    assert.equal(starts, 3, "Reopening both databases restores the same three managed sessions");
    await trigger(a.id, "A_AFTER_RESTART", 2);
    await trigger(b.id, "B_AFTER_RESTART", 2);
    assert.doesNotMatch(aSession!.inputs.at(-1)!, /B_LATER_ONLY|B_AFTER_RESTART|MAIN_LATER_ONLY/);
    assert.doesNotMatch(bSession!.inputs.at(-1)!, /A_LATER_ONLY|A_AFTER_RESTART|MAIN_LATER_ONLY/);
    assert.equal((await client.getConversation(a.id)).thread?.rootMessageId, rootA.id);
    assert.equal((await client.getConversation(a.id)).thread?.context.at(-1)?.id, rootB.id);

    await daemon!.close(); daemon = undefined;
    await client.postMessage(a.id, { participantId: owner.id, body: "@agent Obsolete A request while host is offline" });
    await client.updateConversationParticipants(parent.id, { actorIdentityId: owner.id, participantIds: [owner.id], expectedRosterRevision: 1 });
    await client.updateConversationParticipants(parent.id, { actorIdentityId: owner.id, participantIds: [owner.id, agent.id], expectedRosterRevision: 2 });
    await launch();
    assert.equal(starts, 3);
    await trigger(a.id, "A_AFTER_MEMBERSHIP_RECOVERY", 3);

    await client.postMessage(b.id, { participantId: owner.id, body: "@agent BLOCK_THREAD_TRIGGER" });
    await eventually(async () => Boolean(releaseBlocked), "Thread did not begin held turn");
    assert.equal((await control(parent.id, "/lifecycle", { method: "PATCH", body: JSON.stringify({ state: "settled" }) })).status, 409,
      "Parent archive must inspect active thread work, not only main agents");
    releaseBlocked!(); releaseBlocked = undefined;
    await eventually(async () => (await agentReplies(b.id)).length === 3, "Held thread reply missing");
    await eventually(async () => {
      const result = await control(b.id, "/agents");
      return result.body.agents[0]?.state === "idle" && result.body.agents[0]?.activity === undefined;
    }, "Thread did not settle");
    const archive = await control(parent.id, "/lifecycle", { method: "PATCH", body: JSON.stringify({ state: "settled" }) });
    assert.equal(archive.status, 200, JSON.stringify(archive.body));
    for (const scope of [parent.id, a.id, b.id]) assert.equal((await control(scope, "/agents")).body.agents[0]?.state, "stopped");
    assert.equal((await action(a.id, "start")).status, 409);
    await assert.rejects(client.postMessage(a.id, { participantId: owner.id, body: "Archived reply" }), /frozen/);
  } finally {
    releaseBlocked?.();
    await daemon?.close();
    await core.close(); await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
