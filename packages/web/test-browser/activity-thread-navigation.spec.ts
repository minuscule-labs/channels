import { expect, test } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

for (const mobile of [false, true]) {
  test(`Activity thread links preserve parent context, independent reads and Back history on ${mobile ? "mobile" : "desktop"}`, async ({ page, request }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const { identities } = await (await request.get(`${api}/identities`)).json();
    const human = identities.find((item: { displayName: string }) => item.displayName === "Workspace Member");
    const other = identities.find((item: { displayName: string }) => item.displayName === "David Kennedy");
    const name = `Activity thread ${mobile ? "mobile" : "desktop"}`;
    const { workspace } = await (await request.post(`${api}/workspaces`, { data: { name, slug: name.replaceAll(" ", "-").toLowerCase() } })).json();
    for (const identity of [human, other]) expect((await request.post(`${api}/workspaces/${workspace.id}/members`, { data: {
      identityId: identity.id, mentionHandle: identity.id === human.id ? "you" : "other", accessRole: "owner",
    } })).ok()).toBe(true);
    const { conversation } = await (await request.post(`${api}/conversations`, { data: {
      workspaceId: workspace.id, name, participantIds: [human.id, other.id],
    } })).json();
    const { conversation: filler } = await (await request.post(`${api}/conversations`, { data: {
      workspaceId: workspace.id, name: `${name} feed history`, participantIds: [human.id, other.id],
    } })).json();
    const post = async (conversationId: string, body: string, participantId = other.id, to: string[] = []) => {
      const response = await request.post(`${api}/conversations/${conversationId}/messages`, { data: { body, participantId, to } });
      expect(response.ok()).toBe(true);
      return (await response.json()).message as { id: string; sequence: number };
    };
    const root = await post(conversation.id, "ACTIVITY_TARGET_ROOT", human.id);
    const { thread } = await (await request.post(`${api}/conversations/${conversation.id}/threads`, { data: {
      actorIdentityId: human.id, rootMessageId: root.id,
    } })).json();
    await post(thread.id, "Already read reply");
    expect((await request.post(`${api}/conversations/${thread.id}/read`, {
      headers: { "x-minu-actor-id": human.id }, data: { sequence: 1 },
    })).ok()).toBe(true);
    const target = await post(thread.id, "ACTIVITY_FIRST_UNREAD_REPLY");
    const wrongRoot = await post(conversation.id, "REMEMBERED_WRONG_ROOT", human.id);
    const { thread: wrong } = await (await request.post(`${api}/conversations/${conversation.id}/threads`, { data: {
      actorIdentityId: human.id, rootMessageId: wrongRoot.id,
    } })).json();
    const wrongReply = await post(wrong.id, "Wrong remembered thread reply");
    for (let index = 0; index < (mobile ? 80 : 0); index++) await post(conversation.id, `Parent context ${index}`);
    const mention = await post(conversation.id, "Parent mention", other.id, [human.id]);
    for (let index = 0; index < 51; index++) await post(filler.id, `Feed history ${index}`, other.id, [human.id]);
    const storageKey = `minu.conversations.open-thread.${workspace.id}.${conversation.id}.${human.id}`;
    await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), { key: storageKey, id: wrong.id });
    const destination = `/app/workspaces/${workspace.id}/activity`;
    const { launchUrl } = await (await request.get(`${fixture}/control-launch?actor=member&destination=${encodeURIComponent(destination)}`)).json();
    const parentReads: string[] = [];
    page.on("request", req => {
      if (req.method() === "POST" && new URL(req.url()).pathname === `/conversations/${conversation.id}/read`) parentReads.push(req.url());
    });
    const count = async (id: string) => {
      const { summaries } = await (await request.get(`${api}/identities/me/inbox`, { headers: { "x-minu-actor-id": human.id } })).json();
      return summaries.find((item: { conversationId: string }) => item.conversationId === id)?.count;
    };
    let releaseThreads = () => {};
    try {
      await page.goto(launchUrl);
      await page.getByRole("button", { name: "Load more", exact: true }).click();
      await expect(page.locator("[data-activity-id]")).toHaveCount(54);
      const row = page.locator(`[data-activity-id="${target.id}"]`);
      await row.scrollIntoViewIfNeeded();
      const before = await page.getByRole("region", { name: "Activity", exact: true }).evaluate(element => element.scrollTop);
      expect(before).toBeGreaterThan(0);
      const unread = await count(conversation.id);
      const threadList = `**/conversations/${conversation.id}/threads`;
      const gate = new Promise<void>(resolve => { releaseThreads = resolve; });
      let handled!: () => void;
      const released = new Promise<void>(resolve => { handled = resolve; });
      await page.route(threadList, async route => { await gate; await route.fallback(); handled(); });
      await row.getByRole("link").click();
      await expect(page.getByRole("heading", { name: `#${name}`, exact: true })).toBeVisible();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      expect(await count(conversation.id)).toBe(unread); // even the short, fully visible parent cannot acknowledge while loading
      expect(parentReads).toEqual([]);
      releaseThreads();
      await released;
      await page.unroute(threadList);
      await expect(page).toHaveURL(new RegExp(`/conversations/${conversation.id}\\?`));
      expect(new URL(page.url()).searchParams.get("threadId")).toBe(thread.id);
      const panel = page.getByRole("dialog", { name: "Thread", exact: true });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("article", { name: "Thread root", exact: true })).toContainText("ACTIVITY_TARGET_ROOT");
      await expect(panel.getByRole("log").locator('[data-message-sequence="2"]')).toBeFocused();
      await expect(panel.getByText("REMEMBERED_WRONG_ROOT")).toHaveCount(0);
      if (mobile) {
        const box = await panel.boundingBox();
        expect(box!.x).toBe(0); expect(box!.width).toBe(390);
      } else await expect(page.getByRole("heading", { name: `#${name}`, exact: true })).toBeVisible();
      await expect.poll(() => count(thread.id)).toBe(0);
      expect(await count(conversation.id)).toBe(unread);
      await post(conversation.id, "Parent update must remain unread");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect.poll(() => count(conversation.id)).toBe(unread + 1);
      expect(parentReads).toEqual([]);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${destination}$`));
      await expect(page.locator("[data-activity-id]")).toHaveCount(54);
      await expect.poll(async () => page.getByRole("region", { name: "Activity", exact: true }).evaluate(element => element.scrollTop)).toBeCloseTo(before, 0);
      await row.getByRole("link").click();
      await expect(panel).toBeVisible();
      await page.reload();
      await expect(panel.getByRole("log").locator('[data-message-sequence="2"]')).toBeFocused();
      expect(await count(conversation.id)).toBe(unread + 1);
      expect(parentReads).toEqual([]);
      await panel.getByRole("button", { name: "Close thread", exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Open actions for message 1", exact: true })).toBeFocused();
      expect(new URL(page.url()).pathname).toBe(`/app/workspaces/${workspace.id}/conversations/${conversation.id}`);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${destination}$`));
      await page.evaluate(({ key, id }) => localStorage.setItem(key, id), { key: storageKey, id: wrong.id });
      await page.locator(`[data-activity-id="${mention.id}"]`).getByRole("link").click();
      await expect(panel).toHaveCount(0); // parent mentions must not reopen the remembered thread
      await expect(page.getByRole("log").locator('[data-message-sequence="3"]')).toBeFocused();
      await page.goBack();
      await page.locator(`[data-activity-id="${wrongReply.id}"]`).getByRole("link").click();
      await expect(panel.getByRole("article", { name: "Thread root", exact: true })).toContainText("REMEMBERED_WRONG_ROOT");
      await expect(panel.getByRole("log").locator('[data-message-sequence="1"]')).toBeFocused();
      await page.goto(`${new URL(page.url()).origin}/app/workspaces/${workspace.id}/conversations/${conversation.id}?threadId=missing#message-1`);
      await expect(page.getByText("Thread is unavailable.", { exact: true })).toBeVisible();
      await expect(panel).toHaveCount(0); // an unavailable explicit target must not fall back to memory
    } finally {
      releaseThreads();
      for (const id of [conversation.id, filler.id, thread.id, wrong.id]) {
        const { messages } = await (await request.get(`${api}/conversations/${id}/messages`)).json();
        for (const identity of [human, other]) expect((await request.post(`${api}/conversations/${id}/read`, {
          headers: { "x-minu-actor-id": identity.id }, data: { sequence: messages.at(-1).sequence },
        })).ok()).toBe(true);
      }
    }
  });
}
