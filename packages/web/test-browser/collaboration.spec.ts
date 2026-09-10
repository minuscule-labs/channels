import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const channelsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

async function launchAuthenticated(
  page: Page,
  request: APIRequestContext,
  destination: string,
): Promise<void> {
  const response = await request.get(
    `${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}`,
  );
  expect(response.ok()).toBe(true);
  const { launchUrl } = await response.json() as { launchUrl: string };
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
}

test("sends idempotently, refreshes rosters, and catches up after reconnect", async ({ page, request }) => {
  const workspacesResponse = await request.get(`${channelsBase}/workspaces`);
  const { workspaces } = await workspacesResponse.json() as { workspaces: Array<{ id: string }> };
  const workspaceId = workspaces[0]!.id;
  const channelsResponse = await request.get(`${channelsBase}/workspaces/${workspaceId}/channels`);
  const { channels } = await channelsResponse.json() as { channels: Array<{ id: string; rosterRevision: number }> };
  const channelId = channels[0]!.id;
  const initialRosterRevision = channels[0]!.rosterRevision;
  const membersResponse = await request.get(`${channelsBase}/workspaces/${workspaceId}/members`);
  const { members } = await membersResponse.json() as {
    members: Array<{ identityId: string; mentionHandle: string }>;
  };
  const human = members.find(({ mentionHandle }) => mentionHandle === "david")!;
  const agent = members.find(({ mentionHandle }) => mentionHandle === "builder")!;

  const idempotencyKeys: string[] = [];
  const messageAuthors: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.method() === "POST" && outgoing.url().endsWith(`/channels/${channelId}/messages`)) {
      const key = outgoing.headers()["idempotency-key"];
      if (key) idempotencyKeys.push(key);
      const body = outgoing.postDataJSON() as { participantId?: string };
      if (body.participantId) messageAuthors.push(body.participantId);
    }
  });

  await launchAuthenticated(
    page,
    request,
    `/app/workspaces/${workspaceId}/channels/${channelId}`,
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
    key: `minu.channels.author.${workspaceId}`,
    value: agent.identityId,
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Sending as @david", { exact: true })).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Channel message" });
  await composer.fill("@b");
  await expect(page.getByRole("option", { name: /@builder/ })).toBeVisible();
  await composer.press("Enter");
  await composer.pressSequentially("Browser reply.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log").getByText("@builder Browser reply.", { exact: true })).toBeVisible();
  expect(idempotencyKeys[0]).toBeTruthy();
  await expect(composer).toHaveValue("");

  await composer.fill("First line");
  await composer.press("Control+Enter");
  await expect(composer).toHaveValue("First line\n");
  await composer.pressSequentially("Second line");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("log").getByText(/First line\s+Second line/)).toBeVisible();

  const update = await request.patch(
    `${channelsBase}/workspaces/${workspaceId}/members/${agent.identityId}`,
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

test("tracks durable unread mentions and plays only opt-in contextual sound", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { channels } = await (await request.get(`${channelsBase}/workspaces/${workspaceId}/channels`)).json() as {
    channels: Array<{ id: string; name: string }>;
  };
  const channelId = channels[0]!.id;
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
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/channels/${channelId}`);
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
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(1);
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
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const primary = workspaces.find(({ name }) => name === "Browser Test")!;
  const secondary = workspaces.find(({ name }) => name === "Browser Secondary")!;
  const { channels: secondaryChannels } = await (await request.get(`${channelsBase}/workspaces/${secondary.id}/channels`)).json() as {
    channels: Array<{ id: string }>;
  };
  const secondaryChannelId = secondaryChannels[0]!.id;
  const messageRequests: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.url().includes(`/channels/${secondaryChannelId}/messages`)) messageRequests.push(outgoing.url());
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
  await launchAuthenticated(page, request, `/app/workspaces/${secondary.id}/channels/${secondaryChannelId}`);
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  messageRequests.length = 0;
  await page.getByLabel("Selected Workspace").first().selectOption(primary.id);
  await expect(page.getByRole("heading", { name: "#browser-collaboration" })).toBeVisible();
  await page.getByLabel("Notification sound").first().selectOption("all");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(1);

  await request.post(`${fixtureBase}/disconnect?workspace=inactive`);
  await expect(page.getByLabel("Selected Workspace").first().locator(`option[value="${secondary.id}"]`)).toContainText("1 unread", { timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(1);
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

test("resets near-end and unseen state across parameter-only Channel navigation", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as { workspaces: Array<{ id: string; name: string }> };
  const workspaceId = workspaces.find(({ name }) => name === "Browser Test")!.id;
  const { channels } = await (await request.get(`${channelsBase}/workspaces/${workspaceId}/channels`)).json() as {
    channels: Array<{ id: string; name: string }>;
  };
  const primary = channels.find(({ name }) => name === "browser-collaboration")!;
  const alternate = channels.find(({ name }) => name === "alternate-collaboration")!;
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/channels/${primary.id}`);
  await request.post(`${fixtureBase}/peer-message?count=35&body=Navigation%20scroll`);
  await expect(page.getByText("Navigation scroll 35", { exact: true })).toBeVisible();
  const timeline = page.locator(".minu-scroll.absolute");
  await timeline.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await page.getByRole("link", { name: "alternate-collaboration" }).first().click();
  await expect(page.getByRole("heading", { name: "#alternate-collaboration" })).toBeVisible();
  await request.post(`${fixtureBase}/peer-message?channel=alternate&body=Alternate%20fresh`);
  await expect(page.getByText("Alternate fresh", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /new message/ })).toHaveCount(0);
  await expect(page.getByLabel(/unread message/)).toHaveCount(0);
  expect(alternate.id).toBeTruthy();
});

