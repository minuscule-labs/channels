import type { LocalConversationAgent } from "@minu/channels-control/contracts";
import type { ConversationMetadata, CreateMessageInput, WorkspaceMember } from "@minu/channels-core/types";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const conversationsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

async function fixture(request: APIRequestContext) {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const workspaceId = workspaces.find(({ name }) => name === "Browser Test")!.id;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as {
    conversations: ConversationMetadata[];
  };
  const primary = conversations.find(({ name }) => name === "browser-collaboration")!;
  const alternate = conversations.find(({ name }) => name === "alternate-collaboration")!;
  const { conversation } = await (await request.get(`${conversationsBase}/conversations/${primary.id}`)).json() as {
    conversation: ConversationMetadata;
  };
  const agent = conversation.participants.find(({ type }) => type === "agent")!;
  return { workspaceId, primary: conversation, alternate, agent };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function launch(page: Page, request: APIRequestContext, data: Fixture) {
  const destination = `/app/workspaces/${data.workspaceId}/conversations/${data.primary.id}`;
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}`)).json();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: `#${data.primary.name}` })).toBeVisible();
}

function localAgent(data: Fixture, state: LocalConversationAgent["state"] = "unbound"): LocalConversationAgent {
  return {
    workspaceId: data.workspaceId,
    conversationId: data.primary.id,
    identityId: data.agent.id,
    state,
    capabilities: {
      start: state === "unbound", replace: state === "disabled" || state === "offline", stop: state === "idle",
      steer: false, interrupt: false, reconnect: false,
    },
  };
}

async function mockAgents(page: Page, data: Fixture, state: () => LocalConversationAgent["state"] = () => "unbound") {
  await page.route(`**/local/conversations/${data.primary.id}/agents`, (route) => route.fulfill({
    json: { protocolVersion: 17, conversationId: data.primary.id, agents: [localAgent(data, state())] },
  }));
}

async function startAll(page: Page) {
  await page.getByRole("button", { name: "Open participant actions" }).click();
  await page.getByRole("button", { name: "Start eligible agents (1)" }).click();
}

function bulkResponse(data: Fixture) {
  return {
    protocolVersion: 17,
    conversationId: data.primary.id,
    results: [
      { identityId: data.agent.id, outcome: "failed" },
      { identityId: "agent-feedback-skipped", outcome: "skipped", reason: "unconfigured" },
    ],
  };
}

