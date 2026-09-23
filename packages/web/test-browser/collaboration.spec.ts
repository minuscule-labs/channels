import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const conversationsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const controlBase = `http://127.0.0.1:${process.env.MINU_TEST_CONTROL_PORT ?? 58411}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

async function launchAuthenticated(
  page: Page,
  request: APIRequestContext,
  destination: string,
  actor: "owner" | "member" = "owner",
): Promise<void> {
  const response = await request.get(
    `${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}&actor=${actor}`,
  );
  expect(response.ok()).toBe(true);
  const { launchUrl } = await response.json() as { launchUrl: string };
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
}

async function openParticipantActions(page: Page, participantName: string): Promise<void> {
  await page.getByRole("button", { name: `Open actions for ${participantName}` }).first().click();
}

test("redirects an authenticated legacy Channel link to its Conversation", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as {
    conversations: Array<{ id: string }>;
  };
  const conversationId = conversations[0]!.id;

  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/channels/${conversationId}`);

  await expect(page).toHaveURL(new RegExp(`/app/workspaces/${workspaceId}/conversations/${conversationId}$`));
  await expect(page.getByLabel("Live updates live")).toBeVisible();
});

test("hides sidebar lifecycle controls from an active Workspace member", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as {
    conversations: Array<{ id: string; name: string }>;
  };
  const conversation = conversations[0]!;
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/conversations/${conversation.id}`, "member");
  await expect(page.getByRole("heading", { name: `#${conversation.name}` })).toBeVisible();
  await expect(page.getByLabel(`Conversation actions for ${conversation.name}`)).toHaveCount(0);
});

test("shows owner-only safe turn failures and opens a token-gated diagnostic", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as { workspaces: Array<{ id: string; name: string }> };
  const workspaceId = workspaces.find(({ name }) => name === "Browser Test")!.id;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as {
    conversations: Array<{ id: string; name: string }>;
  };
  const conversation = conversations.find(({ name }) => name === "browser-collaboration")!;
  await request.post(`${fixtureBase}/turn-failures?value=true`);
  try {
    const before = (await (await request.get(`${fixtureBase}/diagnostic-opens`)).json() as { count: number }).count;
    await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/conversations/${conversation.id}`);
    await expect(page.getByLabel("Recent turn failures")).toHaveCount(0);
    await page.getByRole("button", { name: "Issues: 1" }).click();
    const diagnostics = page.getByRole("dialog", { name: "Diagnostics" });
    const failures = diagnostics.getByLabel("Recent turn failures");
    await expect(failures).toContainText("Runtime request timed out");
    await expect(failures).toContainText("Builder Agent");
    await expect(failures).toContainText("2 attempts");
    await expect(failures).toContainText("Recommended: Retry request");
    await failures.getByRole("button", { name: "Open diagnostic", exact: true }).click();
    await expect(failures.getByRole("button", { name: "Diagnostic opened", exact: true })).toBeVisible();
    expect((await (await request.get(`${fixtureBase}/diagnostic-opens`)).json() as { count: number }).count).toBe(before + 1);
    expect(await failures.innerText()).not.toMatch(/trigger|binding|session|fixture-turn-failure-token/i);

    await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/conversations/${conversation.id}`, "member");
    await expect(page.getByLabel("Recent turn failures")).toHaveCount(0);
  } finally {
    await request.post(`${fixtureBase}/turn-failures?value=false`);
  }
});

test("sidebar lifecycle controls offer snooze schedules and surface a blocked settlement", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as {
    conversations: Array<{ id: string; name: string }>;
  };
  const conversation = conversations[0]!;
  await request.post(`${fixtureBase}/agent-activity?phase=running`);
  try {
    await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/conversations/${conversation.id}`);
    const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: conversation.name, exact: true }) }).first();
    const actions = row.getByLabel(`Conversation actions for ${conversation.name}`);
    await actions.click();
    const snooze = page.getByRole("button", { name: /^Snooze/ });
    expect((await snooze.boundingBox())!.x).toBeGreaterThan((await actions.boundingBox())!.x);
    await snooze.click();
    await expect(page.getByText("In 1 hour", { exact: true })).toBeVisible();
    await expect(page.getByText("In 3 hours", { exact: true })).toBeVisible();
    await expect(page.getByText(/^(This|Tomorrow) evening$/)).toBeVisible();
    await expect(page.getByText("Tomorrow", { exact: true })).toBeVisible();
    await expect(page.getByText("Next week", { exact: true })).toBeVisible();
    await expect(page.getByLabel(`Snooze ${conversation.name} until`)).toBeVisible();
    await page.getByRole("button", { name: "Settled", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("must be idle or stopped");
  } finally {
    await request.post(`${fixtureBase}/agent-activity?phase=idle`);
  }
});

test("sends idempotently, refreshes rosters, and catches up after reconnect", async ({ page, request }) => {
  const workspacesResponse = await request.get(`${conversationsBase}/workspaces`);
  const { workspaces } = await workspacesResponse.json() as { workspaces: Array<{ id: string }> };
  const workspaceId = workspaces[0]!.id;
  const conversationsResponse = await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`);
  const { conversations } = await conversationsResponse.json() as { conversations: Array<{ id: string; rosterRevision: number }> };
  const conversationId = conversations[0]!.id;
  const initialRosterRevision = conversations[0]!.rosterRevision;
  const membersResponse = await request.get(`${conversationsBase}/workspaces/${workspaceId}/members`);
  const { members } = await membersResponse.json() as {
    members: Array<{ identityId: string; mentionHandle: string }>;
  };
  const human = members.find(({ mentionHandle }) => mentionHandle === "david")!;
  const agent = members.find(({ mentionHandle }) => mentionHandle === "builder")!;

  const idempotencyKeys: string[] = [];
  const messageAuthors: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.method() === "POST" && outgoing.url().endsWith(`/conversations/${conversationId}/messages`)) {
      const key = outgoing.headers()["idempotency-key"];
      if (key) idempotencyKeys.push(key);
      const body = outgoing.postDataJSON() as { participantId?: string };
      if (body.participantId) messageAuthors.push(body.participantId);
    }
  });

  await launchAuthenticated(
    page,
    request,
    `/app/workspaces/${workspaceId}/conversations/${conversationId}`,
  );
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  await expect(page.getByRole("heading", { name: "#browser-collaboration" })).toBeVisible();
  await expect(page.getByText("Workspace: Browser Test", { exact: false })).toBeVisible();
  await expect(page.getByText("Verify the browser collaboration flow.", { exact: false })).toBeVisible();
  await expect(page.getByTitle("Runtime: Idle")).toBeVisible();
  await expect(page.getByText("@mention wakes an agent", { exact: false })).toBeVisible();
  await expect(page.getByText("Sending as @david", { exact: true })).toBeVisible();
  await expect(page.getByText("Send as", { exact: true })).toHaveCount(0);

  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: `minu.conversations.author.${workspaceId}`,
    value: agent.identityId,
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Sending as @david", { exact: true })).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Conversation message" });
  const compactHeight = await composer.evaluate((element) => element.clientHeight);
  await composer.fill(Array.from({ length: 20 }, (_, index) => `visual line ${index + 1}`).join("\n"));
  await expect.poll(() => composer.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, overflowY: getComputedStyle(element).overflowY })))
    .toMatchObject({ overflowY: "auto" });
  expect(await composer.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(340);
  await composer.fill("");
  await expect.poll(() => composer.evaluate((element) => element.clientHeight)).toBe(compactHeight);
  await composer.fill("@b");
  await expect(page.getByRole("option", { name: /@builder/ })).toBeVisible();
  await composer.press("Enter");
  await composer.pressSequentially("Browser reply.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log").getByText("@builder Browser reply.", { exact: true })).toBeVisible();
  expect(idempotencyKeys[0]).toBeTruthy();
  await expect(composer).toHaveValue("");
  await expect.poll(() => composer.evaluate((element) => element.clientHeight)).toBe(compactHeight);

  await composer.fill("First line");
  await composer.press("Control+Enter");
  await expect(composer).toHaveValue("First line\n");
  await composer.pressSequentially("Second line");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("log").getByText(/First line\s+Second line/)).toBeVisible();

  const update = await request.patch(
    `${conversationsBase}/workspaces/${workspaceId}/members/${agent.identityId}`,
    { data: { actorIdentityId: human.identityId, roleLabel: "principal builder" } },
  );
  expect(update.ok()).toBe(true);
  await expect(page.getByText("principal builder — Implements features and verifies changes.")).toBeVisible();
  await expect(page.getByText(new RegExp(`roster ${initialRosterRevision + 1}$`))).toBeVisible();

  const disconnect = await request.post(`${fixtureBase}/disconnect`);
  expect(disconnect.ok()).toBe(true);
  await expect(page.getByLabel("Live updates disconnected")).toBeVisible({ timeout: 10_000 });

  await composer.fill("@builder Preserve and retry this draft.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your draft was preserved");
  await expect(composer).toHaveValue("@builder Preserve and retry this draft.");
  const failedKey = idempotencyKeys.at(-1);

  await expect(page.getByLabel("Live updates live")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Retry same message" }).click();
  await expect(page.getByRole("log").getByText("@builder Preserve and retry this draft.", { exact: true })).toBeVisible();
  expect(idempotencyKeys.at(-1)).toBe(failedKey);
  await expect(composer).toHaveValue("");
  await expect(page.getByText("Message created while the browser was offline.", { exact: true })).toBeVisible();
  expect(messageAuthors.length).toBeGreaterThan(0);
  expect(new Set(messageAuthors)).toEqual(new Set([human.identityId]));
});

