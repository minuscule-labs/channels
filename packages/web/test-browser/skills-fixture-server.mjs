import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConversationService } from "../../core/dist/src/conversation-service.js";
import { ConversationClient } from "../../core/dist/src/client.js";
import { createConversationHttpServer } from "../../core/dist/src/http-server.js";
import { DrizzleLibSqlConversationStorage } from "../../storage-drizzle/dist/src/storage.js";
import { DrizzleLibSqlRelayStorage } from "../../relay-storage-drizzle/dist/src/storage.js";
import { captureAuthoredContext } from "../../relay/dist/src/authored-context.js";
import { LocalAgentHost } from "../../control/dist/src/agent-host.js";
import { LocalAgentHostConfiguration } from "../../control/dist/src/configuration.js";
import { LocalControlBrowserSessions, LocalControlService, createLocalControlHttpServer } from "../../control/dist/src/server.js";

const directory = await mkdtemp(join(tmpdir(), "channels-skills-browser-"));
const coreStore = await DrizzleLibSqlConversationStorage.open({ url: `file:${join(directory, "core.db")}` });
const coreService = new ConversationService(coreStore);
const core = await createConversationHttpServer({ service: coreService, port: Number(process.env.MINU_TEST_CHANNELS_PORT ?? 58410), serviceToken: process.env.MINU_TEST_CHANNELS_SERVICE_TOKEN ?? "browser-fixture-service-token" });
const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
const store = await DrizzleLibSqlRelayStorage.open({ url: `file:${join(directory, "relay.db")}` });
const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
const member = await client.createIdentity({ type: "human", displayName: "Member" });
const sessions = new Map(), turns = new Map(), calls = [];
const runtime = {
  async start() { throw new Error("Managed sessions required"); },
  async startManaged(config, ownerId) { const id = `private-browser-${sessions.size + 1}`; sessions.set(id, { ownerId, config }); return { id, ownerId }; },
  async getManagedSession(id, ownerId) { return sessions.get(id)?.ownerId === ownerId ? { id, ownerId, state: "active" } : undefined; },
  async listManagedSessions(ownerId) { return [...sessions].filter(([, value]) => value.ownerId === ownerId).map(([id]) => ({ id, ownerId, state: "active" })); },
  async resume(id, ownerId) { if (sessions.get(id)?.ownerId !== ownerId) throw new Error("Wrong owner"); return { id, ownerId }; },
  async suspend() {},
  async status(id) { return sessions.has(id) ? "idle" : "offline"; },
  async send() { throw new Error("No legacy fallback"); },
  async messages() { return [{ role: "assistant", content: "PRIVATE_RUNTIME_TRANSCRIPT" }]; },
  async turn(_id, turnId) { return turns.get(turnId); },
  async startTurn(id, turnId, input) {
    if (turns.has(turnId)) throw new Error("Duplicate start");
    calls.push({ ...sessions.get(id).scope, turnId, input });
    const now = new Date().toISOString();
    const turn = { id: turnId, input, status: "completed", createdAt: now, updatedAt: now,
      response: { role: "assistant", content: input.includes("PRIVATE_CHANNEL_PROCEDURE") || input.includes("PRIVATE_WORKSPACE_PROCEDURE") ? "Skill result" : "Ordinary result" } };
    turns.set(turnId, turn); return turn;
  },
  async capabilities() { return { models: [], reasoningLevels: [], skills: [{ id: "skill:review", name: "review", description: "Review" }] }; },
};
const runtimes = { fixture: runtime };
const configuration = new LocalAgentHostConfiguration({ client, store, runtimes });
const host = new LocalAgentHost({ client, store, runtimes, stopStartedSessionsOnClose: false, autoResumeOfflineAgents: false });
const options = { conversations: client, bindings: store, runtimes, configuration, lifecycle: host,
  withConversationMessageAdmission: coreService.withConversationMessageAdmission.bind(coreService), authoredSkillPublicationEnabled: true };
const browserSessions = new LocalControlBrowserSessions({ browserUrl: `http://minu-channels.localhost:${process.env.MINU_TEST_WEB_PORT ?? 58412}/`, currentHumanIdentityId: member.id });
const control = await createLocalControlHttpServer({ service: new LocalControlService(options), browserSessions,
  allowedOrigins: [browserSessions.browserOrigin], port: Number(process.env.MINU_TEST_CONTROL_PORT ?? 58411) });