for (const mobile of [false, true]) {
  test(`collapses, restores, and dismisses bulk results on ${mobile ? "mobile" : "desktop"}`, async ({ page, request }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const data = await fixture(request);
    await mockAgents(page, data);
    await page.route(`**/local/conversations/${data.primary.id}/agents/start-all`, (route) => route.fulfill({ json: bulkResponse(data) }));
    await launch(page, request, data);
    if (mobile) await page.getByRole("button", { name: "Show participants" }).click();
    await startAll(page);
    const results = page.getByRole("status").filter({ hasText: "Bulk action complete" });
    await expect(results).toContainText("not configured");
    await expect(results.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await results.getByRole("button", { name: "Hide bulk results" }).click();
    await expect(results.getByRole("list")).toBeHidden();
    await expect(results.getByRole("button", { name: "Show bulk results" })).toHaveAttribute("aria-expanded", "false");
    await results.getByRole("button", { name: "Show bulk results" }).click();
    await expect(results.getByRole("list")).toBeVisible();
    await results.getByRole("button", { name: "Dismiss bulk results" }).click();
    await expect(results).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Start ${data.agent.displayName}`, exact: true })).toHaveCount(0);
    const agentActions = page.getByRole("button", { name: `Open actions for ${data.agent.displayName}` });
    await agentActions.click();
    await expect(page.getByRole("button", { name: "Start session", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(agentActions).toBeFocused();
    // The next operation shows fresh feedback even after the previous panel was dismissed.
    await startAll(page);
    await expect(results.getByRole("list")).toBeVisible();
  });
}

test("starts one agent from its popup, dismisses repeat errors, and guards pending actions", async ({ page, request }) => {
  const data = await fixture(request);
  let state: LocalConversationAgent["state"] = "unbound";
  await mockAgents(page, data, () => state);
  let fail = true;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}/start`, async (route) => {
    calls += 1;
    if (fail) return route.fulfill({ status: 503, json: { error: "Start unavailable" } });
    await gate;
    state = "idle";
    await route.fulfill({ json: { agent: localAgent(data, state) } });
  });
  await launch(page, request, data);
  const actions = page.getByRole("button", { name: `Open actions for ${data.agent.displayName}` });
  const start = page.getByRole("button", { name: "Start session", exact: true });
  await expect(page.getByRole("button", { name: `Start ${data.agent.displayName}`, exact: true })).toHaveCount(0);
  await expect(start).toHaveCount(0);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await actions.click();
    await start.click();
    await expect(page.getByRole("alert")).toContainText("Start unavailable");
    await page.getByRole("button", { name: "Dismiss agent action error" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(actions).toBeEnabled();
  }
  fail = false;
  await actions.click();
  await start.click();
  await expect(start).toHaveCount(0);
  await expect(actions).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open participant actions" })).toBeDisabled();
  release();
  await expect(page.getByTitle("Runtime: Idle")).toBeVisible();
  await expect(actions).toBeEnabled();
  await actions.click();
  await expect(start).toHaveCount(0);
  expect(calls).toBe(3);
});

for (const initialState of ["disabled", "offline"] as const) {
  test(`starting a ${initialState} agent is labelled Start session and keeps replacement confirmation`, async ({ page, request }) => {
    const data = await fixture(request);
    let state: LocalConversationAgent["state"] = initialState;
    await mockAgents(page, data, () => state);
    let calls = 0;
    let fail = true;
    await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}/replace`, (route) => {
      calls += 1;
      if (fail) return route.fulfill({ status: 503, json: { error: "Restart unavailable" } });
      state = "idle";
      return route.fulfill({ json: { agent: localAgent(data, state) } });
    });
    await launch(page, request, data);
    const actions = page.getByRole("button", { name: `Open actions for ${data.agent.displayName}` });
    const openConfirmation = async () => {
      await actions.click();
      await expect(page.getByRole("button", { name: "New session", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Start session", exact: true }).click();
    };
    await expect(page.getByRole("button", { name: "Start session", exact: true })).toHaveCount(0);
    await openConfirmation();
    const confirmation = page.getByRole("dialog");
    await expect(confirmation).toContainText("private Runtime transcript will reset");
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(actions).toBeFocused();
    expect(calls).toBe(0);
    await openConfirmation();
    await confirmation.getByRole("button", { name: "Start session", exact: true }).click();
    await expect(confirmation.getByRole("alert")).toContainText("Restart unavailable");
    await confirmation.getByRole("button", { name: "Dismiss error", exact: true }).click();
    await expect(confirmation.getByRole("alert")).toHaveCount(0);
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await openConfirmation();
    fail = false;
    await confirmation.getByRole("button", { name: "Start session", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(page.getByTitle("Runtime: Idle")).toBeVisible();
    expect(calls).toBe(2);
  });
}

test("clears channel feedback on navigation and ignores a late bulk response from the previous chat", async ({ page, request }) => {
  const data = await fixture(request);
  await mockAgents(page, data);
  let fail = false;
  let delay = false;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/local/conversations/${data.primary.id}/agents/start-all`, async (route) => {
    calls += 1;
    if (fail) return route.fulfill({ status: 503, json: { error: "Bulk unavailable" } });
    if (delay) await gate;
    await route.fulfill({ json: bulkResponse(data) });
  });
  await launch(page, request, data);
  const results = page.getByRole("status").filter({ hasText: "Bulk action complete" });
  const navigate = async (conversation: ConversationMetadata) => {
    await page.getByRole("link", { name: new RegExp(`^${conversation.name}`) }).first().click();
    await expect(page.getByRole("heading", { name: `#${conversation.name}` })).toBeVisible();
    await expect(results).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  };
  await startAll(page);
  await expect(results).toBeVisible();
  await navigate(data.alternate);
  await navigate(data.primary);
  fail = true;
  await startAll(page);
  await expect(page.getByRole("alert")).toContainText("Bulk unavailable");
  await page.getByRole("button", { name: "Dismiss bulk action error" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await startAll(page);
  await expect(page.getByRole("alert")).toBeVisible();
  await navigate(data.alternate);
  await navigate(data.primary);
  fail = false;
  delay = true;
  await startAll(page);
  await expect.poll(() => calls).toBe(4);
  await navigate(data.alternate);
  const response = page.waitForResponse((incoming) => incoming.url().endsWith(`/conversations/${data.primary.id}/agents/start-all`));
  release();
  await response;
  await expect(results).toHaveCount(0);
  await navigate(data.primary);
});

test("sends @channel through the real API and retains legacy broadcast mentions", async ({ page, request }) => {
  const data = await fixture(request);
  const sent: CreateMessageInput[] = [];
  // Observe rather than intercept: core's textual mention validation must run.
  page.on("request", (outgoing) => {
    if (outgoing.method() === "POST" && outgoing.url().endsWith(`/conversations/${data.primary.id}/messages`)) {
      sent.push(outgoing.postDataJSON() as CreateMessageInput);
    }
  });
  await launch(page, request, data);
  const composer = page.getByRole("combobox", { name: "Conversation message" });
  await composer.fill("@cha");
  await expect(page.getByRole("option", { name: /@channel/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /@conversation/ })).toHaveCount(0);
  await composer.press("Enter");
  await expect(composer).toHaveValue("@channel ");
  await composer.pressSequentially("Broadcast check");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  const broadcast = page.getByRole("article").filter({ has: page.getByText("@channel Broadcast check", { exact: true }) });
  await expect(broadcast).toContainText("to @channel");
  await composer.fill("@conversation Legacy broadcast check");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("article").filter({ has: page.getByText("@conversation Legacy broadcast check", { exact: true }) })).toContainText("to @channel");
  expect(sent.map(({ to }) => to)).toEqual([["@conversation"], ["@conversation"]]);
  const { messages } = await (await request.get(`${conversationsBase}/conversations/${data.primary.id}/messages?limit=1000`)).json();
  for (const input of sent) {
    expect(messages.find((message: { body: string }) => message.body === input.body)?.to).toEqual(["@conversation"]);
  }
});

test("dismissing a send error preserves the draft and retry key, and the next failure reappears", async ({ page, request }) => {
  const data = await fixture(request);
  const keys: string[] = [];
  let fail = true;
  await page.route(`**/conversations/${data.primary.id}/messages`, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]!);
    if (fail) return route.fulfill({ status: 503, json: { error: "Send unavailable" } });
    return route.fulfill({ json: { message: {
      ...route.request().postDataJSON(), id: "message-dismissed-retry", conversationId: data.primary.id,
      sequence: 100_000, createdAt: new Date().toISOString(),
    } } });
  });
  await launch(page, request, data);
  const composer = page.getByRole("combobox", { name: "Conversation message" });
  await composer.fill("Draft survives dismissal");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await composer.press("Enter");
    await expect(page.getByRole("alert")).toContainText("Your draft was preserved");
    await page.getByRole("button", { name: "Dismiss send error" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(composer).toHaveValue("Draft survives dismissal");
    await expect(page.getByRole("button", { name: "Retry same message" })).toBeVisible();
  }
  fail = false;
  await page.getByRole("button", { name: "Retry same message" }).click();
  await expect(composer).toHaveValue("");
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  await expect(page.getByRole("button", { name: "Retry same message" })).toHaveCount(0);
});

