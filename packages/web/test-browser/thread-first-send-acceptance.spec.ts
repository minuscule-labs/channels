import { ConversationClient } from "@minu/channels-core";
import type { ConversationMessage, ConversationThread } from "@minu/channels-core/types";
import { createLocalControlDaemon, type LocalControlDaemon, type LocalControlDaemonOptions } from "@minu/channels-control/daemon";
import type { LocalConversationAgent } from "@minu/channels-control/contracts";
import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Retained requirements: messages 138–145. Message 159/171 supersedes only the
// old multiple-recipient-stays-manual case; participant-targeting-blackbox.spec.ts
// covers its replacement (eligible addressed agents may start).
// These cases exercise user-visible
// first-Send behavior, not a proposed selection helper or a mocked Start action.
// The shared browser fixture supplies real collaboration HTTP. Each test adds its
// own real control daemon/Relay and temporary SQLite; only the model is controlled.
const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const webOrigin = `http://minu-channels.localhost:${process.env.MINU_TEST_WEB_PORT ?? 58412}`;
const serviceToken = "browser-fixture-service-token";
const panel = (page: Page) => page.getByRole("dialog", { name: "Thread", exact: true });
const composer = (page: Page) => panel(page).getByRole("combobox", { name: "Thread reply", exact: true });

type Agent = "alpha" | "beta";
type Author = Agent | "owner";
type LocalManagedRuntimePort = NonNullable<LocalControlDaemonOptions["runtimes"]>[string];
type ManagedRuntimeStartConfig = Parameters<NonNullable<LocalManagedRuntimePort["startManaged"]>>[0];

class ObservedRuntime implements LocalManagedRuntimePort {
  readonly starts: Array<{ id: string; config: ManagedRuntimeStartConfig }> = [];
  readonly resumes: string[] = [];
  readonly calls: Array<{ sessionId: string; input: string; reply: string }> = [];
  private readonly sessions = new Map<string, {
    ownerId: string; messages: Array<{ role: "user" | "assistant"; content: string }>;
  }>();

  async start(): Promise<never> { throw new Error("This fixture must use owner-scoped managed sessions"); }
  async startManaged(config: ManagedRuntimeStartConfig, ownerId: string) {
    const id = `PRIVATE_FIRST_SEND_SESSION_${this.starts.length + 1}`;
    this.starts.push({ id, config: structuredClone(config) });
    this.sessions.set(id, { ownerId, messages: [] });
    return { id, ownerId };
  }
  async listManagedSessions(ownerId: string) {
    return [...this.sessions].filter(([, session]) => session.ownerId === ownerId)
      .map(([id]) => ({ id, ownerId, state: "active" as const }));
  }
  async resume(id: string, ownerId: string) {
    expect(this.sessions.get(id)?.ownerId).toBe(ownerId);
    this.resumes.push(id);
    return { id, ownerId };
  }
  async status(id: string): Promise<"idle" | "offline"> { return this.sessions.has(id) ? "idle" : "offline"; }
  async send(sessionId: string, input: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Send without a launched session");
    const call = { sessionId, input, reply: `FIRST_SEND_REPLY_${this.calls.length + 1}` };
    this.calls.push(call);
    session.messages.push({ role: "user", content: input }, { role: "assistant", content: call.reply });
  }
  async messages(id: string) { return structuredClone(this.sessions.get(id)?.messages ?? []); }
  async interrupt() {}
}