async function setup(enabled) {
  options.authoredSkillPublicationEnabled = enabled;
  const workspace = await client.createWorkspace({ slug: `skills-${Date.now()}`, name: `Skills ${Date.now()}` });
  const selected = await client.createIdentity({ type: "agent", displayName: "Selected" });
  const observer = await client.createIdentity({ type: "agent", displayName: "Observer" });
  for (const [identity, role] of [[owner, "owner"], [member, "member"], [selected, "member"], [observer, "member"]]) {
    await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: identity.displayName.toLowerCase(), accessRole: role });
  }
  const parent = await client.createConversation({ workspaceId: workspace.id, name: "skills-parent", participantIds: [owner.id, member.id, selected.id, observer.id] });
  const root = await client.postMessage(parent.id, { participantId: member.id, body: "Skills thread anchor", to: [] });
  const thread = await client.createThread(parent.id, { actorIdentityId: member.id, rootMessageId: root.id });
  const now = new Date().toISOString();
  await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: pathToFileURL(directory).href, createdAt: now, updatedAt: now });
  for (const identity of [selected, observer]) await store.putAgentConfig({ id: `config-${identity.id}`, workspaceId: workspace.id,
    agentIdentityId: identity.id, runtimeAdapter: "fixture", skillIds: ["skill:review"], status: "active", createdAt: now, updatedAt: now });
  const publish = async (conversationId, content) => {
    const document = await configuration.createAuthoredDocument(workspace.id, owner.id, { kind: "skill", name: "Decision", description: conversationId ? "Channel decision" : "Workspace decision", content, ...(conversationId ? { conversationId } : {}) });
    await configuration.updateAuthoredDocument(workspace.id, document.id, owner.id, { action: "publish", expectedVersion: 1 });
    return document.id;
  };
  const workspaceSkill = await publish(undefined, "PRIVATE_WORKSPACE_PROCEDURE_V1");
  const channelSkill = await publish(parent.id, "PRIVATE_CHANNEL_PROCEDURE_V1");
  const manifest = await captureAuthoredContext(store, workspace.id, parent.id);
  const ownerId = await store.getOrCreateRuntimeOwnerId();
  for (const scope of [parent.id, thread.id]) {
    const session = await runtime.startManaged({ cwd: directory }, ownerId);
    sessions.get(session.id).scope = { conversationId: scope, identityId: observer.id };
    await store.putBinding({ id: `observer-${scope}`, workspaceAgentConfigId: `config-${observer.id}`, workspaceId: workspace.id,
      conversationId: scope, agentIdentityId: observer.id, runtimeAdapter: "fixture", runtimeSessionId: session.id, runtimeOwnerId: ownerId,
      generation: 1, state: "connected", wakePolicy: "all_messages", createdAt: now, updatedAt: now }, { authoredContext: manifest });
    await host.startConversationAgent(scope, selected.id, owner.id);
    const binding = (await store.listConversationBindings(scope)).find(value => value.agentIdentityId === selected.id);
    sessions.get(binding.runtimeSessionId).scope = { conversationId: scope, identityId: selected.id };
  }
  await host.restore(); // Attach the seeded observer bindings as well as the explicitly started agent.
  for (const scope of [parent.id, thread.id]) await host.refreshConversationWorkSnapshot(scope);
  const deadline = Date.now() + 5_000;
  while (host.workSnapshot().activeTurns || host.workSnapshot().queuedTurns || !host.workSnapshot().queuedTurnsExact) {
    if (Date.now() > deadline) throw new Error("Setup did not settle");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return { workspaceId: workspace.id, parentId: parent.id, threadId: thread.id, selectedId: selected.id, observerId: observer.id,
    memberId: member.id, ownerId: owner.id, workspaceSkill, channelSkill, baseline: calls.length };
}
const fixture = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  try {
    let result;
    if (url.pathname === "/setup" && request.method === "POST") result = await setup(url.searchParams.get("enabled") !== "0");
    else if (url.pathname === "/control-launch") {
      browserSessions.currentHumanIdentityId = url.searchParams.get("actor") === "owner" ? owner.id : member.id;
      result = { launchUrl: browserSessions.issueLaunchUrl(control.endpoint, url.searchParams.get("destination") ?? "/") };
    } else if (url.pathname === "/metrics") result = { calls, sessions: sessions.size };
    else if (url.pathname === "/change" && request.method === "POST") {
      const document = await store.getAuthoredDocument(url.searchParams.get("workspace"), url.searchParams.get("document"));
      if (url.searchParams.get("action") === "archive") await configuration.updateAuthoredDocument(document.workspaceId, document.id, owner.id, { action: "archive", expectedVersion: document.version });
      else {
        const saved = await configuration.updateAuthoredDocument(document.workspaceId, document.id, owner.id, { action: "save", expectedVersion: document.version, name: "Decision v2", description: "New publication", content: "PRIVATE_CHANNEL_PROCEDURE_V2" });
        await configuration.updateAuthoredDocument(document.workspaceId, document.id, owner.id, { action: "publish", expectedVersion: saved.version });
      }
      result = {};
    } else { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(result));
  } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: String(error), stack: error.stack })); }
});
await new Promise(resolve => fixture.listen(Number(process.env.MINU_TEST_FIXTURE_PORT ?? 58413), "127.0.0.1", resolve));
async function close() { fixture.close(); await control.close(); await host.close(); await store.close(); await core.close(); await coreStore.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); }
process.on("SIGTERM", () => { void close(); });
process.on("SIGINT", () => { void close(); });
