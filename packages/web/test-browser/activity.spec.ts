import { expect, test } from "@playwright/test";
import type { ConversationMetadata } from "@minu/channels-core/types";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

test("Activity and its badge stay in the selected workspace across switching, paging and tabs", async ({ page, context, request }) => {
  const { identities } = await (await request.get(`${api}/identities`)).json();
  const member = identities.find((item: { displayName: string }) => item.displayName === "Workspace Member");
  const owner = identities.find((item: { displayName: string }) => item.displayName === "David Kennedy");
  const workspaces: Array<{ id: string }> = [];
  const conversations: Array<{ id: string }> = [];
  for (const name of ["Activity workspace A", "Activity workspace B"]) {
    const created = await request.post(`${api}/workspaces`, { data: { name, slug: name.toLowerCase().replaceAll(" ", "-") } });
    expect(created.ok()).toBe(true);
    const { workspace } = await created.json();
    workspaces.push(workspace);
    for (const identity of [member, owner]) expect((await request.post(`${api}/workspaces/${workspace.id}/members`, { data: {
      identityId: identity.id, mentionHandle: identity.id === member.id ? "member" : "owner", accessRole: "owner",
    } })).ok()).toBe(true);
    const { conversation } = await (await request.post(`${api}/conversations`, { data: {
      workspaceId: workspace.id, name, participantIds: [member.id, owner.id],
    } })).json();
    conversations.push(conversation);
  }
  const messages: Array<Array<{ id: string; sequence: number }>> = [];
  for (let index = 0; index < 2; index++) {
    const rows: Array<{ id: string; sequence: number }> = [];
    for (let count = 0; count < (index === 0 ? 52 : 2); count++) {
      const { message } = await (await request.post(`${api}/conversations/${conversations[index].id}/messages`, { data: {
        participantId: owner.id, body: `Workspace ${index} notification ${count}`, to: [member.id],
      } })).json();
      rows.push(message);
    }
    messages.push(rows);
  }
  const activityPath = (index: number) => `/app/workspaces/${workspaces[index].id}/activity`;
  await page.addInitScript(id => localStorage.setItem("minu-channels:last-workspace", id), workspaces[0].id);
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?actor=member&destination=${encodeURIComponent("/app/activity")}`)).json();
  const other = await context.newPage();
  try {
    await page.goto(launchUrl);
    await expect(page).toHaveURL(new RegExp(`${activityPath(0)}$`)); // legacy URL resolves to a scoped URL
    const badge = () => page.getByRole("navigation", { name: "Workspaces and Conversations" }).getByLabel(/unread Activity notification/);
    const rows = () => page.locator("[data-activity-id]");
    await expect(badge()).toHaveText("52");
    await expect(rows()).toHaveCount(50); // filter before pagination, not after a mixed global page
    await expect(page.locator(`[data-activity-id="${messages[1][0].id}"]`)).toHaveCount(0);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(rows()).toHaveCount(52);
    await other.goto(`${new URL(page.url()).origin}${activityPath(0)}`);
    await expect(other.locator(`[data-activity-id="${messages[0].at(-1)!.id}"]`)).toBeVisible();
    await page.getByLabel("Selected Workspace", { exact: true }).selectOption(workspaces[1].id);
    await expect(page).toHaveURL(new RegExp(`${activityPath(1)}$`));
    await expect(badge()).toHaveText("2");
    await expect(rows()).toHaveCount(2);
    await expect(page.locator(`[data-activity-id="${messages[0].at(-1)!.id}"]`)).toHaveCount(0);
    await expect(other).toHaveURL(new RegExp(`${activityPath(0)}$`));
    await expect(other.getByLabel("52 unread Activity notifications")).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${activityPath(1)}$`));
    await expect(badge()).toHaveText("2");
    await page.bringToFront();
    await page.locator(`[data-activity-id="${messages[1][0].id}"]`).getByRole("link").click();
    await expect(page.getByRole("log").getByText("Workspace 1 notification 1", { exact: true })).toBeVisible();
    await expect(badge()).toHaveCount(0);
    await expect(other.getByLabel("52 unread Activity notifications")).toBeVisible();
    await page.getByRole("navigation", { name: "Workspaces and Conversations" }).locator(`a[href="${activityPath(1)}"]`).click();
    await page.getByLabel("Selected Workspace", { exact: true }).selectOption(workspaces[0].id);
    await expect(page).toHaveURL(new RegExp(`${activityPath(0)}$`));
    await expect(badge()).toHaveText("52"); // switching/browsing Activity never acknowledged A
  } finally {
    await other.close();
    for (let index = 0; index < 2; index++) expect((await request.post(`${api}/conversations/${conversations[index].id}/read`, {
      headers: { "x-minu-actor-id": member.id }, data: { sequence: messages[index].at(-1)!.sequence },
    })).ok()).toBe(true);
  }
});