test("advances the durable read cursor only when a real visible timeline is near its end", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = workspaces[0]!.id;
  const { channels } = await (await request.get(`${channelsBase}/workspaces/${workspaceId}/channels`)).json() as { channels: Array<{ id: string }> };
  const channelId = channels[0]!.id;
  const { members } = await (await request.get(`${channelsBase}/workspaces/${workspaceId}/members`)).json() as {
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
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/channels/${channelId}`);
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  await page.getByLabel("Notification sound").first().selectOption("mentions");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __soundCount: number }).__soundCount)).toBe(1);
  await request.post(`${fixtureBase}/peer-message?count=35&body=Scroll%20fixture`);
  await expect(page.getByText("Scroll fixture 35", { exact: true })).toBeVisible();
  const cursorKey = `minu-channels:last-read:${humanId}:${channelId}`;
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
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as { workspaces: Array<{ id: string }> };
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

test("summarizes Channel-wide agent activity above the composer", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as { workspaces: Array<{ id: string; name: string }> };
  const workspaceId = workspaces.find(({ name }) => name === "Browser Test")!.id;
  const { channels } = await (await request.get(`${channelsBase}/workspaces/${workspaceId}/channels`)).json() as {
    channels: Array<{ id: string; name: string }>;
  };
  const channelId = channels.find(({ name }) => name === "browser-collaboration")!.id;
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/channels/${channelId}`);
  await request.post(`${fixtureBase}/agent-activity?phase=running&queued=2`);
  const strip = page.getByRole("region", { name: "Channel agent activity" });
  await expect(strip).toContainText(/@builder is working · 1m \d+s · 2 turns queued/, { timeout: 10_000 });
  await expect(strip).not.toContainText(/Verify the browser collaboration flow|message_|tool|prompt|error/i);
  expect((await strip.boundingBox())!.y).toBeLessThan((await page.getByRole("combobox", { name: "Channel message" }).boundingBox())!.y);

  await request.post(`${fixtureBase}/agent-activity?phase=retrying&queued=1`);
  await expect(strip).toContainText(/@builder is retrying \(attempt 2\).*1 turn queued/, { timeout: 10_000 });
  await page.getByRole("button", { name: "Cancel current request for Builder Agent" }).first().click();
  await expect(strip).toContainText("@builder is canceling", { timeout: 10_000 });
  await request.post(`${fixtureBase}/agent-activity?phase=idle`);
  await expect(strip).toHaveCount(0, { timeout: 10_000 });
});

