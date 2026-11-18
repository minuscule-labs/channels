import { expect, test, type Locator } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

async function expectCloseLayout(panel: Locator) {
  const close = panel.getByRole("button", { name: "Close thread", exact: true });
  const participants = panel.getByRole("button", { name: "Show participants", exact: true });
  const closeBox = (await close.boundingBox())!;
  const participantsBox = (await participants.boundingBox())!;
  const icon = (await close.locator("svg").boundingBox())!;
  const header = await close.evaluate((element) => {
    const header = element.closest("header")!;
    const box = header.getBoundingClientRect();
    return { right: box.right - parseFloat(getComputedStyle(header).paddingRight), centerY: box.y + box.height / 2 };
  });
  expect(closeBox.x).toBeGreaterThanOrEqual(participantsBox.x + participantsBox.width);
  expect(Math.abs(closeBox.x + closeBox.width - header.right)).toBeLessThan(1);
  expect(Math.abs(closeBox.y + closeBox.height / 2 - header.centerY)).toBeLessThan(1);
  expect(Math.abs(icon.x + icon.width / 2 - (closeBox.x + closeBox.width / 2))).toBeLessThan(1);
  expect(Math.abs(icon.y + icon.height / 2 - (closeBox.y + closeBox.height / 2))).toBeLessThan(1);
}

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
  const messageMenu = page.getByRole("button", { name: "Open actions for message 1", exact: true });
  await expect(messageMenu).toHaveCSS("border-top-width", "0px");
  await expect(page.getByRole("button", { name: /Start thread on message/ })).toHaveCount(0);
  await messageMenu.focus();
  await messageMenu.press("ArrowDown");
  const startThread = page.getByRole("menuitem", { name: "Start thread", exact: true });
  await expect(startThread).toBeFocused();
  await expect(page.getByRole("menuitem")).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: "Reply", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(messageMenu).toBeFocused();
  await messageMenu.click();
  // Raw coordinate clicks do not wait for the menu's mount/focus lifecycle.
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menu")).toBeFocused();
  // The modal menu aria-hides the composer, but it remains the visual click target.
  const composerBox = (await page.getByRole("combobox", {
    name: "Conversation message", exact: true, includeHidden: true,
  }).boundingBox())!;
  await page.mouse.click(composerBox.x + 10, composerBox.y + 10);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(mainComposer).toHaveValue("Main draft remains here");
  let failCreation = true;
  await page.route("**/conversations/*/threads", async (route) => {
    if (route.request().method() === "POST" && failCreation) {
      failCreation = false;
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporarily unavailable" }) });
    }
    return route.continue();
  });
  await messageMenu.click();
  await startThread.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(messageMenu).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Thread", exact: true })).toHaveCount(0);
  await messageMenu.focus();
  await messageMenu.press("ArrowDown");
  await startThread.press("Enter");
  const panel = page.getByRole("dialog", { name: "Thread", exact: true });
  await expect(panel).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect.poll(() => panel.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await expectCloseLayout(panel);
  await page.screenshot({ path: testInfo.outputPath("thread-desktop.png") });
  await expect(panel.getByRole("article", { name: "Thread root" })).toContainText("Root topic for the thread");
  const replyComposer = panel.getByRole("combobox", { name: "Thread reply", exact: true });
  await replyComposer.fill("Thread reply one");
  await replyComposer.press("Enter");
  await expect(replyComposer).toHaveValue("");
  await expect(panel.getByText("Thread reply one", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: /Open actions for message/ })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Reply", exact: true })).toHaveCount(0);
  await expect(panel).toBeVisible();
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
  await expect(messageMenu).toBeFocused();
  await messageMenu.click();
  await page.getByRole("menuitem", { name: "Open thread", exact: true }).click();
  await expect(replyComposer).toHaveValue("Unsent thread draft");
  await panel.getByRole("button", { name: "Close thread", exact: true }).click();
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
  await messageMenu.click();
  const mobileMenu = (await page.getByRole("menu").boundingBox())!;
  expect(mobileMenu.x).toBeGreaterThanOrEqual(0);
  expect(mobileMenu.x + mobileMenu.width).toBeLessThanOrEqual(390);
  await page.getByRole("menuitem", { name: "Open thread", exact: true }).click();
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(390);
  await expect(replyComposer).toBeVisible();
  await expectCloseLayout(panel);
  await page.screenshot({ path: testInfo.outputPath("thread-mobile.png") });
  await panel.getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(mainComposer).toHaveValue("Main draft remains here");

  await page.setViewportSize({ width: 1280, height: 900 });
  const continued = await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
    participantId: human.id, body: "Another message without a thread",
  } });
  expect(continued.ok()).toBe(true);
  const continuedMenu = page.getByRole("button", { name: "Open actions for message 2", exact: true });
  await continuedMenu.click();
  await expect(startThread).toBeEnabled();
  await page.keyboard.press("Escape");
  const archived = await request.patch(`${api}/conversations/${conversation.id}/lifecycle`, {
    data: { actorIdentityId: human.id, state: "settled" },
  });
  expect(archived.ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
  await continuedMenu.click();
  await expect(startThread).toBeDisabled();
  await page.keyboard.press("Escape");
  await messageMenu.click();
  await expect(page.getByRole("menuitem", { name: "Open thread", exact: true })).toBeEnabled();
  await page.getByRole("menuitem", { name: "Open thread", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Reopen", exact: true })).toHaveCount(0);
  await expect(replyComposer).toBeDisabled();
  await panel.getByRole("button", { name: "Close thread", exact: true }).click();
});