test("Activity receives unsubscribed thread replies, keeps full unread counts, and opens only the exact read scope", async ({ page, context, request }) => {
  const { workspaces } = await (await request.get(`${api}/workspaces`)).json();
  const workspace = workspaces.find((item: { name: string }) => item.name === "Browser Test");
  const { conversations } = await (await request.get(`${api}/workspaces/${workspace.id}/conversations`)).json() as { conversations: ConversationMetadata[] };
  const primary = conversations.find(item => item.name === "browser-collaboration")!;
  const human = primary.participants.find(p => p.type === "human")!;
  const agent = primary.participants.find(p => p.type === "agent")!;
  const { conversation } = await (await request.post(`${api}/conversations`, { data: {
    workspaceId: workspace.id, name: "Activity unread regression", participantIds: [human.id, agent.id],
  } })).json();
  const { message: root } = await (await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
    participantId: human.id, body: "Activity thread root", to: [],
  } })).json();
  const { thread } = await (await request.post(`${api}/conversations/${conversation.id}/threads`, { data: {
    actorIdentityId: human.id, rootMessageId: root.id,
  } })).json();
  for (let index = 0; index < 101; index++) {
    const response = await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
      participantId: agent.id, body: index === 100 ? "Activity direct mention" : `Background message ${index}`,
      to: index === 100 ? [human.id] : [],
    } });
    expect(response.ok()).toBe(true);
  }
  const { message: reply } = await (await request.post(`${api}/conversations/${thread.id}/messages`, { data: {
    participantId: agent.id, body: "Activity unmentioned thread reply", to: [],
  } })).json();
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(`/app/workspaces/${workspace.id}/activity`)}`)).json();
  await page.goto(launchUrl);
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  const row = page.locator(`[data-activity-conversation="${thread.id}"]`);
  await expect(row).toContainText("Activity thread root");
  await expect(row).toContainText("Activity unmentioned thread reply");
  await expect(row.getByLabel("Unread", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Activity unread regression/ }).getByLabel("101 unread messages, 1 direct mention")).toBeVisible();
  const count = (conversationId: string) => page.evaluate(async id => {
    const response = await fetch("/identities/me/inbox");
    const { summaries } = await response.json();
    return summaries.find((item: { conversationId: string }) => item.conversationId === id)?.count;
  }, conversationId);
  expect(await count(conversation.id)).toBe(101);
  expect(await count(thread.id)).toBe(1);
  const other = await context.newPage();
  try {
    await other.goto(`${new URL(page.url()).origin}/app/workspaces/${workspace.id}/activity`);
    await expect(other.locator(`[data-activity-id="${reply.id}"]`)).toBeVisible();
    await expect.poll(async () => (await (await request.get(`${fixture}/stream-metrics`)).json()).topics).toEqual([[]]);
    const { message: update } = await (await request.post(`${api}/conversations/${thread.id}/messages`, { data: {
      participantId: agent.id, body: "Activity arrived without a thread subscription", to: [],
    } })).json();
    await expect(page.locator(`[data-activity-id="${update.id}"]`)).toBeVisible();
    await expect(other.locator(`[data-activity-id="${update.id}"]`)).toBeVisible();
    expect(await count(thread.id)).toBe(2);
    await page.bringToFront();
    await row.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/conversations/${conversation.id}\\?.*#message-${root.sequence}$`));
    expect(new URL(page.url()).searchParams.get("threadId")).toBe(thread.id);
    await expect(page.getByRole("dialog", { name: "Thread", exact: true }).getByRole("log").locator('[data-message-sequence="1"]')).toBeFocused();
    await expect(page.getByText("Activity arrived without a thread subscription", { exact: true })).toBeVisible();
    await expect.poll(() => count(thread.id)).toBe(0);
    expect(await count(conversation.id)).toBe(101);
    await expect(other.locator(`[data-activity-conversation="${thread.id}"]`)).toBeVisible();
    await expect(other.locator(`[data-activity-conversation="${thread.id}"]`).getByLabel("Unread", { exact: true })).toHaveCount(0);
    const composer = page.getByRole("combobox", { name: "Thread reply", exact: true });
    await composer.focus();
    await request.post(`${api}/conversations/${thread.id}/messages`, { data: {
      participantId: agent.id, body: "Live update preserves draft focus", to: [],
    } });
    await expect(page.getByText("Live update preserves draft focus", { exact: true })).toBeVisible();
    await expect(composer).toBeFocused();
    await expect.poll(() => count(thread.id)).toBe(0);
    await other.bringToFront();
    // Playwright forces focus in headless Chromium. Exercise the unfocused guard explicitly.
    await page.evaluate(() => Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false }));
    const { message: hiddenReply } = await (await request.post(`${api}/conversations/${thread.id}/messages`, { data: {
      participantId: agent.id, body: "Must stay unread in the unfocused thread tab", to: [],
    } })).json();
    await expect(other.locator(`[data-activity-id="${hiddenReply.id}"]`)).toBeVisible();
    expect(await count(thread.id)).toBe(1);
    await page.evaluate(() => { Reflect.deleteProperty(document, "hasFocus"); window.dispatchEvent(new Event("focus")); });
    await page.bringToFront();
    await expect.poll(() => count(thread.id)).toBe(0);
    await page.reload();
    await expect.poll(() => count(conversation.id)).toBe(101);
  } finally {
    await other.close();
    // Leave the assertion above unread, but do not leak this test's data into other files.
    expect((await request.post(`${api}/conversations/${conversation.id}/read`, {
      headers: { "x-minu-actor-id": human.id }, data: { sequence: root.sequence + 101 },
    })).ok()).toBe(true);
  }
});