test("reconnects an existing reachable session and exposes only safe diagnostics", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as { workspaces: Array<{ id: string; name: string }> };
  const workspaceId = workspaces.find(({ name }) => name === "Browser Test")!.id;
  const { channels } = await (await request.get(`${channelsBase}/workspaces/${workspaceId}/channels`)).json() as {
    channels: Array<{ id: string; name: string }>;
  };
  const channelId = channels.find(({ name }) => name === "browser-collaboration")!.id;
  const lifecycleRequests: string[] = [];
  page.on("request", (outgoing) => {
    if (/\/(reconnect|replace)$/.test(new URL(outgoing.url()).pathname)) lifecycleRequests.push(new URL(outgoing.url()).pathname);
  });
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/channels/${channelId}`);
  await request.post(`${fixtureBase}/detach-agent`);
  await expect(page.getByRole("button", { name: "Reconnect Builder Agent" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /Resume/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Start fresh/ })).toHaveCount(0);
  await page.getByText("Diagnostics").click();
  await expect(page.getByText("disconnected", { exact: true })).toBeVisible();
  await expect(page.getByText("Not verified", { exact: true }).first()).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(/private-browser-session|runtimeSessionId|\/tmp/);

  await page.getByRole("button", { name: "Reconnect Builder Agent" }).click();
  await expect(page.getByTitle("Runtime: Idle")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect Builder Agent" })).toHaveCount(0);
  expect(lifecycleRequests).toHaveLength(1);
  expect(lifecycleRequests[0]).toMatch(new RegExp(`^/local/channels/${channelId}/agents/[^/]+/reconnect$`));
  expect(lifecycleRequests.some((path) => path.endsWith("/replace"))).toBe(false);

  await request.post(`${fixtureBase}/detach-agent`);
  await request.post(`${fixtureBase}/runtime-reachable?value=false`);
  await expect(page.getByRole("button", { name: "Start fresh with Builder Agent" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Reconnect Builder Agent" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Resume/ })).toHaveCount(0);
  await request.post(`${fixtureBase}/runtime-reachable?value=true`);
  await expect(page.getByRole("button", { name: "Reconnect Builder Agent" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Reconnect Builder Agent" }).click();
  await expect(page.getByTitle("Runtime: Idle")).toBeVisible();
});

test("runs Channel-scoped bulk lifecycle with one confirmation and visible partial results", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { channels } = await (await request.get(
    `${channelsBase}/workspaces/${workspaceId}/channels`,
  )).json() as { channels: Array<{ id: string }> };
  const channelId = channels[0]!.id;
  const { channel: channelMetadata } = await (await request.get(
    `${channelsBase}/channels/${channelId}`,
  )).json() as { channel: {
    participants: Array<Record<string, unknown> & { id: string }>;
    [key: string]: unknown;
  } };
  const builder = channelMetadata.participants.find(({ type }) => type === "agent")!;
  const unboundId = "agent-unbound-browser";
  await page.route(`**/channels/${channelId}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ channel: {
      ...channelMetadata,
      participants: [...channelMetadata.participants, {
        id: unboundId,
        type: "agent",
        displayName: "Unbound Agent",
        handle: "unbound-agent",
        status: "active",
      }],
    } }),
  }));
  await page.route(`**/local/channels/${channelId}/agents`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      protocolVersion: 11,
      channelId,
      agents: [
        {
          workspaceId, channelId, identityId: builder.id, state: "idle",
          capabilities: { start: false, replace: false, stop: true, steer: false, interrupt: false, reconnect: false },
        },
        {
          workspaceId, channelId, identityId: unboundId, state: "unbound",
          capabilities: { start: true, replace: false, stop: false, steer: false, interrupt: false, reconnect: false },
        },
      ],
    }),
  }));
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  let requests = 0;
  await page.route(`**/local/channels/${channelId}/agents/stop-all`, async (route) => {
    requests += 1;
    await requestGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        protocolVersion: 11,
        channelId,
        results: [
          { identityId: builder.id, outcome: "stopped" },
          { identityId: unboundId, outcome: "skipped", reason: "uncertain" },
        ],
      }),
    });
  });
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/channels/${channelId}`);
  await expect(page.getByRole("button", { name: /^Start agents/ })).toBeVisible();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Active work will be interrupted");
    await dialog.accept();
  });
  await page.getByRole("button", { name: /^Stop agents/ }).click();
  await expect(page.getByRole("button", { name: "Stop agent Builder Agent" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start Unbound Agent" })).toBeEnabled();
  releaseRequest();
  await expect(page.getByRole("status").filter({ hasText: "Bulk action complete" })).toContainText("stopped");
  await expect(page.getByRole("status").filter({ hasText: "Bulk action complete" })).toContainText("status uncertain");
  expect(requests).toBe(1);
});

test("hides bulk lifecycle controls when the local capability is unavailable", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { channels } = await (await request.get(
    `${channelsBase}/workspaces/${workspaceId}/channels`,
  )).json() as { channels: Array<{ id: string }> };
  const channelId = channels[0]!.id;
  await page.route("**/local/capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      protocolVersion: 11,
      features: {
        currentSession: true,
        channelAgentStatus: true,
        workspaceConfigRead: true,
        workspaceConfigWrite: true,
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
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/channels/${channelId}`);
  await expect(page.getByRole("heading", { name: "Collaborators" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Start agents/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Stop agents/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Stop agent/ })).toBeVisible();
});

