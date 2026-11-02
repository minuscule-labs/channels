import { ConversationClient } from "@minu/channels-core";
import type { ConversationMessage, ConversationThread } from "@minu/channels-core/types";
import { createLocalControlDaemon, type LocalControlDaemon, type LocalControlDaemonOptions } from "@minu/channels-control/daemon";
import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Human messages 159/166/171 are the oracle. No recipient-selection, mention
// parsing or composer-state implementation is imported. Observe visible controls,
// actual persisted targets, authenticated control and the external Runtime boundary.
const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const web = `http://minu-channels.localhost:${process.env.MINU_TEST_WEB_PORT ?? 58412}`;
const serviceToken = "browser-fixture-service-token";
type Agent = "alpha" | "beta" | "gamma";
type Actor = "owner" | "peer";
type Scope = "main" | "thread";
const agents: Agent[] = ["alpha", "beta", "gamma"];
const marker = (name: Agent) => `BLACKBOX_AGENT_${name.toUpperCase()}`;
const panel = (page: Page) => page.getByRole("dialog", { name: "Thread", exact: true });
type RuntimePort = NonNullable<LocalControlDaemonOptions["runtimes"]>[string];
type StartConfig = Parameters<NonNullable<RuntimePort["startManaged"]>>[0];

class RecordingRuntime implements RuntimePort {
  readonly starts: Array<{ id: string; agent: Agent; config: StartConfig }> = [];
  readonly calls: Array<{ sessionId: string; agent: Agent; input: string; reply: string }> = [];
  readonly output: Partial<Record<Agent, string>> = {};
  private readonly sessions = new Map<string, { ownerId: string; agent: Agent; messages: Array<{ role: "user" | "assistant"; content: string }> }>();
  async start(): Promise<never> { throw new Error("The fixture requires managed sessions"); }
  async startManaged(config: StartConfig, ownerId: string) {
    const agent = agents.find((name) => config.appendSystemPrompt?.includes(marker(name))); expect(agent).toBeTruthy();
    const id = `UI_TARGETING_SESSION_${this.starts.length + 1}`;
    this.starts.push({ id, agent: agent!, config: structuredClone(config) });
    this.sessions.set(id, { ownerId, agent: agent!, messages: [] }); return { id, ownerId };
  }
  async listManagedSessions(ownerId: string) {
    return [...this.sessions].filter(([, value]) => value.ownerId === ownerId).map(([id]) => ({ id, ownerId, state: "active" as const }));
  }
  async status(id: string): Promise<"idle" | "offline"> { return this.sessions.has(id) ? "idle" : "offline"; }
  async resume(id: string, ownerId: string) { expect(this.sessions.get(id)?.ownerId).toBe(ownerId); return { id, ownerId }; }
  async send(sessionId: string, input: string) {
    const session = this.sessions.get(sessionId); expect(session).toBeTruthy(); expect(this.calls.length).toBeLessThan(20);
    const reply = `${this.output[session!.agent] ?? "Controlled answer"} UI_TARGETING_REPLY_${this.calls.length + 1}`;
    this.calls.push({ sessionId, agent: session!.agent, input, reply });
    session!.messages.push({ role: "user", content: input }, { role: "assistant", content: reply });
  }
  async messages(id: string) { return structuredClone(this.sessions.get(id)?.messages ?? []); }
  async interrupt() {}
}

