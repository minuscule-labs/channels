import { expect, test } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

test("threads keep replies and drafts separate, update counts live, and reopen after reload", async ({ page, request }, testInfo) => {
  const { workspaces } = await (await request.get(`${api}/workspaces`)).json();
  const workspace = workspaces.find(({ name }: { name: string }) => name === "Browser Test");
  const { conversations } = await (await request.get(`${api}/workspaces/${workspace.id}/conversations`)).json();
  const primary = conversations.find(({ name }: { name: string }) => name === "browser-collaboration");
  const human = primary.participants.find(({ type }: { type: string }) => type === "human");
  const agent = primary.participants.find(({ type }: { type: string }) => type === "agent");
  const created = await request.post(`${api}/conversations`, { data: {
    workspaceId: workspace.id, participantIds: [human.id, agent.id], name: "thread-browser-case",
  } });
  expect(created.ok()).toBe(true);
  const { conversation } = await created.json();
  const destination = `/app/workspaces/${workspace.id}/conversations/${conversation.id}`;
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}`)).json();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  const mainComposer = page.getByRole("combobox", { name: "Conversation message", exact: true });
  await mainComposer.fill("Root topic for the thread");
  await mainComposer.press("Enter");
  await expect(mainComposer).toHaveValue("");
  await mainComposer.fill("Main draft remains here");
  await page.getByRole("button", { name: "Start thread on message 1", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Thread", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("article", { name: "Thread root" })).toContainText("Root topic for the thread");
  const replyComposer = panel.getByRole("combobox", { name: "Thread reply", exact: true });
  await replyComposer.fill("Thread reply one");
  await replyComposer.press("Enter");
  await expect(replyComposer).toHaveValue("");
  await expect(panel.getByText("Thread reply one", { exact: true })).toBeVisible();
  await expect(mainComposer).toHaveValue("Main draft remains here");
  await expect(page.getByRole("button", { name: "Open thread for message 1: 1 replies", exact: true })).toBeVisible();

  const { threads } = await (await request.get(`${api}/conversations/${conversation.id}/threads`)).json();
  expect(threads).toHaveLength(1);
  const { messages } = await (await request.get(`${api}/conversations/${threads[0].id}/messages`)).json();
  const response = await request.post(`${api}/conversations/${threads[0].id}/responses`, { data: {
    participantId: agent.id, body: "Agent thread answer", triggerMessageId: messages[0].id, triggerSequence: messages[0].sequence,
  } });
  expect(response.ok()).toBe(true);
  await expect(panel.getByText("Agent thread answer", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open thread for message 1: 2 replies", exact: true })).toBeVisible();
  await replyComposer.fill("Unsent thread draft");
  await panel.getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByText("Thread reply one", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Agent thread answer", { exact: true })).toHaveCount(0);
  const roots = await (await request.get(`${api}/conversations/${conversation.id}/messages`)).json();
  expect(roots.messages).toHaveLength(1);

  await page.reload();
  await expect(mainComposer).toHaveValue("Main draft remains here");
  const threadButton = page.getByRole("button", { name: "Open thread for message 1: 2 replies", exact: true });
  await threadButton.click();
  await expect(replyComposer).toHaveValue("Unsent thread draft");
  await expect(panel.getByText("Agent thread answer", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(threadButton).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await threadButton.click();
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(390);
  await expect(replyComposer).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("thread-mobile.png") });
  await panel.getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(mainComposer).toHaveValue("Main draft remains here");

  await page.setViewportSize({ width: 1280, height: 900 });
  const archived = await request.patch(`${api}/conversations/${conversation.id}/lifecycle`, {
    data: { actorIdentityId: human.id, state: "settled" },
  });
  expect(archived.ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
  await threadButton.click();
  await expect(panel.getByRole("button", { name: "Reopen", exact: true })).toHaveCount(0);
  await expect(replyComposer).toBeDisabled();
  await panel.getByRole("button", { name: "Close thread", exact: true }).click();
});