test("keeps Workspace navigation responsive with more Conversations than the browser connection limit", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const primary = workspaces.find(({ name }) => name === "Browser Test")!;
  const secondary = workspaces.find(({ name }) => name === "Browser Secondary")!;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${primary.id}/conversations`)).json() as {
    conversations: Array<{ id: string; name: string }>;
  };
  expect(conversations.length).toBeGreaterThan(6);
  const active = conversations.find(({ name }) => name === "browser-collaboration")!;
  const eventRequests: string[] = [];
  page.on("request", (outgoing) => {
    const url = new URL(outgoing.url());
    if (url.pathname.endsWith("/events")) eventRequests.push(`${url.pathname}${url.search}`);
  });

  await launchAuthenticated(page, request, `/app/workspaces/${primary.id}/conversations/${active.id}`);
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  await expect.poll(() => eventRequests.some((url) => url.startsWith("/conversations/events?"))).toBe(true);
  expect(new Set(eventRequests.filter((url) => /^\/conversations\/[^/]+\/events$/.test(url))))
    .toEqual(new Set([`/conversations/${active.id}/events`]));

  const fetchDuration = await page.evaluate(async () => {
    const startedAt = performance.now();
    const response = await fetch("/workspaces");
    if (!response.ok) throw new Error(`Workspace request failed (${response.status})`);
    return performance.now() - startedAt;
  });
  expect(fetchDuration).toBeLessThan(1_000);

  await page.getByLabel("Selected Workspace").first().selectOption(secondary.id);
  await expect(page.getByRole("heading", { name: "#secondary-collaboration" })).toBeVisible({ timeout: 2_000 });
  await page.getByLabel("Selected Workspace").first().selectOption(primary.id);
  await expect(page.getByRole("heading", { name: "#browser-collaboration" })).toBeVisible({ timeout: 2_000 });
});

test("tracks durable unread mentions and plays only opt-in contextual sound", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as {
    conversations: Array<{ id: string; name: string }>;
  };
  const conversationId = conversations[0]!.id;
  await page.addInitScript(() => {
    Object.defineProperty(window, "__soundCount", { value: 0, writable: true });
    class TestAudioContext {
      currentTime = 0;
      destination = {};
      createGain() { return { gain: { value: 0 }, connect: () => this.destination }; }
      createOscillator() {
        return {
          frequency: { value: 0 },
          connect: () => ({ connect: () => this.destination }),
          start: () => { (window as unknown as { __soundCount: number }).__soundCount += 1; },
          stop: () => undefined,
          addEventListener: (_name: string, listener: () => void) => listener(),
        };
      }
      close() { return Promise.resolve(); }
    }
    Object.defineProperty(window, "AudioContext", { value: TestAudioContext, configurable: true });
  });
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/conversations/${conversationId}`);
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(0);

  await page.getByRole("link", { name: "Agents" }).first().click();
  await request.post(`${fixtureBase}/peer-message?mention=true&body=Unread%20mention`);
  const unread = page.getByLabel(/1 unread message, 1 direct mention/).first();
  await expect(unread).toBeVisible({ timeout: 10_000 });
  await expect(page.getByLabel("Selected Workspace").first().locator("option:checked")).toContainText("1 unread");
  await expect(page).toHaveTitle(/\(1\) MinuChannels/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(0);

  const sound = page.getByLabel("Notification sound").first();
  await sound.selectOption("mentions");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(0);
  await request.post(`${fixtureBase}/peer-message?duplicate=true&body=Agent%20reply`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount), { timeout: 10_000 }).toBe(2);

  await page.getByRole("link", { name: /browser-collaboration/ }).first().click();
  await expect(page.getByText("Agent reply", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/unread message/)).toHaveCount(0);
  await expect(page).toHaveTitle("MinuChannels");
  await page.getByLabel("Notification sound").first().selectOption("off");
  await page.getByRole("link", { name: "Agents" }).first().click();
  await request.post(`${fixtureBase}/peer-message?body=Muted%20agent%20reply`);
  await expect(page.getByLabel(/1 unread message/).first()).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(2);
  await page.getByRole("link", { name: /browser-collaboration/ }).first().click();
  await expect(page.getByText("Muted agent reply", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/unread message/)).toHaveCount(0);

  await page.getByRole("link", { name: "Agents" }).first().click();
  await request.post(`${fixtureBase}/peer-message?author=human&body=Own%20message`);
  await page.waitForTimeout(5_500);
  await expect(page.getByLabel(/unread message/)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(2);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Notification sound").first()).toHaveValue("off");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(0);
});

