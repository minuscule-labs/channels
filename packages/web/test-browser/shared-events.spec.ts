import { expect, test, type APIRequestContext } from "@playwright/test";
import type { ConversationMetadata } from "@minu/channels-core/types";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

async function setup(request: APIRequestContext) {
  const { workspaces } = await (await request.get(`${api}/workspaces`)).json();
  const workspace = workspaces.find((item: { name: string }) => item.name === "Browser Test");
  const { conversations } = await (await request.get(`${api}/workspaces/${workspace.id}/conversations`)).json() as { conversations: ConversationMetadata[] };
  const primary = conversations.find(({ name }) => name === "browser-collaboration")!;
  const alternate = conversations.find(({ name }) => name === "alternate-collaboration")!;
  const destination = `/app/workspaces/${workspace.id}/conversations/${primary.id}`;
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}`)).json();
  return { primary, alternate, launchUrl, destination };
}

async function streamCount(request: APIRequestContext) {
  return (await (await request.get(`${fixture}/stream-metrics`)).json()).active as number;
}

test("six tabs share one stream, keep status responsive, and survive the creating tab closing", async ({ page, request, context }) => {
  test.setTimeout(60_000);
  const data = await setup(request);
  const pages = [page];
  try {
    await page.goto(data.launchUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Live updates live")).toBeVisible();
    const origin = new URL(page.url()).origin;
    for (let index = 1; index < 6; index++) {
      const next = await context.newPage();
      pages.push(next);
      const id = index === 1 ? data.alternate.id : data.primary.id;
      await next.goto(`${origin}/app/workspaces/${data.primary.workspaceId}/conversations/${id}`, { waitUntil: "domcontentloaded" });
      await expect(next.getByLabel("Live updates live")).toBeVisible();
    }
    await expect.poll(() => streamCount(request)).toBe(1);
    await Promise.all(pages.map(async (tab, index) => {
      const id = index === 1 ? data.alternate.id : data.primary.id;
      const status = await tab.evaluate(async (conversationId) => {
        const start = performance.now();
        const response = await fetch(`/local/conversations/${conversationId}/agents`, { signal: AbortSignal.timeout(3_000) });
        await response.json();
        return { status: response.status, ms: performance.now() - start };
      }, id);
      expect(status.status).toBe(200);
      expect(status.ms).toBeLessThan(3_000);
    }));
    // Include the normal five-second idle poll and its three-second request deadline.
    await pages[5]!.waitForTimeout(8_500);
    for (const tab of pages) {
      await expect(tab.getByText(/Runtime status (unavailable|refresh failed)/)).toHaveCount(0);
    }
    const body = `Shared stream message ${Date.now()}`;
    expect((await request.post(`${fixture}/peer-message?body=${encodeURIComponent(body)}`)).ok()).toBe(true);
    for (const tab of pages.filter((_, index) => index !== 1)) {
      await expect(tab.getByRole("log").getByText(body, { exact: true })).toBeVisible();
    }
    await expect(pages[1]!.getByRole("log").getByText(body, { exact: true })).toHaveCount(0);
    const alternateBody = `Alternate shared message ${Date.now()}`;
    await request.post(`${fixture}/peer-message?conversation=alternate&body=${encodeURIComponent(alternateBody)}`);
    await expect(pages[1]!.getByRole("log").getByText(alternateBody, { exact: true })).toBeVisible();
    await expect(page.getByRole("log").getByText(alternateBody, { exact: true })).toHaveCount(0);
    // Bound worker delivery while a tab is suspended, then recover omitted events via snapshots.
    const suspended = pages[5]!;
    const session = await context.newCDPSession(suspended);
    const burst = `Suspended shared tab ${Date.now()}`;
    try {
      await session.send("Page.setWebLifecycleState", { state: "frozen" });
      for (let index = 0; index < 3; index++) {
        await request.post(`${fixture}/peer-message?count=50&body=${encodeURIComponent(`${burst}-${index}`)}`);
      }
    } finally {
      await session.send("Page.setWebLifecycleState", { state: "active" });
      await session.detach();
    }
    await expect(suspended.getByRole("log").getByText(`${burst}-0 1`, { exact: true })).toBeVisible();
    await expect(suspended.getByRole("log").getByText(`${burst}-2 50`, { exact: true })).toBeVisible();
    await expect(suspended.getByLabel("Live updates live")).toBeVisible();
    await page.close();
    const afterClose = `Creator closed ${Date.now()}`;
    await request.post(`${fixture}/peer-message?body=${encodeURIComponent(afterClose)}`);
    await expect(pages[5]!.getByRole("log").getByText(afterClose, { exact: true })).toBeVisible();
    await expect.poll(() => streamCount(request)).toBe(1);
  } finally {
    await Promise.all(pages.filter((tab) => !tab.isClosed()).map((tab) => tab.close()));
  }
});

test("101 remembered conversations and an open thread stay within one bounded live stream", async ({ page, request }) => {
  test.setTimeout(60_000);
  const data = await setup(request);
  const human = data.primary.participants.find(({ type }) => type === "human")!;
  const participantIds = data.primary.participants.map(({ id }) => id);
  const remembered = await Promise.all(Array.from({ length: 101 }, async (_, index) => {
    const response = await request.post(`${api}/conversations`, { data: {
      workspaceId: data.primary.workspaceId, participantIds, name: `subscription-policy-${index}`,
    } });
    expect(response.ok()).toBe(true);
    return (await response.json()).conversation as ConversationMetadata;
  }));
  const current = remembered[100]!;
  const root = await request.post(`${api}/conversations/${current.id}/messages`, {
    data: { participantId: human.id, body: "Subscription policy thread root" },
  });
  expect(root.ok()).toBe(true);
  await page.addInitScript(({ identityId, conversations }) => {
    localStorage.setItem(`minu-channels:known-conversations:${identityId}`, JSON.stringify(conversations));
  }, { identityId: human.id, conversations: remembered });
  const destination = `/app/workspaces/${current.workspaceId}/conversations/${current.id}`;
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}`)).json();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  const topics = async () => (await (await request.get(`${fixture}/stream-metrics`)).json()).topics as string[][];
  await expect.poll(topics).toEqual([[current.id]]);
  await page.getByRole("button", { name: "Open actions for message 1", exact: true }).click();
  await page.getByRole("menuitem", { name: "Start thread", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Thread", exact: true });
  await expect(panel.getByLabel("Live updates live")).toBeVisible();
  const { threads } = await (await request.get(`${api}/conversations/${current.id}/threads`)).json();
  const expected = [current.id, threads[0].id].sort();
  await expect.poll(topics).toEqual([expected]);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);

  for (const state of ["snoozed", "settled"] as const) {
    const response = await request.patch(`${api}/conversations/${current.id}/lifecycle`, { data: {
      actorIdentityId: human.id, state,
      ...(state === "snoozed" ? { snoozedUntil: new Date(Date.now() + 60_000).toISOString() } : {}),
    } });
    expect(response.ok()).toBe(true);
    await expect(page.getByLabel("Live updates paused")).toHaveCount(2);
    // Keep exactly one inbox-only stream, with no channel or thread topics.
    await expect.poll(topics).toEqual([[]]);
    // Conversation payloads are missed while paused and explicitly caught up on reopen.
    expect((await request.patch(`${api}/conversations/${current.id}/lifecycle`, { data: {
      actorIdentityId: human.id, state: "active",
    } })).ok()).toBe(true);
    const body = `Missed while ${state}`;
    expect((await request.post(`${api}/conversations/${current.id}/messages`, { data: {
      participantId: human.id, body,
    } })).ok()).toBe(true);
    await page.getByRole("button", { name: "Reopen", exact: true }).click();
    await expect(page.getByLabel("Live updates live")).toHaveCount(2);
    await expect(page.getByRole("log").getByText(body, { exact: true })).toBeVisible();
    await expect.poll(topics).toEqual([expected]);
  }
  await panel.getByRole("button", { name: "Close thread", exact: true }).click();
  // A just-closed thread is retained during the grace period, not indefinitely.
  await expect.poll(topics).toEqual([expected]);
});

