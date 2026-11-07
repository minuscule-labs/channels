import type { ConversationMessage, ConversationMetadata, ConversationThread } from "@minu/channels-core/types";
import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;
const panel = (page: Page) => page.getByRole("dialog", { name: "Thread", exact: true });

async function json<T>(response: Promise<APIResponse>): Promise<T> {
  const result = await response;
  expect(result.ok(), `${result.status()} ${result.url()}`).toBe(true);
  return await result.json() as T;
}

async function setup(page: Page, request: APIRequestContext) {
  const { workspaces } = await json<{ workspaces: Array<{ id: string; name: string }> }>(request.get(`${api}/workspaces`));
  const workspace = workspaces.find(({ name }) => name === "Browser Test")!;
  const { conversations } = await json<{ conversations: ConversationMetadata[] }>(request.get(`${api}/workspaces/${workspace.id}/conversations`));
  const primary = conversations.find(({ name }) => name === "browser-collaboration")!;
  const owner = primary.participants.find(({ type }) => type === "human")!;
  const agent = primary.participants.find(({ type }) => type === "agent")!;
  const { identity: peer } = await json<{ identity: { id: string } }>(request.post(`${api}/identities`, { data: { type: "human", displayName: "Other human" } }));
  const peerHandle = `peer-${peer.id.slice(-8)}`;
  await json(request.post(`${api}/workspaces/${workspace.id}/members`, { data: { identityId: peer.id, mentionHandle: peerHandle } }));
  const { conversation } = await json<{ conversation: ConversationMetadata }>(request.post(`${api}/conversations`, { data: {
    workspaceId: workspace.id, name: "recipient-targeting", participantIds: [owner.id, agent.id, peer.id],
  } }));
  const { message: root } = await json<{ message: ConversationMessage }>(request.post(`${api}/conversations/${conversation.id}/messages`, {
    data: { participantId: agent.id, body: "ROOT_FOR_THREAD" },
  }));
  const destination = `/app/workspaces/${workspace.id}/conversations/${conversation.id}`;
  const { launchUrl } = await json<{ launchUrl: string }>(request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}`));
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  const main = page.getByRole("combobox", { name: "Conversation message", exact: true });
  await expect(main).toBeEnabled();
  async function send(body: string, thread?: ConversationThread) {
    const scope = thread ? panel(page) : main.locator("xpath=ancestor::section[1]");
    const composer = thread ? scope.getByRole("combobox", { name: "Thread reply", exact: true }) : main;
    await composer.fill(body);
    await scope.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(composer).toHaveValue("");
    const { messages } = await json<{ messages: ConversationMessage[] }>(request.get(`${api}/conversations/${thread?.id ?? conversation.id}/messages`));
    return messages.find((message) => message.participantId === owner.id && message.body === body)!;
  }
  async function messageMenu(message = root, thread?: ConversationThread) {
    const scope = thread ? panel(page) : page;
    const row = scope.getByRole("log", { name: "Conversation messages", exact: true }).first().getByRole("article").filter({ hasText: message.body });
    await row.getByRole("button", { name: `Open actions for message ${message.sequence}`, exact: true }).click();
  }
  async function openThread() {
    await messageMenu();
    await page.getByRole("menuitem", { name: /^(Start|Open) thread$/ }).click();
    await expect(panel(page)).toBeVisible();
    const { threads } = await json<{ threads: ConversationThread[] }>(request.get(`${api}/conversations/${conversation.id}/threads`));
    return threads[0]!;
  }
  return { owner, agent, peer, peerHandle, conversation, root, main, send, messageMenu, openThread };
}

test("composer keeps attachment left and Send right without a recipient control or replacement text", async ({ page, request }, info) => {
  const f = await setup(page, request);
  const composer = page.locator(".composer").filter({ has: f.main });
  async function checkLayout(box: typeof composer) {
    await expect(box.locator("select")).toHaveCount(0);
    await expect(box.getByRole("button")).toHaveCount(3);
    await expect(box.getByRole("button", { name: "Skills", exact: true })).toBeVisible();
    await expect(box).toHaveText("Skills");
    const bounds = await box.boundingBox();
    const attachment = await box.getByRole("button", { name: "Attach images", exact: true }).boundingBox();
    const send = await box.getByRole("button", { name: "Send message", exact: true }).boundingBox();
    expect(bounds).not.toBeNull(); expect(attachment).not.toBeNull(); expect(send).not.toBeNull();
    expect(attachment!.x - bounds!.x).toBeLessThan(24);
    expect(bounds!.x + bounds!.width - send!.x - send!.width).toBeLessThan(24);
    expect(attachment!.x).toBeLessThan(send!.x);
    expect(Math.abs(attachment!.y + attachment!.height / 2 - send!.y - send!.height / 2)).toBeLessThan(2);
  }
  for (const [name, width] of [["desktop", 1280], ["mobile", 390]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await checkLayout(composer);
    await composer.screenshot({ path: info.outputPath(`composer-${name}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await f.openThread();
  const child = panel(page).locator(".composer");
  await checkLayout(child);
  await child.screenshot({ path: info.outputPath("composer-thread.png") });
  await expect(page.getByRole("combobox", { name: "Message recipient", exact: true })).toHaveCount(0);
});