async function application(page: Page, context: BrowserContext) {
  const directory = await mkdtemp(join(tmpdir(), "targeting-ui-blackbox-"));
  const root = join(directory, "workspace"); await mkdir(root);
  const runtime = new RecordingRuntime();
  const client = new ConversationClient(api, { serviceToken });
  let daemon: LocalControlDaemon | undefined;
  let actor: Actor = "owner";
  let cookie = "";
  let selectedThread: ConversationThread | undefined;
  try {
    const owner = await client.createIdentity({ type: "human", displayName: "Targeting Owner" });
    const peer = await client.createIdentity({ type: "human", displayName: "Targeting Peer" });
    const alpha = await client.createIdentity({ type: "agent", displayName: "Alpha Agent" });
    const beta = await client.createIdentity({ type: "agent", displayName: "Beta Agent" });
    const gamma = await client.createIdentity({ type: "agent", displayName: "Gamma Agent" });
    const identities = { owner, peer, alpha, beta, gamma };
    const workspace = await client.createWorkspace({ slug: `targeting-${owner.id.slice(-12)}`, name: "Targeting blackbox" });
    for (const name of ["owner", "peer", ...agents] as const) await client.addWorkspaceMember(workspace.id, {
      identityId: identities[name].id, mentionHandle: name, ...(["owner", "peer"].includes(name) ? { accessRole: "owner" as const } : {}),
    });
    const participantIds = Object.values(identities).map(({ id }) => id);
    const parent = await client.createConversation({ workspaceId: workspace.id, name: "Targeting Parent", participantIds });
    await client.postMessage(parent.id, { participantId: owner.id, body: "PUBLIC_CONTEXT_AT_CREATION" });
    const defaultRoot = await client.postMessage(parent.id, { participantId: alpha.id, body: "DEFAULT_ALPHA_ROOT" });
    let main = parent;
    async function bindIdentity(name: Actor) {
      const previous = daemon;
      daemon = await createLocalControlDaemon({ currentHumanIdentityId: identities[name].id,
        conversationsEndpoint: api, conversationsServiceToken: serviceToken, relayDatabasePath: join(directory, "relay.db"),
        port: 0, webUrl: `${web}/`, runtimes: { "targeting-controlled": runtime }, recordAgentDiagnostics: false, stopStartedSessionsOnClose: false });
      try {
        const url = new URL(daemon.issueBrowserLaunchUrl()); url.hostname = "127.0.0.1";
        const exchange = await fetch(url, { redirect: "manual" }); expect(exchange.status).toBe(303);
        cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!; await exchange.arrayBuffer();
        const split = cookie.indexOf("=");
        await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: web, httpOnly: true, sameSite: "Strict" }]);
        actor = name;
      } finally { await previous?.close(); }
    }
    await bindIdentity("owner");
    async function control<T>(path: string, method = "GET", body?: unknown): Promise<T> {
      const response = await fetch(`${daemon!.endpoint}/local${path}`, { method,
        headers: { cookie, origin: web, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000) });
      const value = await response.json(); expect(response.ok, `${response.status}: ${JSON.stringify(value)}`).toBe(true); return value as T;
    }
    await control(`/workspaces/${workspace.id}/config`, "PATCH", { rootUri: await realpath(root) });
    for (const name of agents) await control(`/workspaces/${workspace.id}/agents/${identities[name].id}/config`, "PATCH",
      { runtimeAdapter: "targeting-controlled", personaPrompt: marker(name) });
    await page.route("**/local/**", async (route) => {
      const original = new URL(route.request().url());
      const destination = new URL(original.pathname + original.search, daemon!.endpoint);
      try {
        const response = await route.fetch({ url: destination.href, headers: { ...route.request().headers(), host: destination.host }, timeout: 5_000 });
        await route.fulfill({ response });
      } catch (error) { if (!page.isClosed()) throw error; }
    });
    const view = (scope: Scope) => scope === "thread" ? panel(page) : page.locator("section")
      .filter({ has: page.getByRole("combobox", { name: "Conversation message", exact: true }) }).last();
    const composer = (scope: Scope) => view(scope).getByRole("combobox", { name: scope === "thread" ? "Thread reply" : "Conversation message", exact: true });
    const recipient = (scope: Scope) => view(scope).getByRole("combobox", { name: "Message recipient", exact: true });
    const scopeId = (scope: Scope) => scope === "main" ? main.id : selectedThread!.id;
    async function visitMain(conversation = parent) {
      main = conversation;
      await page.goto(`${web}/app/workspaces/${workspace.id}/conversations/${conversation.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByLabel("Live updates live").first()).toBeVisible();
      if (await panel(page).isVisible()) await panel(page).getByRole("button", { name: "Close thread", exact: true }).click();
      await expect(composer("main")).toBeVisible();
    }
    async function openThread(message = defaultRoot) {
      await visitMain(parent);
      const row = view("main").getByRole("log", { name: "Conversation messages", exact: true }).getByRole("article").filter({ hasText: message.body });
      await row.getByRole("button", { name: new RegExp(`^Open (?:message )?actions for message ${message.sequence}$`) }).click();
      await page.getByRole("menuitem", { name: /^(Start|Open) thread$/ }).click();
      await expect(panel(page).getByRole("article", { name: "Thread root", exact: true })).toContainText(message.body);
      selectedThread = (await client.listThreads(parent.id)).find(({ thread }) => thread.rootMessageId === message.id)!;
      expect(selectedThread).toBeTruthy(); return selectedThread;
    }
    return {
      client, identities, workspace, parent, defaultRoot, runtime, view, composer, recipient, scopeId, visitMain, openThread,
      get thread() { expect(selectedThread).toBeTruthy(); return selectedThread!; },
      async as(name: Actor) { await page.goto("about:blank"); await bindIdentity(name); await visitMain(parent); },
      async rebindIdentity(name: Actor) { await bindIdentity(name); },
      newRoot(name: Actor | Agent, body: string, to: string[] = []) { return client.postMessage(parent.id, { participantId: identities[name].id, body, to }); },
      newChannel(name: string) { return client.createConversation({ workspaceId: workspace.id, name, participantIds }); },
      async begin(scope: Scope) { if (scope === "thread") await openThread(); else await visitMain(); },
      async choose(scope: Scope, id: string) { await recipient(scope).selectOption(id); await expect(recipient(scope)).toHaveValue(id); },
      async mention(scope: Scope, name: Agent, tail: string) {
        await composer(scope).fill(`@${name.slice(0, 2)}`);
        const option = view(scope).getByRole("listbox", { name: "Mention suggestions", exact: true }).getByRole("option", { name: new RegExp(`@${name}\\b`) });
        await expect(option).toBeVisible(); await option.click();
        await composer(scope).pressSequentially(tail);
        await expect(recipient(scope)).toHaveValue(identities[name].id);
      },
      async send(scope: Scope, body: string | undefined, expected: string[]) {
        if (body !== undefined) await composer(scope).fill(body);
        if (expected.length <= 1) await expect(recipient(scope)).toHaveValue(expected[0] ?? "");
        else for (const id of expected) {
          const name = Object.entries(identities).find(([, value]) => value.id === id)![0];
          await expect(recipient(scope).getByRole("option", { selected: true })).toContainText(`@${name}`);
        }
        const text = await composer(scope).inputValue();
        await view(scope).getByRole("button", { name: "Send message", exact: true }).click();
        await expect(composer(scope)).toHaveValue("");
        const message = (await client.listMessages(scopeId(scope))).find((value) => value.participantId === identities[actor].id && value.body === text);
        expect(message, "The actual scoped message must persist").toBeTruthy();
        expect([...message!.to].sort(), "Displayed recipients must equal actual delivery targets").toEqual([...expected].sort());
        return message!;
      },
      async answer(scope: Scope, question: ConversationMessage, name: Agent) {
        await expect.poll(async () => (await client.listMessages(scopeId(scope))).some((value) => value.replyTo === question.id && value.participantId === identities[name].id)).toBe(true);
        const reply = (await client.listMessages(scopeId(scope))).find((value) => value.replyTo === question.id && value.participantId === identities[name].id)!;
        const call = runtime.calls.find(({ reply: body }) => body === reply.body); expect(call).toBeTruthy();
        expect(call!.agent).toBe(name); expect(call!.input).toContain(question.body);
        await expect(view(scope).getByText(reply.body, { exact: true })).toBeVisible(); return call!;
      },
      async reply(scope: Scope, message: ConversationMessage) {
        const row = view(scope).getByRole("log", { name: "Conversation messages", exact: true }).getByRole("article").filter({ hasText: message.body });
        await row.getByRole("button", { name: new RegExp(`^Open (?:message )?actions for message ${message.sequence}$`) }).click();
        await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
        await expect(recipient(scope)).toHaveValue(message.participantId);
      },
      async close() { try { if (!page.isClosed()) await page.close(); } finally { try { await daemon?.close(); } finally { await rm(directory, { recursive: true, force: true }); } } },
    };
  } catch (error) { await daemon?.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}

type Application = Awaited<ReturnType<typeof application>>;
const test = base.extend<{ app: Application }>({
  app: async ({ page, context }, use) => { const app = await application(page, context); try { await use(app); } finally { await app.close(); } },
});

for (const scope of ["main", "thread"] as const) {
  test(`targeting blackbox UI: ${scope} select once, five followups, mention-switch and reload`, async ({ app, page }) => {
    await app.begin(scope);
    await expect(app.recipient(scope)).toHaveValue(scope === "thread" ? app.identities.alpha.id : "");
    await app.choose(scope, app.identities.alpha.id);
    await app.composer(scope).fill("DRAFT_STARTS_NOBODY"); expect(app.runtime.starts).toHaveLength(0);
    const first = await app.send(scope, "FIRST_STICKY_ALPHA", [app.identities.alpha.id]); const call = await app.answer(scope, first, "alpha");
    for (let index = 1; index <= 5; index += 1) {
      const followup = await app.send(scope, `ALPHA_FOLLOWUP_${index}`, [app.identities.alpha.id]);
      expect((await app.answer(scope, followup, "alpha")).sessionId).toBe(call.sessionId);
    }
    await app.mention(scope, "beta", "SWITCH_TO_BETA");
    await app.answer(scope, await app.send(scope, undefined, [app.identities.beta.id]), "beta");
    await page.reload();
    await expect(app.recipient(scope)).toHaveValue(app.identities.beta.id);
    await app.answer(scope, await app.send(scope, "BETA_AFTER_RELOAD", [app.identities.beta.id]), "beta");
    expect(app.runtime.starts.map(({ agent }) => agent).sort()).toEqual(["alpha", "beta"]);
  });

  test(`targeting blackbox UI: ${scope} ignores code, quotes, agent output and other people's messages for sticky targeting`, async ({ app }) => {
    await app.begin(scope); await app.choose(scope, app.identities.alpha.id);
    app.runtime.output.alpha = "Generated text mentions @beta and @gamma without choosing them";
    await app.answer(scope, await app.send(scope, "ASK_ALPHA_BEFORE_QUOTED_EXAMPLES", [app.identities.alpha.id]), "alpha");
    await expect(app.recipient(scope)).toHaveValue(app.identities.alpha.id);
    const other = await app.client.postMessage(app.scopeId(scope), { participantId: app.identities.peer.id, body: "@beta OTHER_PERSON_TARGETS_BETA", to: [app.identities.beta.id] });
    await expect(app.view(scope).getByText(other.body, { exact: true })).toBeVisible();
    await expect(app.recipient(scope)).toHaveValue(app.identities.alpha.id);
    const body = "QUOTED_EXAMPLES\n```ts\n@beta @unknown_agent\n```\n`@gamma`\n> @beta\n\nFOLLOWUP_FOR_ALPHA";
    await app.answer(scope, await app.send(scope, body, [app.identities.alpha.id]), "alpha");
    expect(app.runtime.starts.map(({ agent }) => agent)).toEqual(["alpha"]);
  });

  test(`targeting blackbox UI: ${scope} broadcasts and multiple recipients are one-message overrides`, async ({ app }) => {
    await app.begin(scope); await app.choose(scope, app.identities.alpha.id);
    await app.answer(scope, await app.send(scope, "SET_STICKY_ALPHA", [app.identities.alpha.id]), "alpha");
    await app.choose(scope, "@conversation");
    await app.answer(scope, await app.send(scope, "ONE_MESSAGE_BROADCAST", ["@conversation"]), "alpha");
    expect(app.runtime.starts.map(({ agent }) => agent)).toEqual(["alpha"]);
    await expect(app.recipient(scope)).toHaveValue(app.identities.alpha.id);
    const multi = await app.send(scope, "@alpha @beta ONE_MESSAGE_MULTIPLE", [app.identities.alpha.id, app.identities.beta.id]);
    await app.answer(scope, multi, "alpha"); await app.answer(scope, multi, "beta");
    await expect(app.recipient(scope)).toHaveValue(app.identities.alpha.id);
    await app.answer(scope, await app.send(scope, "FOLLOWUP_RETAINS_ALPHA", [app.identities.alpha.id]), "alpha");
    expect(app.runtime.starts.map(({ agent }) => agent).sort()).toEqual(["alpha", "beta"]);
  });
}