test("tracks an inactive visited Workspace incrementally with cursor-bounded requests", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const primary = workspaces.find(({ name }) => name === "Browser Test")!;
  const secondary = workspaces.find(({ name }) => name === "Browser Secondary")!;
  const { conversations: secondaryConversations } = await (await request.get(`${conversationsBase}/workspaces/${secondary.id}/conversations`)).json() as {
    conversations: Array<{ id: string }>;
  };
  const secondaryConversationId = secondaryConversations[0]!.id;
  const messageRequests: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.url().includes(`/conversations/${secondaryConversationId}/messages`)) messageRequests.push(outgoing.url());
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "__soundCount", { value: 0, writable: true });
    class TestAudioContext {
      currentTime = 0;
      destination = {};
      createGain() { return { gain: { value: 0 }, connect: () => this.destination }; }
      createOscillator() {
        return {
          frequency: { value: 0 }, connect: () => ({ connect: () => this.destination }),
          start: () => { (window as unknown as { __soundCount: number }).__soundCount += 1; },
          stop: () => undefined, addEventListener: (_name: string, listener: () => void) => listener(),
        };
      }
    }
    Object.defineProperty(window, "AudioContext", { value: TestAudioContext, configurable: true });
  });
  await launchAuthenticated(page, request, `/app/workspaces/${secondary.id}/conversations/${secondaryConversationId}`);
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  messageRequests.length = 0;
  await page.getByLabel("Selected Workspace").first().selectOption(primary.id);
  await expect(page.getByRole("heading", { name: "#browser-collaboration" })).toBeVisible();
  await page.getByLabel("Notification sound").first().selectOption("all");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(0);

  await request.post(`${fixtureBase}/disconnect?workspace=inactive`);
  await expect(page.getByLabel("Selected Workspace").first().locator(`option[value="${secondary.id}"]`)).toContainText("1 unread", { timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(0);
  await request.post(`${fixtureBase}/peer-message?workspace=inactive&body=Subsequent%20live`);
  await expect(page.getByLabel("Selected Workspace").first().locator(`option[value="${secondary.id}"]`)).toContainText("2 unread", { timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(2);
  await expect(page).toHaveTitle(/\(2\) MinuChannels/);
  await expect.poll(() => messageRequests.some((requestUrl) => {
    const url = new URL(requestUrl);
    return url.searchParams.has("afterSequence") && url.searchParams.get("limit") === "100";
  })).toBe(true);
  expect(messageRequests.filter((requestUrl) => !new URL(requestUrl).searchParams.has("limit"))).toHaveLength(0);
  expect(messageRequests.filter((requestUrl) => new URL(requestUrl).searchParams.has("limit"))
    .every((requestUrl) => new URL(requestUrl).searchParams.get("limit") === "100")).toBe(true);
});

test("resets near-end and unseen state across parameter-only Conversation navigation", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as { workspaces: Array<{ id: string; name: string }> };
  const workspaceId = workspaces.find(({ name }) => name === "Browser Test")!.id;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as {
    conversations: Array<{ id: string; name: string }>;
  };
  const primary = conversations.find(({ name }) => name === "browser-collaboration")!;
  const alternate = conversations.find(({ name }) => name === "alternate-collaboration")!;
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/conversations/${primary.id}`);
  await request.post(`${fixtureBase}/peer-message?count=35&body=Navigation%20scroll`);
  await expect(page.getByText("Navigation scroll 35", { exact: true })).toBeVisible();
  const timeline = page.locator(".minu-scroll.absolute");
  await timeline.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await page.getByRole("link", { name: "alternate-collaboration" }).first().click();
  await expect(page.getByRole("heading", { name: "#alternate-collaboration" })).toBeVisible();
  await request.post(`${fixtureBase}/peer-message?conversation=alternate&body=Alternate%20fresh`);
  await expect(page.getByText("Alternate fresh", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /new message/ })).toHaveCount(0);
  await expect(page.getByLabel(/unread message/)).toHaveCount(0);
  expect(alternate.id).toBeTruthy();
});

test("advances the durable read cursor only when a real visible timeline is near its end", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = workspaces[0]!.id;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as { conversations: Array<{ id: string }> };
  const conversationId = conversations[0]!.id;
  const { members } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/members`)).json() as {
    members: Array<{ identityId: string; mentionHandle: string }>;
  };
  const humanId = members.find(({ mentionHandle }) => mentionHandle === "david")!.identityId;
  await page.addInitScript(() => {
    (window as unknown as { __soundCount: number }).__soundCount = 0;
    class TestAudioContext {
      currentTime = 0; destination = {};
      createGain() { return { gain: { value: 0 }, connect: () => this.destination }; }
      createOscillator() { return {
        frequency: { value: 0 }, connect: () => ({ connect: () => this.destination }),
        start: () => { (window as unknown as { __soundCount: number }).__soundCount += 1; },
        stop: () => undefined, addEventListener: (_name: string, listener: () => void) => listener(),
      }; }
      close() { return Promise.resolve(); }
    }
    Object.defineProperty(window, "AudioContext", { value: TestAudioContext, configurable: true });
  });
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/conversations/${conversationId}`);
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  await page.getByLabel("Notification sound").first().selectOption("mentions");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(0);
  await request.post(`${fixtureBase}/peer-message?count=35&body=Scroll%20fixture`);
  await expect(page.getByText("Scroll fixture 35", { exact: true })).toBeVisible();
  const cursorKey = `minu-channels:last-read:${humanId}:${conversationId}`;
  await expect.poll(() => page.evaluate((key) => Number(localStorage.getItem(key) ?? 0), cursorKey)).toBeGreaterThan(0);

  const timeline = page.locator(".minu-scroll.absolute");
  await expect.poll(() => timeline.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await timeline.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(100);
  await request.post(`${fixtureBase}/peer-message?body=Held%20unread`);
  await expect(page.getByRole("button", { name: "1 new message" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(2);
  const heldCursor = await page.evaluate((key) => Number(localStorage.getItem(key) ?? 0), cursorKey);
  await page.waitForTimeout(250);
  expect(await page.evaluate((key) => Number(localStorage.getItem(key) ?? 0), cursorKey)).toBe(heldCursor);

  await page.getByRole("button", { name: "1 new message" }).click();
  await expect.poll(() => page.evaluate((key) => Number(localStorage.getItem(key) ?? 0), cursorKey)).toBeGreaterThan(heldCursor);
});

test("hides identity-scoped notification preferences when session capability is unavailable", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = workspaces[0]!.id;
  await page.route("**/local/session", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Session unavailable" }),
  }));
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/agents`);
  await expect(page.getByLabel("Selected Workspace").first()).toBeVisible();
  await expect(page.getByLabel("Notification sound")).toHaveCount(0);
});

