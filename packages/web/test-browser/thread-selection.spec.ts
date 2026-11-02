import type { ConversationMetadata, ConversationThread } from "@minu/channels-core/types";
import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;
const panel = (page: Page) => page.getByRole("dialog", { name: "Thread", exact: true });

async function json<T>(response: Promise<APIResponse>): Promise<T> {
  const result = await response;
  expect(result.ok(), `${result.status()} ${result.url()}`).toBe(true);
  return await result.json() as T;
}

async function setup(request: APIRequestContext, page: Page) {
  const { workspaces } = await json<{ workspaces: Array<{ id: string; name: string }> }>(request.get(`${api}/workspaces`));
  const workspace = workspaces.find(({ name }) => name === "Browser Test")!;
  const { conversations } = await json<{ conversations: ConversationMetadata[] }>(request.get(`${api}/workspaces/${workspace.id}/conversations`));
  const primary = conversations.find(({ name }) => name === "browser-collaboration")!;
  const owner = primary.participants.find(({ type }) => type === "human")!;
  const agent = primary.participants.find(({ type }) => type === "agent")!;
  const channels: ConversationMetadata[] = [];
  for (const name of ["thread-memory-a", "thread-memory-b"]) {
    const { conversation } = await json<{ conversation: ConversationMetadata }>(request.post(`${api}/conversations`, { data: {
      workspaceId: workspace.id, name, participantIds: [owner.id, agent.id],
    } }));
    await json(request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
      participantId: agent.id, body: `ROOT_${name}`,
    } }));
    channels.push(conversation);
  }
  const [a, b] = channels as [ConversationMetadata, ConversationMetadata];
  const path = (channel: ConversationMetadata) => `/app/workspaces/${workspace.id}/conversations/${channel.id}`;
  const key = (channel: ConversationMetadata, identityId = owner.id) => `minu.conversations.open-thread.${workspace.id}.${channel.id}.${identityId}`;
  const destination = path(a);
  const { launchUrl } = await json<{ launchUrl: string }>(request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}`));
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Live updates live").first()).toBeVisible();
  return {
    a, b, owner, path, key,
    async navigate(channel: ConversationMetadata) {
      await page.locator(`a[href="${path(channel)}"]:visible`).first().click();
      await expect(page).toHaveURL(new RegExp(`${channel.id}$`));
      await expect(page.getByRole("heading", { name: `#${channel.name}`, exact: true })).toBeVisible();
    },
    async open(channel: ConversationMetadata) {
      await page.getByRole("button", { name: "Open actions for message 1", exact: true }).click();
      await page.getByRole("menuitem", { name: /^(Start|Open) thread$/ }).click();
      await expect(panel(page).getByRole("article", { name: "Thread root", exact: true })).toContainText(`ROOT_${channel.name}`);
      const { threads } = await json<{ threads: ConversationThread[] }>(request.get(`${api}/conversations/${channel.id}/threads`));
      return threads[0]!;
    },
  };
}

test("thread selection: restores each channel on navigation and reload; closing clears only that user's selection", async ({ page, request }) => {
  const startsOrSends: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/(start|messages)$/.test(new URL(request.url()).pathname)) startsOrSends.push(request.url());
  });
  const f = await setup(request, page);
  const a = await f.open(f.a);
  await panel(page).getByRole("combobox", { name: "Thread reply", exact: true }).fill("REMEMBERED_A_DRAFT");
  await f.navigate(f.b);
  await expect(panel(page)).toHaveCount(0);
  const b = await f.open(f.b);
  await f.navigate(f.a);
  await expect(panel(page).getByRole("article", { name: "Thread root", exact: true })).toContainText("ROOT_thread-memory-a");
  await expect(panel(page).getByRole("combobox", { name: "Thread reply", exact: true })).toHaveValue("REMEMBERED_A_DRAFT");
  await page.reload();
  await expect(panel(page).getByRole("article", { name: "Thread root", exact: true })).toContainText("ROOT_thread-memory-a");
  await expect(panel(page).getByRole("combobox", { name: "Thread reply", exact: true })).toHaveValue("REMEMBERED_A_DRAFT");
  expect(await page.evaluate((key) => localStorage.getItem(key), f.key(f.a))).toBe(a.id);
  await panel(page).getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open actions for message 1", exact: true })).toBeFocused();
  expect(await page.evaluate((key) => localStorage.getItem(key), f.key(f.a))).toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(key), f.key(f.b))).toBe(b.id);
  // Another user's saved selection must not open a panel for the current user.
  await page.evaluate(({ key, id }) => localStorage.setItem(key, id), { key: f.key(f.a, "another-human"), id: a.id });
  await page.reload();
  await expect(page.getByLabel("Live updates live").first()).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await f.navigate(f.b);
  await expect(panel(page).getByRole("article", { name: "Thread root", exact: true })).toContainText("ROOT_thread-memory-b");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), f.key(f.b))).toBeNull();
  await page.reload();
  await expect(page.getByLabel("Live updates live").first()).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  expect(startsOrSends).toEqual([]);
});

test("thread selection: rejects another channel's thread, but preserves a valid selection through a failed list request", async ({ page, request }) => {
  const f = await setup(request, page);
  const a = await f.open(f.a);
  await f.navigate(f.b);
  const b = await f.open(f.b);
  await f.navigate(f.a);
  await page.evaluate(({ key, id }) => localStorage.setItem(key, id), { key: f.key(f.a), id: b.id });
  await page.reload();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), f.key(f.a))).toBeNull();
  await expect(panel(page)).toHaveCount(0);
  await page.evaluate(({ key, id }) => localStorage.setItem(key, id), { key: f.key(f.a), id: a.id });
  const pattern = `**/conversations/${f.a.id}/threads`;
  await page.route(pattern, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary failure" }) }));
  const failure = page.waitForResponse((response) => response.url().endsWith(`/conversations/${f.a.id}/threads`) && response.status() === 503);
  await page.reload();
  await failure;
  expect(await page.evaluate((key) => localStorage.getItem(key), f.key(f.a))).toBe(a.id);
  await expect(panel(page)).toHaveCount(0);
  await page.unroute(pattern);
  await page.reload();
  await expect(panel(page).getByRole("article", { name: "Thread root", exact: true })).toContainText("ROOT_thread-memory-a");
});