test("legacy channel handles stay direct and removing them restores roster-scoped broadcast labels", async ({ page, request }) => {
  const data = await fixture(request);
  let includeCollision = true;
  // UI-only legacy projection; real storage compatibility is covered by core HTTP tests.
  await page.route(`**/conversations/${data.primary.id}`, (route) => route.fulfill({ json: { conversation: {
    ...data.primary,
    participants: data.primary.participants
      .filter((participant) => includeCollision || participant.id !== data.agent.id)
      .map((participant) => participant.id === data.agent.id ? { ...participant, handle: "channel" } : participant),
  } } }));
  // The member remains in the Workspace after roster removal, for historical attribution.
  const payload = await (await request.get(`${conversationsBase}/workspaces/${data.workspaceId}/members`)).json();
  await page.route(`**/workspaces/${data.workspaceId}/members`, (route) => route.fulfill({
    json: { ...payload, members: payload.members.map((member: WorkspaceMember) =>
      member.identityId === data.agent.id ? { ...member, mentionHandle: "channel" } : member) },
  }));
  const sent: CreateMessageInput[] = [];
  await page.route(`**/conversations/${data.primary.id}/messages`, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const input = route.request().postDataJSON() as CreateMessageInput;
    sent.push(input);
    return route.fulfill({ json: { message: {
      ...input, id: `message-legacy-channel-${sent.length}`, conversationId: data.primary.id,
      sequence: 100_000 + sent.length, createdAt: new Date().toISOString(),
    } } });
  });
  await launch(page, request, data);
  const composer = page.getByRole("combobox", { name: "Conversation message" });
  await composer.fill("@cha");
  const option = page.getByRole("option", { name: /@channel/ });
  await expect(option).toHaveCount(1);
  await expect(option).toContainText(data.agent.displayName!);
  await composer.press("Enter");
  await composer.pressSequentially("Direct legacy agent");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  expect(sent[0]?.to).toEqual([data.agent.id]);
  await composer.fill("@conv");
  await expect(page.getByRole("option", { name: /@conversation.*Everyone allowed/ })).toBeVisible();
  await composer.press("Enter");
  await composer.pressSequentially("Explicit legacy broadcast");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  expect(sent[1]?.to).toEqual(["@conversation"]);
  await expect(page.getByRole("article").filter({ hasText: "Explicit legacy broadcast" })).toContainText("to @conversation");

  includeCollision = false;
  await page.getByRole("link", { name: new RegExp(`^${data.alternate.name}`) }).first().click();
  await expect(page.getByRole("heading", { name: `#${data.alternate.name}` })).toBeVisible();
  await page.getByRole("link", { name: new RegExp(`^${data.primary.name}`) }).first().click();
  await expect(page.getByRole("heading", { name: `#${data.primary.name}` })).toBeVisible();
  await composer.fill("@cha");
  await expect(page.getByRole("option", { name: /@channel.*Everyone allowed/ })).toBeVisible();
  await composer.press("Enter");
  await composer.pressSequentially("Broadcast after roster removal");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  expect(sent.at(-1)?.to).toEqual(["@conversation"]);
  await expect(page.getByRole("article").filter({ hasText: "Broadcast after roster removal" })).toContainText("to @channel");
});