async function application(page: Page, context: BrowserContext) {
  const directory = await mkdtemp(join(tmpdir(), "thread-first-send-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot);
  const runtime = new ObservedRuntime();
  const client = new ConversationClient(api, { serviceToken });
  let daemon: LocalControlDaemon | undefined;
  try {
    const owner = await client.createIdentity({ type: "human", displayName: "First Send Owner" });
    const alpha = await client.createIdentity({ type: "agent", displayName: "Alpha Agent" });
    const beta = await client.createIdentity({ type: "agent", displayName: "Beta Agent" });
    const identities = { owner, alpha, beta };
    const workspace = await client.createWorkspace({ slug: `first-send-${owner.id.slice(-12)}`, name: "First Send Acceptance" });
    for (const name of ["owner", "alpha", "beta"] as const) {
      await client.addWorkspaceMember(workspace.id, { identityId: identities[name].id,
        mentionHandle: name, ...(name === "owner" ? { accessRole: "owner" as const } : {}) });
    }
    const parent = await client.createConversation({ workspaceId: workspace.id, name: "First Send Parent",
      participantIds: [owner.id, alpha.id, beta.id] });
    await client.postMessage(parent.id, { participantId: owner.id, body: "PUBLIC_BACKGROUND_AT_THREAD_CREATION" });
    daemon = await createLocalControlDaemon({
      currentHumanIdentityId: owner.id, conversationsEndpoint: api, conversationsServiceToken: serviceToken,
      relayDatabasePath: join(directory, "relay.db"), port: 0, webUrl: `${webOrigin}/`,
      runtimes: { "first-send-controlled": runtime }, recordAgentDiagnostics: false,
      stopStartedSessionsOnClose: false,
    });
    const launch = new URL(daemon.issueBrowserLaunchUrl());
    launch.hostname = "127.0.0.1"; // Node need not implement Chromium's *.localhost mapping.
    const exchange = await fetch(launch, { redirect: "manual" });
    expect(exchange.status).toBe(303);
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
    await exchange.arrayBuffer();
    const [cookieName, cookieValue] = cookie.split("=");
    await context.addCookies([{ name: cookieName!, value: cookieValue!, url: webOrigin,
      httpOnly: true, sameSite: "Strict" }]);

    async function control<T>(path: string, method = "GET", body?: unknown): Promise<T> {
      const response = await fetch(`${daemon!.endpoint}/local${path}`, {
        method, headers: { cookie, origin: webOrigin, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000),
      });
      const value = await response.json();
      expect(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`).toBe(true);
      return value as T;
    }
    await control(`/workspaces/${workspace.id}/config`, "PATCH", { rootUri: await realpath(workspaceRoot) });
    for (const agent of [alpha, beta]) {
      await control(`/workspaces/${workspace.id}/agents/${agent.id}/config`, "PATCH", { runtimeAdapter: "first-send-controlled" });
    }

    // Forward the existing browser control proxy to this test's actual daemon.
    // No control response, action receipt, selection policy or session is mocked.
    await page.route("**/local/**", async (route) => {
      const original = new URL(route.request().url());
      const destination = new URL(original.pathname + original.search, daemon!.endpoint);
      const headers = { ...route.request().headers(), host: destination.host };
      try {
        const response = await route.fetch({ url: destination.href, headers, maxRedirects: 0, timeout: 5_000 });
        await route.fulfill({ response });
      } catch (error) { if (!page.isClosed()) throw error; }
    });

    const agentPath = (id: string, name: Agent) => `/conversations/${id}/agents/${identities[name].id}`;
    return {
      client, parent, workspace, identities, runtime, control, agentPath, controlEndpoint: daemon.endpoint,
      root(author: Author, body: string) { return client.postMessage(parent.id, { participantId: identities[author].id, body }); },
      async open(root: ConversationMessage) {
        await page.goto(`${webOrigin}/app/workspaces/${workspace.id}/conversations/${parent.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.getByLabel("Live updates live").first()).toBeVisible();
        const row = page.getByRole("log", { name: "Conversation messages", exact: true }).first()
          .getByRole("article").filter({ hasText: root.body });
        await row.getByRole("button", { name: new RegExp(`^Open (?:message )?actions for message ${root.sequence}$`) }).click();
        await page.getByRole("menuitem", { name: /^(Start|Open) thread$/ }).click();
        await expect(panel(page)).toBeVisible();
        await expect(panel(page).getByRole("article", { name: "Thread root", exact: true })).toContainText(root.body);
        const thread = (await client.listThreads(parent.id)).find(({ thread }) => thread.rootMessageId === root.id);
        expect(thread).toBeTruthy();
        return thread!;
      },
      async send(thread: ConversationThread, body: string) {
        await composer(page).fill(body);
        await panel(page).getByRole("button", { name: "Send message", exact: true }).click();
        await expect(composer(page)).toHaveValue("");
        const sent = (await client.listMessages(thread.id)).find((message) => message.participantId === owner.id && message.body.includes(body));
        expect(sent, "The first question must persist in the selected thread").toBeTruthy();
        return sent!;
      },
      async answer(thread: ConversationThread, trigger: ConversationMessage, name: Agent) {
        await expect.poll(async () => (await client.listMessages(thread.id))
          .some((message) => message.participantId === identities[name].id && message.replyTo === trigger.id),
        { message: "First Send must start the selected thread agent and deliver its first answer" }).toBe(true);
        const response = (await client.listMessages(thread.id)).find((message) => message.replyTo === trigger.id)!;
        expect(response.participantId).toBe(identities[name].id);
        const call = runtime.calls.find(({ reply }) => reply === response.body);
        expect(call, "The answer must originate at the actual Runtime boundary").toBeTruthy();
        expect(call!.input, "The selected worker must receive the saved question, not merely publish a reply with its id").toContain(trigger.body);
        await expect(panel(page).getByText(response.body, { exact: true })).toBeVisible();
        return call!;
      },
      async state(id: string, name: Agent) { return (await control<{ agent: LocalConversationAgent }>(agentPath(id, name))).agent; },
      async close() {
        try { if (!page.isClosed()) await page.close(); }
        finally { try { await daemon?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
      },
    };
  } catch (error) { await daemon?.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}

type Application = Awaited<ReturnType<typeof application>>;
const test = base.extend<{ app: Application }>({
  app: async ({ page, context }, use) => {
    const app = await application(page, context);
    try { await use(app); } finally { await app.close(); }
  },
});

for (const scenario of [
  { name: "agent-authored root defaults to its author", author: "alpha", root: "ROOT_FROM_ALPHA", question: "FIRST_DEFAULT_QUESTION", selected: "alpha" },
  { name: "human root addressed to one agent defaults to that recipient", author: "owner", root: "@alpha ROOT_ADDRESSED_TO_ALPHA", question: "FIRST_ADDRESSED_ROOT_QUESTION", selected: "alpha" },
  { name: "explicit first-message recipient supplies an otherwise missing default", author: "owner", root: "ROOT_WITHOUT_RECIPIENT", question: "@beta FIRST_EXPLICIT_QUESTION", selected: "beta" },
  { name: "explicit first-message recipient overrides an agent author", author: "alpha", root: "ROOT_AUTHOR_IS_ALPHA", question: "@beta FIRST_OVERRIDE_AUTHOR_QUESTION", selected: "beta" },
  { name: "explicit first-message recipient overrides a human root's recipient", author: "owner", root: "@alpha ROOT_RECIPIENT_IS_ALPHA", question: "@beta FIRST_OVERRIDE_RECIPIENT_QUESTION", selected: "beta" },
] as const) {
  test(`first-Send acceptance: ${scenario.name}`, async ({ app }) => {
    const root = await app.root(scenario.author, scenario.root);
    const thread = await app.open(root);
    expect(app.runtime.starts).toHaveLength(0);
    const trigger = await app.send(thread, scenario.question);
    await app.answer(thread, trigger, scenario.selected);
    expect(trigger.to).toEqual([app.identities[scenario.selected].id]);
    expect(app.runtime.starts).toHaveLength(1);
    const other = scenario.selected === "alpha" ? "beta" : "alpha";
    expect((await app.state(thread.id, other)).state).toBe("unbound");
    expect((await app.client.listMessages(app.parent.id)).some(({ body }) => body.startsWith("FIRST_SEND_REPLY_"))).toBe(false);
  });
}

for (const scenario of [
  { name: "unaddressed human root", author: "owner", root: "UNADDRESSED_HUMAN_ROOT", question: "QUESTION_WITHOUT_A_RECIPIENT" },
  { name: "broadcast human root", author: "owner", root: "@channel BROADCAST_ROOT", question: "QUESTION_FROM_BROADCAST_ROOT" },
  { name: "human root addressed to multiple agents", author: "owner", root: "@alpha @beta MULTIPLE_ROOT_RECIPIENTS", question: "QUESTION_FROM_MULTIPLE_ROOT" },
  { name: "first message explicitly broadcasts", author: "alpha", root: "SINGLE_AUTHOR_BUT_FIRST_BROADCAST", question: "@channel FIRST_BROADCAST_QUESTION" },
] as const) {
  test(`first-Send acceptance: ${scenario.name} stays manual`, async ({ app }) => {
    const thread = await app.open(await app.root(scenario.author, scenario.root));
    await app.send(thread, scenario.question);
    for (const agent of ["alpha", "beta"] as const) expect((await app.state(thread.id, agent)).state).toBe("unbound");
    expect(app.runtime.starts).toHaveLength(0);
    expect(app.runtime.calls).toHaveLength(0);
    expect((await app.client.listMessages(thread.id)).filter(({ participantId }) => participantId !== app.identities.owner.id)).toHaveLength(0);
  });
}

test("first-Send acceptance: opening, drafting and reopening never start agents", async ({ app, page }) => {
  const root = await app.root("alpha", "BROWSE_WITHOUT_STARTING");
  await app.open(root);
  await composer(page).fill("UNSENT_THREAD_DRAFT");
  await panel(page).getByRole("button", { name: "Close thread", exact: true }).click();
  const thread = await app.open(root);
  await expect(composer(page)).toHaveValue("UNSENT_THREAD_DRAFT");
  expect(await app.client.listMessages(thread.id)).toEqual([]);
  expect(app.runtime.starts).toHaveLength(0);
  expect(app.runtime.calls).toHaveLength(0);
});

test("first-Send acceptance: explicit Stop is not silently resumed", async ({ app }) => {
  const thread = await app.open(await app.root("alpha", "STOP_MUST_BE_RESPECTED"));
  await app.control(`${app.agentPath(thread.id, "alpha")}/start`, "POST");
  await app.control(`${app.agentPath(thread.id, "alpha")}/stop`, "POST");
  expect((await app.state(thread.id, "alpha")).state).toBe("stopped");
  await app.send(thread, "@alpha FIRST_QUESTION_WHILE_EXPLICITLY_STOPPED");
  expect((await app.state(thread.id, "alpha")).state).toBe("stopped");
  expect(app.runtime.starts).toHaveLength(1);
  expect(app.runtime.resumes).toHaveLength(0);
  expect(app.runtime.calls).toHaveLength(0);
});

test("first-Send acceptance: an archived parent does not permit sending or startup", async ({ app, page }) => {
  const root = await app.root("alpha", "ARCHIVED_PARENT_ROOT");
  const thread = await app.open(root);
  await app.client.updateConversationLifecycle(app.parent.id, { actorIdentityId: app.identities.owner.id, state: "settled" });
  await app.open(root);
  await expect(composer(page)).toBeDisabled();
  await expect(panel(page).getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  expect(await app.client.listMessages(thread.id)).toEqual([]);
  expect(app.runtime.starts).toHaveLength(0);
});

test("first-Send acceptance: a conversation member cannot gain agent-start permissions by sending", async ({ app }) => {
  const root = await app.root("alpha", "MEMBER_CANNOT_START_AGENT");
  const backup = await app.client.createIdentity({ type: "human" });
  await app.client.addWorkspaceMember(app.workspace.id, { identityId: backup.id, mentionHandle: "backup", accessRole: "owner" });
  await app.client.updateWorkspaceMember(app.workspace.id, app.identities.owner.id, { actorIdentityId: app.identities.owner.id, accessRole: "member" });
  const thread = await app.open(root);
  const question = "@alpha MEMBER_QUESTION_WITHOUT_START_PERMISSION";
  // The implementation contract preserves ordinary member messaging without
  // widening the separate owner/admin permission to launch a Runtime worker.
  await app.send(thread, question);
  expect(app.runtime.starts).toHaveLength(0);
  expect(app.runtime.calls).toHaveLength(0);
});

test("first-Send acceptance: lost send acknowledgement retries without a duplicate session, question or answer", async ({ app, page }) => {
  const thread = await app.open(await app.root("alpha", "RETRY_THE_FIRST_QUESTION"));
  let lost = false;
  await page.route("**/conversations/*/messages", async (route) => {
    const original = route.request();
    if (original.method() !== "POST" || !new URL(original.url()).pathname.endsWith(`/${thread.id}/messages`) || lost) return route.fallback();
    lost = true;
    const target = new URL(original.url());
    // route.fetch bypasses the registered /local proxy; preserve its actual-daemon destination.
    if (target.pathname.startsWith("/local/")) target.host = new URL(app.controlEndpoint).host;
    target.hostname = "127.0.0.1";
    const response = await route.fetch({ url: target.href, headers: { ...original.headers(), host: target.host } });
    expect(response.ok()).toBe(true);
    await route.abort("failed");
  });
  const body = "FIRST_QUESTION_WITH_A_LOST_ACKNOWLEDGEMENT";
  await composer(page).fill(body);
  await panel(page).getByRole("button", { name: "Send message", exact: true }).click();
  const retry = panel(page).getByRole("button", { name: "Retry same message", exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(composer(page)).toHaveValue("");
  const triggers = (await app.client.listMessages(thread.id)).filter((message) => message.participantId === app.identities.owner.id && message.body.includes(body));
  expect(triggers).toHaveLength(1);
  await app.answer(thread, triggers[0]!, "alpha");
  expect(app.runtime.starts).toHaveLength(1);
  expect(app.runtime.calls).toHaveLength(1);
  expect((await app.client.listMessages(thread.id)).filter(({ replyTo }) => replyTo === triggers[0]!.id)).toHaveLength(1);
});

test("first-Send acceptance: new thread session preserves frozen context and leaves parent/sibling sessions alone", async ({ app }) => {
  await app.control(`${app.agentPath(app.parent.id, "alpha")}/start`, "POST");
  const parentSession = app.runtime.starts[0]!;
  const root = await app.root("alpha", "ROOT_FOR_A_SEPARATE_THREAD_SESSION");
  const parentBefore = await app.client.listMessages(app.parent.id);
  const thread = await app.open(root);
  const frozen = structuredClone(thread.thread.context);
  const later = await app.root("owner", "PARENT_ONLY_AFTER_THREAD_CREATION");
  const sibling = await app.client.createThread(app.parent.id, { actorIdentityId: app.identities.owner.id, rootMessageId: later.id });
  await app.client.postMessage(sibling.id, { participantId: app.identities.owner.id, body: "SIBLING_ONLY_AFTER_CREATION" });
  const first = await app.send(thread, "FIRST_PRIVATE_THREAD_QUESTION");
  const firstCall = await app.answer(thread, first, "alpha");
  expect(app.runtime.starts).toHaveLength(2);
  expect(firstCall.sessionId).not.toBe(parentSession.id);
  const threadSession = app.runtime.starts.find(({ id }) => id === firstCall.sessionId)!;
  expect(threadSession.config.appendSystemPrompt).toContain("PUBLIC_BACKGROUND_AT_THREAD_CREATION");
  expect(threadSession.config.appendSystemPrompt).toContain(root.body);
  expect(threadSession.config.appendSystemPrompt).not.toMatch(/PARENT_ONLY_AFTER_THREAD_CREATION|SIBLING_ONLY_AFTER_CREATION/);
  const second = await app.send(thread, "SECOND_PRIVATE_THREAD_QUESTION");
  const secondCall = await app.answer(thread, second, "alpha");
  expect(secondCall.sessionId).toBe(firstCall.sessionId);
  expect(app.runtime.starts).toHaveLength(2);
  expect((await app.client.getConversation(thread.id)).thread?.context).toEqual(frozen);
  expect((await app.client.listMessages(app.parent.id)).map(({ id }) => id)).toEqual([...parentBefore.map(({ id }) => id), later.id]);
  expect((await app.state(sibling.id, "alpha")).state).toBe("unbound");
  expect((await app.state(app.parent.id, "alpha")).state).toBe("idle");
  expect(app.runtime.calls.filter(({ sessionId }) => sessionId === parentSession.id)).toHaveLength(0);
});

test("first-Send acceptance: an ambiguous thread still works after an explicit manual Start", async ({ app }) => {
  const thread = await app.open(await app.root("owner", "MANUAL_START_WITHOUT_A_DEFAULT"));
  // This unchanged public API also calibrates the real daemon/Relay fixture: a
  // missing auto-start must not be confused with a broken controlled provider.
  await app.control(`${app.agentPath(thread.id, "alpha")}/start`, "POST");
  const trigger = await app.send(thread, "@alpha MANUALLY_STARTED_FIRST_QUESTION");
  await app.answer(thread, trigger, "alpha");
  expect(app.runtime.starts).toHaveLength(1);
  expect(app.runtime.calls).toHaveLength(1);
});