test("existing browser read marks migrate monotonically without resetting server state", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${api}/workspaces`)).json();
  const workspace = workspaces.find((item: { name: string }) => item.name === "Browser Test");
  const { conversations } = await (await request.get(`${api}/workspaces/${workspace.id}/conversations`)).json() as { conversations: ConversationMetadata[] };
  const primary = conversations.find(item => item.name === "browser-collaboration")!;
  const human = primary.participants.find(p => p.type === "human")!;
  const agent = primary.participants.find(p => p.type === "agent")!;
  const { conversation } = await (await request.post(`${api}/conversations`, { data: {
    workspaceId: workspace.id, name: "Legacy read marks", participantIds: [human.id, agent.id],
  } })).json();
  for (let index = 0; index < 6; index++) await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
    participantId: agent.id, body: `Legacy message ${index}`, to: [human.id],
  } });
  const key = `minu-channels:last-read:${human.id}:${conversation.id}`;
  await page.addInitScript(({ key }) => localStorage.setItem(key, "5"), { key });
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(`/app/workspaces/${workspace.id}/activity`)}`)).json();
  await page.goto(launchUrl);
  const summary = () => page.evaluate(async id => {
    const { summaries } = await (await fetch("/identities/me/inbox")).json();
    return summaries.find((item: { conversationId: string }) => item.conversationId === id);
  }, conversation.id);
  await expect.poll(async () => (await summary())?.readSequence).toBe(5);
  expect((await summary()).count).toBe(1);
  await page.evaluate(async id => {
    await fetch(`/conversations/${id}/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sequence: 6 }) });
  }, conversation.id);
  await page.reload(); // init script restores the older local mark, not the server cursor
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  expect((await summary()).readSequence).toBe(6);
  expect((await summary()).count).toBe(0);
});

test("Activity badge counts only unread notifications, works on mobile, and hides at zero", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${api}/workspaces`)).json();
  const workspace = workspaces.find((item: { name: string }) => item.name === "Browser Test");
  const { identities } = await (await request.get(`${api}/identities`)).json();
  const member = identities.find((item: { displayName: string }) => item.displayName === "Workspace Member");
  const owner = identities.find((item: { displayName: string }) => item.displayName === "David Kennedy");
  const { conversation } = await (await request.post(`${api}/conversations`, { data: {
    workspaceId: workspace.id, name: "Badge scope", participantIds: [member.id, owner.id],
  } })).json();
  const { message: root } = await (await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
    participantId: member.id, body: "Badge thread root", to: [],
  } })).json();
  const { thread } = await (await request.post(`${api}/conversations/${conversation.id}/threads`, { data: {
    actorIdentityId: member.id, rootMessageId: root.id,
  } })).json();
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?actor=member&destination=${encodeURIComponent(`/app/workspaces/${workspace.id}/activity`)}`)).json();
  await page.goto(launchUrl);
  const activityLink = () => page.getByRole("navigation", { name: "Workspaces and Conversations" }).locator(`a[href="/app/workspaces/${workspace.id}/activity"]`);
  const badge = () => activityLink().getByLabel(/unread Activity notification/);
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await expect(badge()).toHaveCount(0);
  for (let index = 0; index < 10; index++) await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
    participantId: owner.id, body: `Ordinary unread ${index}`, to: [],
  } });
  await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
    participantId: owner.id, body: "Badge mention", to: [member.id],
  } });
  const { message: reply } = await (await request.post(`${api}/conversations/${thread.id}/messages`, { data: {
    participantId: owner.id, body: "A mentioned thread reply counts once", to: [member.id],
  } })).json();
  await expect(badge()).toHaveText("2");
  await page.reload();
  await expect(badge()).toHaveText("2"); // browsing Activity does not clear it
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(badge()).toHaveText("2");
  await page.getByRole("button", { name: "Close navigation", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator(`[data-activity-id="${reply.id}"]`).getByRole("link").click();
  await expect(page.getByText("A mentioned thread reply counts once", { exact: true })).toBeVisible();
  await expect(badge()).toHaveText("1");
  await page.getByRole("dialog", { name: "Thread", exact: true }).getByRole("button", { name: "Close thread", exact: true }).click();
  await page.getByRole("log").evaluate(log => {
    const scroll = log.closest<HTMLElement>(".minu-scroll")!;
    scroll.scrollTop = scroll.scrollHeight;
  });
  await expect(page.getByRole("log").getByText("Badge mention", { exact: true })).toBeVisible();
  await expect(badge()).toHaveCount(0);
  // The other fixture human still has the member-authored root unread.
  expect((await request.post(`${api}/conversations/${conversation.id}/read`, {
    headers: { "x-minu-actor-id": owner.id }, data: { sequence: root.sequence },
  })).ok()).toBe(true);
});

test("a side thread opened from a parent Activity link ignores the parent's message hash when marking read", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${api}/workspaces`)).json();
  const workspace = workspaces.find((item: { name: string }) => item.name === "Browser Test");
  const { conversations } = await (await request.get(`${api}/workspaces/${workspace.id}/conversations`)).json() as { conversations: ConversationMetadata[] };
  const primary = conversations.find(item => item.name === "browser-collaboration")!;
  const human = primary.participants.find(p => p.type === "human")!;
  const agent = primary.participants.find(p => p.type === "agent")!;
  const { conversation } = await (await request.post(`${api}/conversations`, { data: {
    workspaceId: workspace.id, name: "Activity parent hash", participantIds: [human.id, agent.id],
  } })).json();
  await request.post(`${api}/conversations/${conversation.id}/messages`, { data: { participantId: human.id, body: "Earlier parent context", to: [] } });
  const { message: root } = await (await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
    participantId: human.id, body: "Root for the side thread", to: [],
  } })).json();
  const { message: mention } = await (await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
    participantId: agent.id, body: "Parent mention for Activity", to: [human.id],
  } })).json();
  const { thread } = await (await request.post(`${api}/conversations/${conversation.id}/threads`, { data: {
    actorIdentityId: human.id, rootMessageId: root.id,
  } })).json();
  await request.post(`${api}/conversations/${thread.id}/messages`, { data: {
    participantId: agent.id, body: "The visible side-thread reply", to: [],
  } });
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(`/app/workspaces/${workspace.id}/activity`)}`)).json();
  await page.goto(launchUrl);
  await page.locator(`[data-activity-id="${mention.id}"]`).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversation.id}\\?threadId=null#message-3$`));
  const threadUnread = () => page.evaluate(async id => {
    const { summaries } = await (await fetch("/identities/me/inbox")).json();
    return summaries.find((item: { conversationId: string }) => item.conversationId === id)?.count;
  }, thread.id);
  expect(await threadUnread()).toBe(1);
  await page.getByRole("button", { name: `Open actions for message ${root.sequence}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Open thread", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Thread", exact: true });
  await expect(panel.getByText("The visible side-thread reply", { exact: true })).toBeInViewport();
  await panel.getByRole("combobox", { name: "Thread reply", exact: true }).focus();
  await expect.poll(threadUnread).toBe(0);
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversation.id}\\?threadId=${thread.id}#message-${root.sequence}$`));
});