test("targeting blackbox UI: Reply in main selects the author without creating a thread", async ({ app }) => {
  await app.visitMain(); await app.reply("main", app.defaultRoot);
  expect(await app.client.listThreads(app.parent.id)).toEqual([]); expect(app.runtime.starts).toHaveLength(0);
  const question = await app.send("main", "MAIN_REPLY_NOT_A_THREAD", [app.identities.alpha.id]);
  expect(question.replyTo).toBe(app.defaultRoot.id); await app.answer("main", question, "alpha");
  expect(await app.client.listThreads(app.parent.id)).toEqual([]);
});

test("targeting blackbox UI: Reply within a thread switches its recipient without changing main", async ({ app, page }) => {
  await app.visitMain(); await app.choose("main", app.identities.alpha.id); await app.openThread();
  const beta = await app.client.postMessage(app.thread.id, { participantId: app.identities.beta.id, body: "BETA_THREAD_MESSAGE_TO_REPLY_TO" });
  await app.reply("thread", beta);
  const question = await app.send("thread", "REPLY_TO_BETA_IN_THREAD", [app.identities.beta.id]);
  expect(question.replyTo).toBe(beta.id); await app.answer("thread", question, "beta");
  await panel(page).getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(app.recipient("main")).toHaveValue(app.identities.alpha.id);
  expect(app.runtime.starts.map(({ agent }) => agent)).toEqual(["beta"]);
});