test("summarizes Conversation-wide agent activity below the composer", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as { workspaces: Array<{ id: string; name: string }> };
  const workspaceId = workspaces.find(({ name }) => name === "Browser Test")!.id;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as {
    conversations: Array<{ id: string; name: string }>;
  };
  const conversationId = conversations.find(({ name }) => name === "browser-collaboration")!.id;
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/conversations/${conversationId}`);
  await request.post(`${fixtureBase}/agent-activity?phase=running&queued=2`);
  const strip = page.getByRole("region", { name: "Conversation agent activity" });
  await expect(strip).toContainText(/@builder is working · 1m \d+s · 2 queued/, { timeout: 10_000 });
  await expect(page.getByTitle("Runtime: Working · activity unavailable")).toBeVisible();
  await expect(strip).not.toContainText(/Verify the browser collaboration flow|message_|tool|prompt|error/i);
  expect((await strip.boundingBox())!.y).toBeGreaterThan((await page.getByRole("combobox", { name: "Conversation message" }).boundingBox())!.y);

  await request.post(`${fixtureBase}/agent-activity?phase=running&queued=2&exact=false`);
  await expect(strip).toContainText("At least 2 queued", { timeout: 10_000 });
  await request.post(`${fixtureBase}/agent-activity?phase=running&queued=0&exact=false`);
  await expect(strip).toContainText("Checking backlog", { timeout: 10_000 });
  await request.post(`${fixtureBase}/agent-activity?phase=using_tools&queued=1`);
  await expect(strip).toContainText(/@builder is using tools.*1 queued/, { timeout: 10_000 });
  await request.post(`${fixtureBase}/agent-activity?phase=responding&queued=1`);
  await expect(strip).toContainText(/@builder is responding.*1 queued/, { timeout: 10_000 });
  await request.post(`${fixtureBase}/agent-activity?phase=retrying&queued=1`);
  await expect(strip).toContainText(/@builder is retrying \(attempt 2\).*1 queued/, { timeout: 10_000 });
  await openParticipantActions(page, "Builder Agent");
  await page.getByRole("button", { name: "Cancel current", exact: true }).click();
  await expect(strip).toContainText("@builder is canceling", { timeout: 10_000 });
  await request.post(`${fixtureBase}/agent-activity?phase=idle`);
  await expect(strip).toHaveCount(0, { timeout: 10_000 });
});

test("reconnects an existing reachable session and exposes only safe diagnostic capabilities", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as { workspaces: Array<{ id: string; name: string }> };
  const workspaceId = workspaces.find(({ name }) => name === "Browser Test")!.id;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as {
    conversations: Array<{ id: string; name: string }>;
  };
  const conversationId = conversations.find(({ name }) => name === "browser-collaboration")!.id;
  const lifecycleRequests: string[] = [];
  page.on("request", (outgoing) => {
    if (/\/(reconnect|replace)$/.test(new URL(outgoing.url()).pathname)) lifecycleRequests.push(new URL(outgoing.url()).pathname);
  });
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/conversations/${conversationId}`);
  await request.post(`${fixtureBase}/detach-agent`);
  await expect(page.getByTitle("Runtime: Disconnected")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Open actions for Builder Agent" }).first()).toBeVisible();
  await openParticipantActions(page, "Builder Agent");
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New session", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByText("Diagnostics").click();
  await expect(page.getByText("disconnected", { exact: true })).toBeVisible();
  await expect(page.locator("dt", { hasText: "Safe activity" }).locator("+ dd")).toHaveText("Unavailable");
  await expect(page.locator("dt", { hasText: "Interrupt" }).locator("+ dd")).toHaveText("Available");
  await expect(page.locator("dt", { hasText: "Reconnect existing" }).locator("+ dd")).toHaveText("Available");
  await expect(page.locator("dt", { hasText: "Open diagnostic" }).locator("+ dd")).toHaveText("Available");
  expect(await page.locator("body").innerText()).not.toMatch(/private-browser-session|runtimeSessionId|\/tmp|SECRET_DIAGNOSTIC/);

  await request.post(`${fixtureBase}/runtime-capabilities?mode=failed`);
  await expect(page.getByText("Not verified", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  expect(await page.locator("body").innerText()).not.toContain("SECRET_RUNTIME_CAPABILITY_TRANSPORT");
  await openParticipantActions(page, "Builder Agent");
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await request.post(`${fixtureBase}/runtime-capabilities?mode=available`);

  await openParticipantActions(page, "Builder Agent");
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByTitle("Runtime: Idle")).toBeVisible();
  expect(lifecycleRequests).toHaveLength(1);
  expect(lifecycleRequests[0]).toMatch(new RegExp(`^/local/conversations/${conversationId}/agents/[^/]+/reconnect$`));
  expect(lifecycleRequests.some((path) => path.endsWith("/replace"))).toBe(false);

  await request.post(`${fixtureBase}/detach-agent`);
  await request.post(`${fixtureBase}/runtime-reachable?value=false`);
  await expect(page.getByTitle("Runtime: Offline")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Open diagnostic", exact: true })).toHaveCount(0);
  await openParticipantActions(page, "Builder Agent");
  await expect(page.getByRole("button", { name: "New session", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Resume/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await request.post(`${fixtureBase}/runtime-reachable?value=true`);
  await expect(page.getByTitle("Runtime: Offline")).toBeVisible({ timeout: 10_000 });
  await openParticipantActions(page, "Builder Agent");
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByTitle("Runtime: Idle")).toBeVisible();
});

test("runs Conversation-scoped bulk lifecycle with one confirmation and visible partial results", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { conversations } = await (await request.get(
    `${conversationsBase}/workspaces/${workspaceId}/conversations`,
  )).json() as { conversations: Array<{ id: string }> };
  const conversationId = conversations[0]!.id;
  const { conversation: conversationMetadata } = await (await request.get(
    `${conversationsBase}/conversations/${conversationId}`,
  )).json() as { conversation: {
    participants: Array<Record<string, unknown> & { id: string }>;
    [key: string]: unknown;
  } };
  const builder = conversationMetadata.participants.find(({ type }) => type === "agent")!;
  const unboundId = "agent-unbound-browser";
  await page.route(`**/conversations/${conversationId}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ conversation: {
      ...conversationMetadata,
      participants: [...conversationMetadata.participants, {
        id: unboundId,
        type: "agent",
        displayName: "Unbound Agent",
        handle: "unbound-agent",
        status: "active",
      }],
    } }),
  }));
  await page.route(`**/local/conversations/${conversationId}/agents`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      protocolVersion: 17,
      conversationId,
      agents: [
        {
          workspaceId, conversationId, identityId: builder.id, state: "idle",
          capabilities: { start: false, replace: false, stop: true, steer: false, interrupt: false, reconnect: false },
        },
        {
          workspaceId, conversationId, identityId: unboundId, state: "unbound",
          capabilities: { start: true, replace: false, stop: false, steer: false, interrupt: false, reconnect: false },
        },
      ],
    }),
  }));
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  let requests = 0;
  await page.route(`**/local/conversations/${conversationId}/agents/stop-all`, async (route) => {
    requests += 1;
    await requestGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        protocolVersion: 17,
        conversationId,
        results: [
          { identityId: builder.id, outcome: "stopped" },
          { identityId: unboundId, outcome: "skipped", reason: "uncertain" },
        ],
      }),
    });
  });
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/conversations/${conversationId}`);
  await expect(page.getByRole("heading", { name: "Participants" })).toBeVisible();
  const unboundRow = page.getByRole("listitem").filter({
    has: page.getByText("@unbound-agent · agent", { exact: true }),
  }).first();
  await expect(unboundRow.getByText("Unbound Agent", { exact: true })).toBeVisible();
  await expect(unboundRow.getByTitle("Runtime: Not started")).toBeVisible();
  const rowText = await unboundRow.textContent() ?? "";
  expect(rowText.indexOf("Unbound Agent")).toBeLessThan(rowText.indexOf("@unbound-agent · agent"));
  expect(rowText.indexOf("@unbound-agent · agent")).toBeLessThan(rowText.indexOf("Not started"));
  const unboundActions = page.getByRole("button", { name: "Open actions for Unbound Agent" }).first();
  await unboundActions.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(unboundActions).toBeFocused();
  const actions = page.getByRole("button", { name: "Open participant actions" });
  await actions.click();
  await expect(page.getByRole("button", { name: "Start eligible agents (1)" })).toBeVisible();
  await page.getByRole("button", { name: "Stop active agents (1)" }).click();
  const confirmation = page.getByRole("dialog");
  await expect(confirmation).toContainText("Active work will be interrupted");
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirmation.getByRole("button", { name: "Stop active agents" }).click();
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(confirmation.getByRole("button", { name: "Stop active agents" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeVisible();
  releaseRequest();
  await expect(page.getByRole("status").filter({ hasText: "Bulk action complete" })).toContainText("stopped");
  await expect(page.getByRole("status").filter({ hasText: "Bulk action complete" })).toContainText("status uncertain");
  await expect(actions).toBeFocused();
  expect(requests).toBe(1);
});

test("hides bulk lifecycle controls when the local capability is unavailable", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { conversations } = await (await request.get(
    `${conversationsBase}/workspaces/${workspaceId}/conversations`,
  )).json() as { conversations: Array<{ id: string }> };
  const conversationId = conversations[0]!.id;
  await page.route("**/local/capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      protocolVersion: 17,
      features: {
        currentSession: true,
        conversationAgentStatus: true,
        workspaceConfigRead: true,
        workspaceConfigWrite: true,
        conversationWorkingFolders: true,
        agentCreate: false,
        agentRuntimeOptions: true,
        agentSkills: true,
        agentStart: true,
        agentReplace: true,
        agentStop: true,
        agentBulkStart: false,
        agentBulkStop: false,
        steer: false,
        interrupt: true,
        reconnect: false,
      },
    }),
  }));
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/conversations/${conversationId}`);
  await expect(page.getByRole("heading", { name: "Participants" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open participant actions" })).toHaveCount(0);
  await openParticipantActions(page, "Builder Agent");
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toBeVisible();
});

test("shows saved instructions and Runtime selections only on authenticated agent detail", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const workspace = workspaces[0]!;
  await launchAuthenticated(page, request, "/");

  await page.getByRole("button", { name: `Configure Workspace ${workspace.name}` }).click();
  const dialog = page.getByRole("dialog", { name: `${workspace.name} configuration` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Signed in as @david · owner");

  const rootValue = "/tmp";
  await dialog.getByLabel("Source location", { exact: true }).fill(rootValue);
  const rootResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url().endsWith(`/local/workspaces/${workspace.id}/config`));
  await dialog.getByRole("button", { name: "Save source" }).click();
  const rootResponse = await rootResponsePromise;
  expect(rootResponse.ok()).toBe(true);
  expect(await rootResponse.text()).not.toContain(rootValue);
  await expect(dialog.getByText("Source: configured", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Replace source location", { exact: true })).toHaveValue("");

  await dialog.getByRole("button", { name: "Close Workspace configuration" }).click();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("heading", { name: `${workspace.name} agents` })).toBeVisible();
  await page.getByRole("link", { name: /Builder Agent/ }).click();
  await expect(page.getByRole("heading", { name: "Builder Agent", exact: true, level: 1 })).toBeVisible();
  const agentCard = page.locator("article").filter({ hasText: "Builder Agent" });
  const identityForm = agentCard.locator("form").filter({ hasText: "The name identifies the agent" });
  await expect(identityForm.getByLabel("Name", { exact: true })).toHaveValue("Builder Agent");
  await expect(identityForm.getByLabel("Mention handle")).toHaveValue("builder");

  const agentForm = agentCard.locator("form").filter({ hasText: "Private launch profile" });
  const runtimeValue = "pi-private-browser";
  const personaValue = "SECRET BROWSER PERSONA";
  await agentForm.getByLabel("Agent instructions", { exact: true }).fill(personaValue);
  await agentForm.getByRole("tab", { name: "Runtime" }).click();
  await agentForm.getByLabel("Harness", { exact: true }).fill(runtimeValue);
  const agentResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url().includes(`/local/workspaces/${workspace.id}/agents/`));
  await agentForm.getByRole("button", { name: "Save launch profile" }).click();
  const agentResponse = await agentResponsePromise;
  expect(agentResponse.ok()).toBe(true);
  const agentResponseBody = await agentResponse.text();
  expect(agentResponseBody).toContain(runtimeValue);
  expect(agentResponseBody).not.toContain(personaValue);
  await expect(agentForm.getByText(`Harness: ${runtimeValue}`, { exact: true })).toBeVisible();
  await expect(agentForm.getByText("Agent instructions: configured", { exact: true })).toBeVisible();
  await expect(agentForm.getByLabel("Harness", { exact: true })).toHaveValue(runtimeValue);
  await agentForm.getByRole("tab", { name: "General" }).click();
  await expect(page.getByRole("textbox", { name: "Agent instructions", exact: true })).toHaveValue(personaValue);
  await page.reload();
  const activeAgentForm = page.locator("article").filter({ hasText: "Builder Agent" })
    .locator("form").filter({ hasText: "Private launch profile" });
  await expect(page.getByRole("textbox", { name: "Agent instructions", exact: true })).toHaveValue(personaValue);
  await activeAgentForm.getByRole("tab", { name: "Runtime" }).click();
  await expect(activeAgentForm.getByLabel("Harness", { exact: true })).toHaveValue(runtimeValue);

  const providerSelect = activeAgentForm.getByRole("combobox", { name: "Provider", exact: true });
  const modelSelect = activeAgentForm.getByRole("combobox", { name: "Model", exact: true });
  const reasoningSelect = activeAgentForm.getByRole("combobox", { name: "Reasoning", exact: true });
  await expect(providerSelect).toBeEnabled({ timeout: 10_000 });
  await expect(providerSelect).toHaveValue("openai-codex");
  await expect(modelSelect).toHaveValue(JSON.stringify(["openai-codex", "gpt-5.6-sol"]));
  await expect(reasoningSelect).toHaveValue("medium");
  await expect(activeAgentForm.getByText(/default/i)).toHaveCount(0);
  await activeAgentForm.getByText("Manage available provider models", { exact: true }).click();
  await activeAgentForm.getByLabel("Enable Browser Fast").uncheck();
  const modelPolicyResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && response.url().includes(`/local/workspaces/${workspace.id}/agents/`));
  await activeAgentForm.getByRole("button", { name: "Save available models" }).click();
  expect((await modelPolicyResponsePromise).ok()).toBe(true);
  await providerSelect.selectOption("openai");
  await expect(modelSelect.getByRole("option", { name: "Browser Fast" })).toHaveCount(0);
  await expect(modelSelect).toHaveValue(JSON.stringify(["openai", "gpt-browser-deep"]));
  await expect(reasoningSelect).toHaveValue("medium");
  const launchProfileResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url().includes(`/local/workspaces/${workspace.id}/agents/`));
  await activeAgentForm.getByRole("button", { name: "Save launch profile" }).click();
  const launchProfileResponse = await launchProfileResponsePromise;
  expect(launchProfileResponse.ok()).toBe(true);
  const launchProfileBody = await launchProfileResponse.text();
  expect(launchProfileBody).not.toContain("gpt-browser-deep");
  expect(launchProfileBody).not.toContain("medium");
  await expect(activeAgentForm.getByText("Model: Browser Deep", { exact: true })).toBeVisible();
  await expect(activeAgentForm.getByText("Reasoning: medium", { exact: true })).toBeVisible();
  await page.reload();
  await activeAgentForm.getByRole("tab", { name: "Runtime" }).click();
  await expect(activeAgentForm.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue("openai");
  await expect(activeAgentForm.getByRole("combobox", { name: "Model", exact: true }))
    .toHaveValue(JSON.stringify(["openai", "gpt-browser-deep"]));
  await expect(activeAgentForm.getByRole("combobox", { name: "Reasoning", exact: true })).toHaveValue("medium");
  await activeAgentForm.getByRole("tab", { name: "Skills" }).click();
  await expect(activeAgentForm.getByRole("checkbox", { name: /review Review changes for correctness/ })).toBeChecked();
});

test("lists agents, opens a detail page, and adds an agent", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const workspace = workspaces[0]!;
  await launchAuthenticated(page, request, `/app/workspaces/${workspace.id}/agents`);

  await expect(page.getByRole("link", { name: /Builder Agent/ })).toBeVisible();
  await page.getByRole("link", { name: "Add agent" }).click();
  await expect(page.getByRole("heading", { name: "New Workspace agent" })).toBeVisible();
  await expect(page.getByLabel("Mention handle")).toHaveCount(0);
  await page.getByLabel("Display name").fill("Browser Review Agent");
  await page.getByLabel("Agent instructions").fill("Review proposed plans carefully.");
  await page.getByRole("tab", { name: "Runtime" }).click();
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("openai");
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption({ label: "Browser Deep" });
  await page.getByRole("combobox", { name: "Reasoning", exact: true }).selectOption("high");
  await page.getByRole("tab", { name: "Skills" }).click();
  await expect(page.getByRole("checkbox", { name: /review Review changes for correctness/ })).toBeChecked();
  await page.getByRole("checkbox", { name: /handoff Prepare a concise handoff/ }).uncheck();
  await page.getByRole("button", { name: "Create agent" }).click();

  await expect(page.getByRole("heading", { name: /agents$/, exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Agent “Browser Review Agent” created");
  await page.getByRole("button", { name: "Edit agent" }).click();
  await expect(page.getByRole("heading", { name: "Browser Review Agent", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Model: Browser Deep", { exact: true })).toBeVisible();
  await expect(page.getByText("Reasoning: high", { exact: true })).toBeVisible();
  await expect(page.getByText("Skills configured for new sessions (1): configured", { exact: true })).toBeVisible();
  await expect(page.getByText("Agent instructions: configured", { exact: true })).toBeVisible();
  const createdIdentityForm = page.locator("form").filter({ hasText: "The name identifies the agent" });
  await createdIdentityForm.getByLabel("Name", { exact: true }).fill("Browser Lead Review Agent");
  await createdIdentityForm.getByRole("button", { name: "Save identity" }).click();
  await expect(page.getByRole("heading", { name: "Browser Lead Review Agent", exact: true, level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "All agents" }).click();
  await expect(page.getByRole("link", { name: /Browser Lead Review Agent/ })).toBeVisible();
});

test("repairs a failed initial agent launch profile without creating a duplicate", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspace = workspaces[0]!;
  await launchAuthenticated(page, request, `/app/workspaces/${workspace.id}/agents`);

  let rejectedInitialConfiguration = false;
  await page.route("**/local/workspaces/*/agents/*/config", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    if (!rejectedInitialConfiguration) {
      rejectedInitialConfiguration = true;
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Harness unavailable" }) });
      return;
    }
    const identityId = route.request().url().match(/\/agents\/([^/]+)\/config$/)?.[1]!;
    const input = JSON.parse(route.request().postData() ?? "{}") as { runtimeAdapter?: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        protocolVersion: 17,
        workspaceId: workspace.id,
        rootConfigured: true,
        notesFolderConfigured: false,
        agents: [{
          identityId,
          configured: Boolean(input.runtimeAdapter),
          personaConfigured: true,
          runtimeConfigured: Boolean(input.runtimeAdapter),
          ...(input.runtimeAdapter ? { runtimeAdapter: input.runtimeAdapter } : {}),
          modelConfigured: false,
          reasoningConfigured: false,
          skillsConfigured: false,
          selectedSkillCount: 0,
          status: input.runtimeAdapter ? "active" : "unconfigured",
          boundConversationCount: 0,
          changesApplyToNewSessions: true,
        }],
      }),
    });
  });

  await page.getByRole("link", { name: "Add agent" }).click();
  await page.getByLabel("Display name").fill("Repairable Agent");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("alert")).toContainText("Agent created, but its launch profile needs attention: Harness unavailable");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Repairable Agent", exact: true, level: 1 })).toBeVisible();

  const launchProfile = page.locator("form").filter({ hasText: "Private launch profile" });
  await launchProfile.getByRole("tab", { name: "General" }).click();
  await launchProfile.getByLabel("Agent instructions", { exact: true }).fill("Incomplete repair");
  const incompleteResponse = page.waitForResponse((response) => response.request().method() === "PATCH"
    && response.url().includes(`/local/workspaces/${workspace.id}/agents/`));
  await launchProfile.getByRole("button", { name: "Save launch profile" }).click();
  expect((await incompleteResponse).ok()).toBe(true);
  await expect(page.getByRole("alert")).toContainText("Harness unavailable");

  await launchProfile.getByRole("tab", { name: "Runtime" }).click();
  await launchProfile.getByLabel("Harness", { exact: true }).fill("pi");
  const repairResponse = page.waitForResponse((response) => response.request().method() === "PATCH"
    && response.url().includes(`/local/workspaces/${workspace.id}/agents/`));
  await launchProfile.getByRole("button", { name: "Save launch profile" }).click();
  expect((await repairResponse).ok()).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("link", { name: "All agents" }).click();
  await expect(page.getByRole("link", { name: /Repairable Agent/ })).toHaveCount(1);
});

test("creates and renames a Workspace with a private source path", async ({ page, request }) => {
  await launchAuthenticated(page, request, "/");
  await page.getByRole("button", { name: "Add Workspace" }).click();
  const createDialog = page.getByRole("dialog", { name: "Add Workspace" });
  await createDialog.getByLabel("Name", { exact: true }).fill("Browser Workspace");
  await createDialog.getByRole("button", { name: "Browse" }).click();
  await expect(createDialog.getByLabel("Source folder", { exact: true })).toHaveValue("/tmp");
  await createDialog.getByRole("button", { name: "Create Workspace" }).click();

  await expect(page.getByRole("heading", { name: "#General", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Browser Workspace", exact: true })).toBeVisible();
  const createdWorkspaceId = new URL(page.url()).pathname.match(/\/workspaces\/([^/]+)/)?.[1];
  expect(createdWorkspaceId).toBeTruthy();
  await expect.poll(() => page.evaluate(async (workspaceId) => {
    const response = await fetch(`/local/workspaces/${workspaceId}/config`);
    if (!response.ok) return false;
    return Boolean((await response.json() as { rootConfigured?: boolean }).rootConfigured);
  }, createdWorkspaceId)).toBe(true);
  await page.getByRole("button", { name: "Configure Workspace Browser Workspace" }).click();
  const settings = page.getByRole("dialog", { name: "Browser Workspace configuration" });
  await expect(settings.getByText("Source: configured", { exact: true })).toBeVisible();
  await settings.getByLabel("Name", { exact: true }).fill("Renamed Workspace");
  await settings.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByLabel("Selected Workspace").locator("option:checked")).toHaveText("Renamed Workspace");
});

test("creates named Conversations and revisioned participant rosters", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const workspace = workspaces[0]!;
  const { members } = await (await request.get(
    `${conversationsBase}/workspaces/${workspace.id}/members`,
  )).json() as { members: Array<{ identityId: string; mentionHandle: string }> };
  const builder = members.find(({ mentionHandle }) => mentionHandle === "builder")!;
  await launchAuthenticated(page, request, "/");

  await page.getByRole("button", { name: `Create Conversation in ${workspace.name}` }).click();
  const createDialog = page.getByRole("dialog", { name: `Create a Conversation in ${workspace.name}` });
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel("Conversation name").fill("roster-administration");
  await expect(createDialog.getByText("You are included automatically.", { exact: true })).toBeVisible();
  await expect(createDialog.getByRole("checkbox", { name: /David Kennedy/ })).toHaveCount(0);
  await createDialog.getByRole("checkbox", { name: /Builder Agent/ }).check();
  const createResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/conversations"));
  await createDialog.getByRole("button", { name: "Create Conversation" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const { conversation } = await createResponse.json() as { conversation: { id: string } };
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversation.id}$`));
  await expect(page.getByRole("heading", { name: "#roster-administration" })).toBeVisible();
  const startResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/local/conversations/${conversation.id}/agents/${builder.identityId}/start`));
  await openParticipantActions(page, "Builder Agent");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  expect((await startResponsePromise).ok()).toBe(true);
  await expect(page.getByTitle("Runtime: Idle")).toBeVisible();

  const replacePath = `/local/conversations/${conversation.id}/agents/${builder.identityId}/replace`;
  await page.route(`**${replacePath}`, (route) => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({ error: "Replacement temporarily unavailable" }),
  }), { times: 1 });
  await openParticipantActions(page, "Builder Agent");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  let lifecycleDialog = page.getByRole("dialog", { name: "Start a new session for Builder Agent?" });
  await expect(lifecycleDialog).toContainText("A temporary handoff is created from public Conversation history when available; it is not stored as memory.");
  await expect(lifecycleDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await lifecycleDialog.getByRole("button", { name: "New session", exact: true }).click();
  await expect(lifecycleDialog.getByRole("alert")).toHaveText("Replacement temporarily unavailable");

  let releaseReplace!: () => void;
  const replaceGate = new Promise<void>((resolve) => { releaseReplace = resolve; });
  await page.route(`**${replacePath}`, async (route) => {
    await replaceGate;
    await route.continue();
  }, { times: 1 });
  const replaceResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith(replacePath));
  await lifecycleDialog.getByRole("button", { name: "New session", exact: true }).click();
  await expect(lifecycleDialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(lifecycleDialog.getByRole("button", { name: "New session", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(lifecycleDialog).toBeVisible();
  releaseReplace();
  expect((await replaceResponsePromise).ok()).toBe(true);
  await expect(page.getByTitle("Runtime: Idle")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open actions for Builder Agent" }).first()).toBeFocused();

  const stopResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/local/conversations/${conversation.id}/agents/${builder.identityId}/stop`));
  await openParticipantActions(page, "Builder Agent");
  await page.getByRole("button", { name: "Stop agent", exact: true }).click();
  lifecycleDialog = page.getByRole("dialog", { name: "Stop Builder Agent?" });
  await expect(lifecycleDialog).toContainText("filesystem effects cannot be rolled back");
  await lifecycleDialog.getByRole("button", { name: "Stop agent", exact: true }).click();
  expect((await stopResponsePromise).ok()).toBe(true);
  await expect(page.getByTitle("Runtime: Stopped")).toBeVisible();

  await openParticipantActions(page, "Builder Agent");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  lifecycleDialog = page.getByRole("dialog", { name: "Start a new session for Builder Agent?" });
  await lifecycleDialog.getByRole("button", { name: "New session", exact: true }).click();
  await expect(page.getByTitle("Runtime: Idle")).toBeVisible();

  const historical = await request.post(`${conversationsBase}/conversations/${conversation.id}/messages`, {
    data: { participantId: builder.identityId, body: "Builder attribution survives roster removal." },
  });
  expect(historical.ok()).toBe(true);
  await expect(page.getByRole("log").getByText("Builder attribution survives roster removal.")).toBeVisible();

  await page.getByRole("button", { name: "Manage Conversation participants" }).click();
  let rosterDialog = page.getByRole("dialog", { name: "Manage #roster-administration" });
  await expect(rosterDialog.getByRole("checkbox", { name: /Builder Agent/ })).toBeChecked();
  await rosterDialog.getByLabel("Conversation name").fill("delivery-room");
  const renameResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().endsWith(`/conversations/${conversation.id}`));
  await rosterDialog.getByRole("button", { name: "Save name" }).click();
  expect((await renameResponsePromise).ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "#delivery-room" })).toBeVisible();
  rosterDialog = page.getByRole("dialog", { name: "Manage #delivery-room" });
  const participantForm = rosterDialog.locator("form").filter({ hasText: "Create a participant" });
  await participantForm.getByLabel("Participant type").selectOption("agent");
  await participantForm.getByLabel("Display name").fill("Reviewer Agent");
  await expect(participantForm.getByLabel("Mention handle")).toHaveValue("reviewer-agent");
  await participantForm.getByLabel("Mention handle").fill("@reviewer");
  await expect(participantForm.getByLabel("Mention handle")).toHaveValue("reviewer");
  await participantForm.getByLabel("Public role (optional)").fill("reviewer");
  await participantForm.getByLabel("Agent instructions (optional)").fill("Review work for correctness and report concrete findings.");
  const identityResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/identities"));
  const memberResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith(`/workspaces/${workspace.id}/members`));
  const configurationResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().includes(`/local/workspaces/${workspace.id}/agents/`));
  await participantForm.getByRole("button", { name: "Create participant" }).click();
  expect((await identityResponsePromise).ok()).toBe(true);
  expect((await memberResponsePromise).ok()).toBe(true);
  expect((await configurationResponsePromise).ok()).toBe(true);
  await expect(participantForm.getByText("Participant created and selected", { exact: true })).toBeVisible();
  await expect(rosterDialog.getByRole("checkbox", { name: /Reviewer Agent/ })).toBeChecked();
  await rosterDialog.getByRole("checkbox", { name: /Builder Agent/ }).uncheck();
  await rosterDialog.getByRole("button", { name: "Save participants" }).click();
  await expect(rosterDialog).toBeHidden();
  await expect(page.getByText(/roster 2$/)).toBeVisible();
  await expect(page.getByRole("log").getByText("Builder Agent", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Manage Conversation participants" }).click();
  rosterDialog = page.getByRole("dialog", { name: "Manage #delivery-room" });
  await rosterDialog.getByRole("checkbox", { name: /Builder Agent/ }).check();
  await rosterDialog.getByRole("button", { name: "Save participants" }).click();
  await expect(rosterDialog).toBeHidden();
  await expect(page.getByText(/roster 3$/)).toBeVisible();
});

