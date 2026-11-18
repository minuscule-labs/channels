import { expect, test } from "@playwright/test";
import type { ConversationMetadata } from "@minu/channels-core/types";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

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
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent("/app/activity")}`)).json();
  await page.goto(launchUrl);
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  const row = page.locator(`[data-activity-id="${reply.id}"]`);
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
    await other.goto(`${new URL(page.url()).origin}/app/activity`);
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
    await expect(page).toHaveURL(new RegExp(`/conversations/${thread.id}#message-1$`));
    await expect(page.getByText("Activity arrived without a thread subscription", { exact: true })).toBeVisible();
    await expect.poll(() => count(thread.id)).toBe(0);
    expect(await count(conversation.id)).toBe(101);
    await expect(other.locator(`[data-activity-id="${reply.id}"]`).getByLabel("Unread", { exact: true })).toHaveCount(0);
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
  } finally { await other.close(); }
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
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent("/app/activity")}`)).json();
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