test("mobile Activity title stays clear of the navigation button", async ({ page, request }) => {
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent("/app/activity")}`)).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(launchUrl);
  const title = page.getByRole("heading", { name: "Activity", exact: true });
  await expect(title).toBeVisible();
  // Measure the text itself: padding can clear the button without moving the heading's box.
  const text = await title.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const menu = page.getByRole("button", { name: "Open navigation", exact: true });
  await expect(menu).toBeVisible();
  const button = (await menu.boundingBox())!;
  const overlap = Math.max(0, Math.min(text.x + text.width, button.x + button.width) - Math.max(text.x, button.x))
    * Math.max(0, Math.min(text.y + text.height, button.y + button.height) - Math.max(text.y, button.y));
  expect(overlap).toBe(0);
});

for (const recovery of ["stream", "polling"] as const) {
  test(`failed read acknowledgement retries after ${recovery} reconciliation with unchanged messages`, async ({ page, request }) => {
    test.setTimeout(45_000); // Polling uses the existing five-second snapshot interval.
    if (recovery === "polling") await page.addInitScript(() => {
      Object.defineProperty(window, "SharedWorker", { configurable: true, value: undefined });
    });
    const { workspaces } = await (await request.get(`${api}/workspaces`)).json();
    const workspace = workspaces.find((item: { name: string }) => item.name === "Browser Test");
    const { conversations } = await (await request.get(`${api}/workspaces/${workspace.id}/conversations`)).json() as { conversations: ConversationMetadata[] };
    const primary = conversations.find(item => item.name === "browser-collaboration")!;
    const human = primary.participants.find(p => p.type === "human")!;
    const agent = primary.participants.find(p => p.type === "agent")!;
    const { conversation } = await (await request.post(`${api}/conversations`, { data: {
      workspaceId: workspace.id, name: `Read retry ${recovery}`, participantIds: [human.id, agent.id],
    } })).json();
    const { message: root } = await (await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
      participantId: human.id, body: "Initial read position", to: [],
    } })).json();
    const destination = `/app/workspaces/${workspace.id}/conversations/${conversation.id}`;
    const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}`)).json();
    await page.goto(launchUrl);
    await expect(page.getByLabel(`Live updates ${recovery === "stream" ? "live" : "polling"}`)).toBeVisible();
    const summary = () => page.evaluate(async id => {
      const response = await fetch("/identities/me/inbox");
      if (!response.ok) return undefined;
      const { summaries } = await response.json();
      return summaries.find((item: { conversationId: string }) => item.conversationId === id);
    }, conversation.id);
    await expect.poll(async () => (await summary())?.readSequence).toBe(root.sequence);
    const baseline = await page.evaluate(async workspaceId => {
      const { summaries } = await (await fetch("/identities/me/inbox")).json();
      return summaries.filter((item: { workspaceId: string }) => item.workspaceId === workspaceId)
        .reduce((sum: number, item: { activityCount: number }) => sum + item.activityCount, 0);
    }, workspace.id);
    const readPath = `/conversations/${conversation.id}/read`;
    let attempts = 0;
    await page.route(`**${readPath}`, async route => {
      if (++attempts === 1) {
        // Let the new message finish layout before failing its acknowledgement.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporarily unavailable" }) });
      } else await route.continue();
    });
    const failed = page.waitForResponse(response => response.url().endsWith(readPath) && response.status() === 503);
    const body = `Visible message before ${recovery} recovery`;
    expect((await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
      participantId: agent.id, body, to: [human.id],
    } })).ok()).toBe(true);
    await expect(page.getByRole("log").getByText(body, { exact: true })).toBeInViewport({ timeout: 15_000 });
    await (await failed).finished();
    expect((await summary())?.count).toBe(1);
    expect(attempts).toBe(1);
    const badge = page.getByRole("navigation", { name: "Workspaces and Conversations" })
      .locator(`a[href="/app/workspaces/${workspace.id}/activity"]`).getByLabel(/unread Activity notification/);
    if (recovery === "stream") expect((await request.post(`${fixture}/disconnect?createMessage=false`)).ok()).toBe(true);
    // No browser online/focus/scroll event or new message in this scope triggers the retry.
    await expect.poll(async () => (await summary())?.count, { timeout: 15_000 }).toBe(0);
    expect((await summary())?.readSequence).toBe(root.sequence + 1);
    // Legacy cursor migration can also send an idempotent acknowledgement.
    expect(attempts).toBeGreaterThanOrEqual(2);
    await expect(page.getByLabel(`Live updates ${recovery === "stream" ? "live" : "polling"}`)).toBeVisible();
    if (baseline) await expect(badge).toHaveText(String(baseline));
    else await expect(badge).toHaveCount(0);
  });
}