test("caps wrapped drafts on mobile and restores them after Conversation navigation", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 480 });
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const workspace = workspaces.find(({ name }) => name === "Browser Test")!;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspace.id}/conversations`)).json() as {
    conversations: Array<{ id: string; name: string }>;
  };
  const primary = conversations.find(({ name }) => name === "browser-collaboration")!;
  const alternate = conversations.find(({ name }) => name === "alternate-collaboration")!;

  await launchAuthenticated(page, request, `/app/workspaces/${workspace.id}/conversations/${primary.id}`);
  const composer = page.getByRole("combobox", { name: "Conversation message" });
  const draft = Array.from({ length: 180 }, () => "wrapped").join(" ");
  await composer.fill(draft);
  await expect.poll(() => composer.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }))).toMatchObject({ overflowY: "auto" });
  expect(await composer.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect((await page.getByRole("button", { name: "Send", exact: true }).boundingBox())!.y).toBeLessThan(480);

  await page.goto(`/app/workspaces/${workspace.id}/conversations/${alternate.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "#alternate-collaboration" })).toBeVisible();
  await page.goto(`/app/workspaces/${workspace.id}/conversations/${primary.id}`, { waitUntil: "domcontentloaded" });
  await expect(composer).toHaveValue(draft);
  await expect.poll(() => composer.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
});