test("configures Workspace agent startup without reflecting saved values", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
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
  await expect(agentForm.getByLabel("Replace harness", { exact: true })).toHaveValue("");
  await agentForm.getByRole("tab", { name: "General" }).click();
  await expect(agentForm.getByLabel("Replace agent instructions", { exact: true })).toHaveValue("");
  await expect(page.getByText(personaValue, { exact: true })).toHaveCount(0);
  await agentForm.getByRole("tab", { name: "Runtime" }).click();

  const providerSelect = agentCard.getByRole("combobox", { name: "Provider", exact: true });
  const modelSelect = agentCard.getByRole("combobox", { name: "Model", exact: true });
  const reasoningSelect = agentCard.getByRole("combobox", { name: "Reasoning", exact: true });
  await expect(providerSelect).toBeEnabled({ timeout: 10_000 });
  await agentForm.getByText("Manage available provider models", { exact: true }).click();
  await agentForm.getByLabel("Enable Browser Fast").uncheck();
  const modelPolicyResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && response.url().includes(`/local/workspaces/${workspace.id}/agents/`));
  await agentForm.getByRole("button", { name: "Save available models" }).click();
  expect((await modelPolicyResponsePromise).ok()).toBe(true);
  await providerSelect.selectOption("openai");
  await expect(modelSelect.getByRole("option", { name: "Browser Fast" })).toHaveCount(0);
  await modelSelect.selectOption({ label: "Browser Deep" });
  await reasoningSelect.selectOption("high");
  const launchProfileResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url().includes(`/local/workspaces/${workspace.id}/agents/`));
  await agentForm.getByRole("button", { name: "Save launch profile" }).click();
  const launchProfileResponse = await launchProfileResponsePromise;
  expect(launchProfileResponse.ok()).toBe(true);
  const launchProfileBody = await launchProfileResponse.text();
  expect(launchProfileBody).not.toContain("gpt-browser-deep");
  expect(launchProfileBody).not.toContain("high");
  await expect(agentForm.getByText("Model: configured", { exact: true })).toBeVisible();
  await expect(agentForm.getByText("Reasoning: configured", { exact: true })).toBeVisible();
  await agentForm.getByRole("tab", { name: "Skills" }).click();
  await expect(agentForm.getByRole("checkbox", { name: /review Review changes for correctness/ })).toBeChecked();
});