test("targeting blackbox UI: parent and sibling threads retain independent selections, sessions and frozen context", async ({ app, page }) => {
  await app.visitMain(); await app.choose("main", app.identities.alpha.id);
  const firstThread = await app.openThread(); const frozen = structuredClone(firstThread.thread.context);
  await app.choose("thread", app.identities.beta.id);
  const question = await app.send("thread", "THREAD_BETA_ONLY", [app.identities.beta.id]);
  const beta = await app.answer("thread", question, "beta");
  await panel(page).getByRole("button", { name: "Close thread", exact: true }).click();
  const parentQuestion = await app.send("main", "PARENT_ALPHA_ONLY", [app.identities.alpha.id]);
  const alpha = await app.answer("main", parentQuestion, "alpha"); expect(alpha.sessionId).not.toBe(beta.sessionId);
  const siblingRoot = await app.newRoot("gamma", "LATER_SIBLING_GAMMA_ROOT");
  await app.openThread(siblingRoot); await expect(app.recipient("thread")).toHaveValue(app.identities.gamma.id);
  expect(app.runtime.starts).toHaveLength(2);
  await app.openThread(app.defaultRoot); await expect(app.recipient("thread")).toHaveValue(app.identities.beta.id);
  expect((await app.client.getConversation(firstThread.id)).thread?.context).toEqual(frozen);
  expect((await app.client.listMessages(app.parent.id)).some(({ body }) => body === beta.reply)).toBe(false);
});