test("uses accessible mobile navigation and participant drawers", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { conversations } = await (await request.get(
    `${conversationsBase}/workspaces/${workspaceId}/conversations`,
  )).json() as { conversations: Array<{ id: string }> };
  const conversationId = conversations[0]!.id;

  await launchAuthenticated(page, request, "/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("link", { name: /browser-collaboration/ }).click();
  await expect(navigation).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/app/workspaces/${workspaceId}/conversations/${conversationId}$`));

  await page.getByRole("button", { name: "Show participants" }).click();
  const participants = page.getByRole("dialog", { name: "Participants" });
  await expect(participants).toContainText("Builder Agent");
  await participants.getByRole("button", { name: "Close participants" }).click();
  await expect(participants).toBeHidden();
  await expect(page.getByRole("button", { name: "Show participants" })).toBeFocused();
});

test("moves a Conversation through Snoozed, Archive, and Reopen navigation", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const workspace = workspaces[0]!;
  const name = `lifecycle-${Date.now()}`;
  await launchAuthenticated(page, request, "/");
  await page.getByRole("button", { name: `Create Conversation in ${workspace.name}` }).click();
  const dialog = page.getByRole("dialog", { name: `Create a Conversation in ${workspace.name}` });
  await dialog.getByLabel("Conversation name").fill(name);
  await dialog.getByRole("button", { name: "Create Conversation" }).click();
  await expect(page.getByRole("heading", { name: `#${name}` })).toBeVisible();
  const conversationId = new URL(page.url()).pathname.match(/\/conversations\/([^/]+)$/)?.[1];
  expect(conversationId).toBeTruthy();

  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name, exact: true }) });
  await row.getByLabel(`Conversation actions for ${name}`).click();
  await page.getByRole("button", { name: /^Snooze/ }).click();
  const lifecycleRequest = page.waitForRequest((request) => request.method() === "PATCH"
    && request.url().endsWith(`/local/conversations/${conversationId}/lifecycle`));
  await page.getByRole("button", { name: "Next week", exact: true }).click();
  const snoozePayload = (await lifecycleRequest).postDataJSON() as { snoozedUntil: string };
  const nextWeek = new Date(snoozePayload.snoozedUntil);
  expect(nextWeek.getDay()).toBe(1);
  expect(nextWeek.getHours()).toBe(9);
  const snoozed = page.getByRole("button", { name: "Snoozed", exact: true });
  await expect(snoozed).toBeVisible();
  await snoozed.click();
  await row.getByLabel(`Conversation actions for ${name}`).click();
  await page.getByRole("button", { name: "Reopen Conversation", exact: true }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();

  await row.getByLabel(`Conversation actions for ${name}`).click();
  await page.getByRole("button", { name: "Settled", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("archived and read-only");
  await expect(page.getByLabel("Conversation message")).toBeDisabled();
  const settled = page.getByRole("button", { name: "Settled", exact: true });
  await expect(settled).toBeVisible();
  await settled.click();
  await expect(row.getByRole("link", { name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Conversation message")).toBeEnabled();
});

test("shows required browser onboarding when no Workspace exists", async ({ page, request }) => {
  expect((await request.post(`${fixtureBase}/hide-workspaces?value=true`)).ok()).toBe(true);
  try {
    await launchAuthenticated(page, request, "/");
    await expect(page.getByRole("heading", { name: "Create your first Workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Browse" }).click();
    await expect(page.getByLabel("Source folder")).toHaveValue("/tmp");
    await expect(page.getByLabel("Name")).toHaveValue("tmp");
    await expect(page.getByRole("button", { name: "Create Workspace" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  } finally {
    expect((await request.post(`${fixtureBase}/hide-workspaces?value=false`)).ok()).toBe(true);
  }
});

test("loads syntax highlighting only when a fenced code message arrives", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as {
    conversations: Array<{ id: string }>;
  };
  const conversationId = conversations[0]!.id;
  const loadedModules: string[] = [];
  page.on("request", (outgoing) => loadedModules.push(outgoing.url()));

  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/conversations/${conversationId}`);
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  expect(loadedModules.some((url) => url.includes("code-highlighter"))).toBe(false);

  await request.post(`${fixtureBase}/peer-message?body=${encodeURIComponent("```ts\nconst answer: number = 42;\n```")}`);
  await expect(page.locator(".th-token.th-keyword")).toBeVisible();
  expect(loadedModules.some((url) => url.includes("code-highlighter"))).toBe(true);
});

test("keeps messaging available when Runtime status is unavailable", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { conversations } = await (await request.get(
    `${conversationsBase}/workspaces/${workspaceId}/conversations`,
  )).json() as { conversations: Array<{ id: string }> };
  const conversationId = conversations[0]!.id;
  await page.route(`**/local/conversations/${conversationId}/agents`, (route) => route.abort("connectionfailed"));

  await launchAuthenticated(
    page,
    request,
    `/app/workspaces/${workspaceId}/conversations/${conversationId}`,
  );
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  await expect(page.getByText("Runtime status unavailable")).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Conversation message" });
  await composer.fill("Public messaging remains available without local control.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log").getByText(
    "Public messaging remains available without local control.",
    { exact: true },
  )).toBeVisible();
});