test("lists agents, opens a detail page, and adds an agent", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
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
  await expect(page.getByText("Model: configured", { exact: true })).toBeVisible();
  await expect(page.getByText("Reasoning: configured", { exact: true })).toBeVisible();
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
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
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
        protocolVersion: 11,
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
          boundChannelCount: 0,
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

test("creates named Channels and revisioned participant rosters", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const workspace = workspaces[0]!;
  const { members } = await (await request.get(
    `${channelsBase}/workspaces/${workspace.id}/members`,
  )).json() as { members: Array<{ identityId: string; mentionHandle: string }> };
  const builder = members.find(({ mentionHandle }) => mentionHandle === "builder")!;
  await launchAuthenticated(page, request, "/");

  await page.getByRole("button", { name: `Create Channel in ${workspace.name}` }).click();
  const createDialog = page.getByRole("dialog", { name: `Create a Channel in ${workspace.name}` });
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel("Channel name").fill("roster-administration");
  await expect(createDialog.getByText("You are included automatically.", { exact: true })).toBeVisible();
  await expect(createDialog.getByRole("checkbox", { name: /David Kennedy/ })).toHaveCount(0);
  await createDialog.getByRole("checkbox", { name: /Builder Agent/ }).check();
  const createResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/channels"));
  await createDialog.getByRole("button", { name: "Create Channel" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const { channel } = await createResponse.json() as { channel: { id: string } };
  await expect(page).toHaveURL(new RegExp(`/channels/${channel.id}$`));
  await expect(page.getByRole("heading", { name: "#roster-administration" })).toBeVisible();
  const startResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/local/channels/${channel.id}/agents/${builder.identityId}/start`));
  await page.getByRole("button", { name: "Start Builder Agent" }).click();
  expect((await startResponsePromise).ok()).toBe(true);
  await expect(page.getByTitle("Runtime: Idle")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  const replaceResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/local/channels/${channel.id}/agents/${builder.identityId}/replace`));
  await page.getByRole("button", { name: "Start fresh with Builder Agent" }).click();
  expect((await replaceResponsePromise).ok()).toBe(true);
  await expect(page.getByTitle("Runtime: Idle")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  const stopResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/local/channels/${channel.id}/agents/${builder.identityId}/stop`));
  await page.getByRole("button", { name: "Stop agent Builder Agent" }).click();
  expect((await stopResponsePromise).ok()).toBe(true);
  await expect(page.getByTitle("Runtime: Stopped")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start fresh with Builder Agent" }).click();
  await expect(page.getByTitle("Runtime: Idle")).toBeVisible();

  const historical = await request.post(`${channelsBase}/channels/${channel.id}/messages`, {
    data: { participantId: builder.identityId, body: "Builder attribution survives roster removal." },
  });
  expect(historical.ok()).toBe(true);
  await expect(page.getByRole("log").getByText("Builder attribution survives roster removal.")).toBeVisible();

  await page.getByRole("button", { name: "Manage Channel participants" }).click();
  let rosterDialog = page.getByRole("dialog", { name: "Manage #roster-administration" });
  await expect(rosterDialog.getByRole("checkbox", { name: /Builder Agent/ })).toBeChecked();
  await rosterDialog.getByLabel("Channel name").fill("delivery-room");
  const renameResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().endsWith(`/channels/${channel.id}`));
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

  await page.getByRole("button", { name: "Manage Channel participants" }).click();
  rosterDialog = page.getByRole("dialog", { name: "Manage #delivery-room" });
  await rosterDialog.getByRole("checkbox", { name: /Builder Agent/ }).check();
  await rosterDialog.getByRole("button", { name: "Save participants" }).click();
  await expect(rosterDialog).toBeHidden();
  await expect(page.getByText(/roster 3$/)).toBeVisible();
});

test("uses accessible mobile navigation and participant drawers", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { channels } = await (await request.get(
    `${channelsBase}/workspaces/${workspaceId}/channels`,
  )).json() as { channels: Array<{ id: string }> };
  const channelId = channels[0]!.id;

  await launchAuthenticated(page, request, "/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("link", { name: /browser-collaboration/ }).click();
  await expect(navigation).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/app/workspaces/${workspaceId}/channels/${channelId}$`));

  await page.getByRole("button", { name: "Show participants" }).click();
  const participants = page.getByRole("dialog", { name: "Participants" });
  await expect(participants).toContainText("Builder Agent");
  await participants.getByRole("button", { name: "Close participants" }).click();
  await expect(participants).toBeHidden();
  await expect(page.getByRole("button", { name: "Show participants" })).toBeFocused();
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

test("keeps messaging available when Runtime status is unavailable", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { channels } = await (await request.get(
    `${channelsBase}/workspaces/${workspaceId}/channels`,
  )).json() as { channels: Array<{ id: string }> };
  const channelId = channels[0]!.id;
  await page.route(`**/local/channels/${channelId}/agents`, (route) => route.abort("connectionfailed"));

  await launchAuthenticated(
    page,
    request,
    `/app/workspaces/${workspaceId}/channels/${channelId}`,
  );
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  await expect(page.getByText("Runtime status unavailable")).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Channel message" });
  await composer.fill("Public messaging remains available without local control.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log").getByText(
    "Public messaging remains available without local control.",
    { exact: true },
  )).toBeVisible();
});