test("targeting blackbox UI: two real human sessions and two main conversations keep independent browser-local selections", async ({ app, page }) => {
  await app.visitMain(); await app.choose("main", app.identities.alpha.id);
  const other = await app.newChannel("Other targeting conversation"); await app.visitMain(other);
  await expect(app.recipient("main")).toHaveValue(""); await app.choose("main", app.identities.gamma.id);
  await app.as("peer"); await expect(app.recipient("main")).toHaveValue("");
  await app.choose("main", app.identities.beta.id); await page.reload(); await expect(app.recipient("main")).toHaveValue(app.identities.beta.id);
  await app.as("owner"); await expect(app.recipient("main")).toHaveValue(app.identities.alpha.id);
  await app.visitMain(other); await expect(app.recipient("main")).toHaveValue(app.identities.gamma.id);
  await app.visitMain(); await expect(app.recipient("main")).toHaveValue(app.identities.alpha.id);
  expect(app.runtime.starts).toHaveLength(0);
  await app.answer("main", await app.send("main", "OWNER_SELECTION_STILL_ALPHA", [app.identities.alpha.id]), "alpha");
});

test("targeting blackbox UI: changing the composer control overrides stale mention-looking body text and matches delivery", async ({ app }) => {
  await app.visitMain(); await app.choose("main", app.identities.alpha.id);
  await app.composer("main").fill("@beta EARLIER_RECIPIENT_INTENT");
  await app.choose("main", app.identities.gamma.id);
  await app.answer("main", await app.send("main", undefined, [app.identities.gamma.id]), "gamma");
  await app.answer("main", await app.send("main", "FOLLOWUP_TO_VISIBLE_GAMMA", [app.identities.gamma.id]), "gamma");
  expect(app.runtime.starts.map(({ agent }) => agent)).toEqual(["gamma"]);
});

test("targeting blackbox UI: human root's sole agent default is visible before Send and an explicit choice overrides it", async ({ app }) => {
  const root = await app.newRoot("owner", "HUMAN_ROOT_ADDRESSED_TO_ALPHA", [app.identities.alpha.id]);
  await app.openThread(root); await expect(app.recipient("thread")).toHaveValue(app.identities.alpha.id);
  expect(app.runtime.starts).toHaveLength(0); await app.choose("thread", app.identities.beta.id);
  await app.answer("thread", await app.send("thread", "EXPLICIT_BETA_OVERRIDES_ROOT", [app.identities.beta.id]), "beta");
  expect(app.runtime.starts.map(({ agent }) => agent)).toEqual(["beta"]);
});