test("targeting: main followups stay selected; human mentions switch; broadcasts/multiple and incoming messages do not", async ({ page, request }) => {
  const f = await setup(page, request);
  expect((await f.send("Shared only, nobody selected")).to).toEqual([]);
  expect((await f.send(`@${f.agent.handle} First selected question`)).to).toEqual([f.agent.id]);
  for (let i = 1; i <= 3; i++) expect((await f.send(`Followup ${i}`)).to).toEqual([f.agent.id]);
  expect((await f.send(`@${f.peerHandle} Select a human`)).to).toEqual([f.peer.id]);
  expect((await f.send("Followup for the selected human")).to).toEqual([f.peer.id]);
  expect((await f.send(`@${f.agent.handle} Switch back`)).to).toEqual([f.agent.id]);
  await json(request.post(`${api}/conversations/${f.conversation.id}/messages`, { data: { participantId: f.peer.id, body: `@${f.peerHandle} Someone else's selection` } }));
  const { message: generated } = await json<{ message: ConversationMessage }>(request.post(`${api}/conversations/${f.conversation.id}/messages`, {
    data: { participantId: f.agent.id, body: `@${f.peerHandle} Agent generated reference` },
  }));
  expect(generated.to).toEqual([f.peer.id]);
  expect((await f.send("Incoming messages did not switch me")).to).toEqual([f.agent.id]);
  expect((await f.send("@channel Broadcast only")).to).toEqual(["@conversation"]);
  const multiple = await f.send(`@${f.agent.handle} @${f.peerHandle} Both recipients`);
  expect(multiple.to).toEqual([f.agent.id, f.peer.id]);
  expect((await f.send("Followup after message-only overrides")).to).toEqual([f.agent.id]);
  await page.reload();
  expect((await f.send("Sticky target after reload")).to).toEqual([f.agent.id]);
});

test("targeting: menus only offer thread actions; mentions keep main and thread selections independent", async ({ page, request }, info) => {
  const f = await setup(page, request);
  await f.messageMenu();
  await expect(page.getByRole("menuitem")).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: "Start thread", exact: true })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Reply", exact: true })).toHaveCount(0);
  await page.getByRole("menu").screenshot({ path: info.outputPath("message-actions.png") });
  await page.keyboard.press("Escape");
  const mainMessage = await f.send(`@${f.agent.handle} Message in main, not a new thread`);
  expect(mainMessage.replyTo).toBeUndefined();
  expect(mainMessage.to).toEqual([f.agent.id]);
  expect((await json<{ threads: ConversationThread[] }>(request.get(`${api}/conversations/${f.conversation.id}/threads`))).threads).toHaveLength(0);
  expect((await f.send(`@${f.peerHandle} Select a different main recipient`)).to).toEqual([f.peer.id]);
  const thread = await f.openThread();
  expect((await f.send("Thread default question", thread)).to).toEqual([f.agent.id]);
  await expect(panel(page).getByRole("button", { name: "Reply", exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: /Open actions for message/ })).toHaveCount(0);
  const message = await f.send(`@${f.owner.handle} Message inside the thread`, thread);
  expect(message.replyTo).toBeUndefined();
  expect(message.to).toEqual([f.owner.id]);
  await panel(page).getByRole("button", { name: "Close thread", exact: true }).click();
  await page.reload();
  expect((await f.send("Main selection after reload")).to).toEqual([f.peer.id]);
  await f.messageMenu();
  await expect(page.getByRole("menuitem")).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: "Open thread", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await f.openThread();
  expect((await f.send("Thread selection after reload", thread)).to).toEqual([f.owner.id]);
});

test("targeting: editing a mention switches recipients and the draft survives reload", async ({ page, request }) => {
  const f = await setup(page, request);
  await f.main.fill(`@${f.agent.handle} Earlier recipient`);
  const body = `@${f.peerHandle} Updated recipient`;
  await f.main.fill(body);
  await page.reload();
  await expect(f.main).toHaveValue(body);
  expect((await f.send(body)).to).toEqual([f.peer.id]);
  expect((await f.send("Followup after the mention switch")).to).toEqual([f.peer.id]);
});

test("targeting: unselected conversations ignore quoted/code mentions and never guess", async ({ page, request }) => {
  const f = await setup(page, request);
  const quoted = `\`\`\`txt\n@${f.agent.handle}\n\`\`\`\n> @${f.agent.handle}\n\n"@${f.agent.handle}" reference`;
  expect((await f.send(quoted)).to).toEqual([]);
  await page.reload();
  expect((await f.send("Still nobody selected after reload")).to).toEqual([]);
  await f.main.fill("@missing-recipient must not fall back");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
});