test("reopening in one tab clears another tab's stale suspension for the channel and thread", async ({ page, request, context }) => {
  const data = await setup(request);
  const human = data.primary.participants.find(({ type }) => type === "human")!;
  const created = await request.post(`${api}/conversations`, { data: {
    workspaceId: data.primary.workspaceId, participantIds: [human.id], name: "cross-tab-lifecycle",
  } });
  expect(created.ok()).toBe(true);
  const { conversation } = await created.json();
  const relatedIds = new Set<string>([conversation.id]);
  const matchingStreams = async () => {
    const { topics } = await (await request.get(`${fixture}/stream-metrics`)).json() as { topics: string[][] };
    // Metrics cover the shared fixture, including unrelated clients from other cases.
    return topics.filter(ids => ids.some(id => relatedIds.has(id)));
  };
  expect((await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
    participantId: human.id, body: "Cross-tab lifecycle root",
  } })).ok()).toBe(true);
  const destination = `/app/workspaces/${conversation.workspaceId}/conversations/${conversation.id}`;
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}`)).json();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  await page.getByRole("button", { name: "Open actions for message 1", exact: true }).click();
  await page.getByRole("menuitem", { name: "Start thread", exact: true }).click();
  await expect(page.getByLabel("Live updates live")).toHaveCount(2);
  const { threads } = await (await request.get(`${api}/conversations/${conversation.id}/threads`)).json();
  for (const thread of threads) relatedIds.add(thread.id);
  const other = await context.newPage();
  try {
    await other.goto(`${new URL(page.url()).origin}${destination}`, { waitUntil: "domcontentloaded" });
    // Published thread selection is restored across tabs for the same principal.
    await expect(other.getByLabel("Live updates live")).toHaveCount(2);
    for (const state of ["settled", "snoozed"] as const) {
      expect((await request.patch(`${api}/conversations/${conversation.id}/lifecycle`, { data: {
        actorIdentityId: human.id, state,
        ...(state === "snoozed" ? { snoozedUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() } : {}),
      } })).ok()).toBe(true);
      await expect(page.getByLabel("Live updates paused")).toHaveCount(2);
      await expect(other.getByLabel("Live updates paused")).toHaveCount(2);
      await expect.poll(matchingStreams).toHaveLength(0);
      // No SSE remains to inform the peer of Reopen; it must refresh its cached exclusion.
      if (state === "settled") {
        await page.getByRole("button", { name: "Reopen", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "Snoozed", exact: true }).click();
        await page.getByRole("button", { name: "Conversation actions for cross-tab-lifecycle", exact: true }).click();
        await page.getByRole("button", { name: "Reopen Conversation", exact: true }).click();
      }
      await expect(page.getByLabel("Live updates live")).toHaveCount(2, { timeout: 3_000 });
      await expect(other.getByLabel("Live updates live")).toHaveCount(2, { timeout: 3_000 });
      await expect.poll(matchingStreams).toHaveLength(1);
      const body = `Delivered after cross-tab ${state}`;
      expect((await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
        participantId: human.id, body,
      } })).ok()).toBe(true);
      await expect(page.getByRole("log").getByText(body, { exact: true })).toBeVisible();
      await expect(other.getByRole("log").getByText(body, { exact: true })).toBeVisible();
    }
  } finally {
    await other.close();
  }
});

test("unsupported SharedWorker falls back to snapshot polling without long-lived connections", async ({ page, request }) => {
  const data = await setup(request);
  await page.addInitScript(() => Object.defineProperty(window, "SharedWorker", { configurable: true, value: undefined }));
  await page.goto(data.launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Live updates polling")).toBeVisible();
  await expect.poll(() => streamCount(request)).toBe(0);
  const body = `Polling fallback ${Date.now()}`;
  await request.post(`${fixture}/peer-message?body=${encodeURIComponent(body)}`);
  await expect(page.getByRole("log").getByText(body, { exact: true })).toBeVisible({ timeout: 8_000 });
  const status = await page.evaluate(async () => (await fetch("/local/session", { signal: AbortSignal.timeout(3_000) })).status);
  expect(status).toBe(200);
});