test("agent creation avoids reserved handles and identity editing blocks both broadcast names", async ({ page, request }) => {
  const data = await fixture(request);
  for (const name of ["Channel", "Conversation"]) {
    const destination = `/app/workspaces/${data.workspaceId}/agents`;
    const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}`)).json();
    await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Add agent" }).click();
    await page.getByLabel("Display name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Create agent", exact: true }).click();
    await expect(page).not.toHaveURL(/\/agents\/new$/);
    const handle = `${name.toLowerCase()}-agent`;
    const { members } = await (await request.get(`${conversationsBase}/workspaces/${data.workspaceId}/members`)).json();
    const created = members.find((member: { mentionHandle: string }) => member.mentionHandle === handle);
    expect(created).toBeTruthy();
    await page.goto(`/app/workspaces/${data.workspaceId}/agents/${created.identityId}`, { waitUntil: "domcontentloaded" });
    const form = page.locator("form").filter({ hasText: "The name identifies the agent" });
    await expect(form.getByLabel("Mention handle")).toHaveValue(handle);
    let patches = 0;
    page.on("request", (outgoing) => {
      if (outgoing.method() === "PATCH" && outgoing.url().endsWith(`/members/${created.identityId}`)) patches += 1;
    });
    for (const reserved of ["CHANNEL", "conversation"]) {
      await form.getByLabel("Mention handle").fill(reserved);
      await expect(form.getByText("@channel and @conversation are reserved for broadcast mentions.", { exact: true })).toBeVisible();
      await expect(form.getByRole("button", { name: "Save identity" })).toBeDisabled();
      await form.getByLabel("Mention handle").press("Enter");
      expect(patches).toBe(0);
    }
    await form.getByLabel("Mention handle").fill(`${handle}-renamed`);
    await expect(form.getByRole("button", { name: "Save identity" })).toBeEnabled();
  }
});