test("targeting blackbox UI: Reply to a human thread root addresses that human without starting an agent", async ({ app, page }) => {
  const root = await app.newRoot("peer", "PEER_COMMENT_ADDRESSED_TO_ALPHA", [app.identities.alpha.id]);
  await app.openThread(root); await expect(app.recipient("thread")).toHaveValue(app.identities.alpha.id);
  await panel(page).getByRole("article", { name: "Thread root", exact: true }).getByRole("button", { name: "Reply", exact: true }).click();
  await expect(app.recipient("thread")).toHaveValue(app.identities.peer.id);
  await app.send("thread", "HUMAN_DIRECT_REPLY", [app.identities.peer.id]);
  await app.send("thread", "HUMAN_DIRECT_FOLLOWUP", [app.identities.peer.id]);
  expect(app.runtime.starts).toHaveLength(0); expect(app.runtime.calls).toHaveLength(0);
});

test("targeting blackbox UI: an in-place identity change must not replay another person's pending Reply selection", async ({ app, page }) => {
  await page.clock.install();
  await app.visitMain();
  const switchIdentity = async (name: Actor) => {
    const refreshed = page.waitForResponse(async (response) => new URL(response.url()).pathname === "/local/session"
      && response.status() === 200 && (await response.json()).identityId === app.identities[name].id);
    await app.rebindIdentity(name);
    await page.clock.fastForward(61_000);
    await refreshed;
  };
  await switchIdentity("peer");
  await app.choose("main", app.identities.beta.id);
  await switchIdentity("owner");
  await app.reply("main", app.defaultRoot);
  await expect(app.recipient("main")).toHaveValue(app.identities.alpha.id);
  await switchIdentity("peer");
  await expect(app.recipient("main"), "Peer's Beta selection must survive the owner's pending Alpha Reply").toHaveValue(app.identities.beta.id);
  expect(app.runtime.starts).toHaveLength(0);
});

// Owner regression: also cover an unapplied Reply waiting behind a pending send.
test("targeting: an identity change cancels a deferred Reply without changing either person's draft or target", async ({ app, page }) => {
  await page.clock.install();
  await app.visitMain();
  await app.composer("main").fill("OWNER_BEFORE_SWITCH");
  const switchIdentity = async (name: Actor, advance = 61_000) => {
    const refreshed = page.waitForResponse(async (response) => new URL(response.url()).pathname === "/local/session"
      && response.status() === 200 && (await response.json()).identityId === app.identities[name].id);
    await app.rebindIdentity(name);
    await page.clock.fastForward(advance);
    await refreshed;
  };
  await switchIdentity("peer");
  await expect(app.composer("main")).toHaveValue("");
  await app.choose("main", app.identities.beta.id);
  await app.composer("main").fill("PEER_DRAFT_STAYS_SEPARATE");
  await switchIdentity("owner");
  await expect(app.composer("main")).toHaveValue("OWNER_BEFORE_SWITCH");
  await app.choose("main", app.identities.gamma.id);
  // Put the next session refresh before the 30-second send deadline.
  await page.clock.fastForward(55_000);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const intercepted = new Promise<void>((resolve) => { entered = resolve; });
  const pattern = `**/local/conversations/${app.parent.id}/messages`;
  await page.route(pattern, async (route) => { entered(); await held; await route.abort("aborted"); });
  try {
    await app.composer("main").fill("OWNER_PENDING_DRAFT");
    await app.view("main").getByRole("button", { name: "Send message", exact: true }).click();
    await intercepted;
    const root = app.view("main").getByRole("log", { name: "Conversation messages", exact: true })
      .getByRole("article").filter({ hasText: app.defaultRoot.body });
    await root.getByRole("button", { name: new RegExp(`^Open (?:message )?actions for message ${app.defaultRoot.sequence}$`) }).click();
    await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
    await expect(app.recipient("main")).toHaveValue(app.identities.gamma.id);
    await switchIdentity("peer", 6_000);
    await expect(app.recipient("main")).toHaveValue(app.identities.beta.id);
    await expect(app.composer("main")).toHaveValue("PEER_DRAFT_STAYS_SEPARATE");
    release();
    await page.unroute(pattern);
    await switchIdentity("owner");
    await expect(app.recipient("main"), "The old deferred Alpha Reply must not replay on the owner's return").toHaveValue(app.identities.gamma.id);
    await expect(app.composer("main")).toHaveValue("OWNER_PENDING_DRAFT");
    expect(app.runtime.starts).toHaveLength(0);
    expect(app.runtime.calls).toHaveLength(0);
  } finally { release(); }
});
