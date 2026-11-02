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
    data: { participantId: agent.id, body: "ROOT_FOR_REPLY_AND_THREAD" },
  }));
  const destination = `/app/workspaces/${workspace.id}/conversations/${conversation.id}`;
  const { launchUrl } = await json<{ launchUrl: string }>(request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}`));
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  const main = page.getByRole("combobox", { name: "Conversation message", exact: true });
  const recipient = page.getByRole("combobox", { name: "Message recipient", exact: true }).first();
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
  async function rootMenu() {
    const row = page.getByRole("log", { name: "Conversation messages", exact: true }).first().getByRole("article").filter({ hasText: root.body });
    await row.getByRole("button", { name: `Open actions for message ${root.sequence}`, exact: true }).click();
  }
  async function openThread() {
    await rootMenu();
    await page.getByRole("menuitem", { name: /^(Start|Open) thread$/ }).click();
    await expect(panel(page)).toBeVisible();
    const { threads } = await json<{ threads: ConversationThread[] }>(request.get(`${api}/conversations/${conversation.id}/threads`));
    return threads[0]!;
  }
  return { owner, agent, peer, peerHandle, conversation, root, main, recipient, send, rootMenu, openThread };
}

test("targeting: main followups stay selected; human mentions switch; broadcasts/multiple and incoming messages do not", async ({ page, request }) => {
  const f = await setup(page, request);
  await expect(f.recipient).toHaveValue("");
  expect((await f.send("Shared only, nobody selected")).to).toEqual([]);
  await f.main.fill(`@${f.agent.handle} First selected question`);
  await expect(f.recipient).toHaveValue(f.agent.id);
  await f.send(`@${f.agent.handle} First selected question`);
  for (let i = 1; i <= 3; i++) expect((await f.send(`Followup ${i}`)).to).toEqual([f.agent.id]);
  await f.recipient.selectOption(f.peer.id);
  expect((await f.send("Recipient control chooses a human")).to).toEqual([f.peer.id]);
  expect((await f.send(`@${f.agent.handle} Switch back`)).to).toEqual([f.agent.id]);
  await json(request.post(`${api}/conversations/${f.conversation.id}/messages`, { data: { participantId: f.peer.id, body: `@${f.peerHandle} Someone else's selection` } }));
  const { message: generated } = await json<{ message: ConversationMessage }>(request.post(`${api}/conversations/${f.conversation.id}/messages`, {
    data: { participantId: f.agent.id, body: `@${f.peerHandle} Agent generated reference` },
  }));
  expect(generated.to).toEqual([]);
  await expect(f.recipient).toHaveValue(f.agent.id);
  expect((await f.send("@channel Broadcast only")).to).toEqual(["@conversation"]);
  await expect(f.recipient).toHaveValue(f.agent.id);
  const multiple = await f.send(`@${f.agent.handle} @${f.peerHandle} Both recipients`);
  expect(multiple.to).toEqual([f.agent.id, f.peer.id]);
  await expect(f.recipient).toHaveValue(f.agent.id);
  await page.reload();
  await expect(f.recipient).toHaveValue(f.agent.id);
});

test("targeting: Reply selects without creating a thread; main and thread selections stay independent", async ({ page, request }) => {
  const f = await setup(page, request);
  await f.rootMenu();
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await expect(f.main).toBeFocused();
  await expect(f.recipient).toHaveValue(f.agent.id);
  const mainReply = await f.send("Reply in main, not a new thread");
  expect(mainReply.replyTo).toBe(f.root.id);
  expect(mainReply.to).toEqual([f.agent.id]);
  expect((await json<{ threads: ConversationThread[] }>(request.get(`${api}/conversations/${f.conversation.id}/threads`))).threads).toHaveLength(0);
  await f.recipient.selectOption(f.peer.id);
  const thread = await f.openThread();
  const childRecipient = panel(page).getByRole("combobox", { name: "Message recipient", exact: true });
  await expect(childRecipient).toHaveValue(f.agent.id);
  const first = await f.send("Thread default question", thread);
  expect(first.to).toEqual([f.agent.id]);
  const childRow = panel(page).getByRole("log").getByRole("article").filter({ hasText: first.body });
  await childRow.getByRole("button", { name: /Open actions for message/ }).click();
  await expect(page.getByRole("menuitem", { name: /^(Start|Open) thread$/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await expect(childRecipient).toHaveValue(f.owner.id);
  const reply = await f.send("Reply inside the thread", thread);
  expect(reply.replyTo).toBe(first.id); expect(reply.to).toEqual([f.owner.id]);
  await expect(f.recipient).toHaveValue(f.peer.id);
  await panel(page).getByRole("button", { name: "Close thread", exact: true }).click();
  await page.reload();
  await expect(f.recipient).toHaveValue(f.peer.id);
  await f.openThread();
  await expect(childRecipient).toHaveValue(f.owner.id);
});

test("targeting: an explicit control override survives reload; quoted/code mentions and no-recipient never guess", async ({ page, request }) => {
  const f = await setup(page, request);
  const body = `@${f.agent.handle} old text, different explicit recipient`;
  await f.main.fill(body);
  await f.recipient.selectOption(f.peer.id);
  await expect(f.recipient).toHaveValue(f.peer.id);
  await page.reload();
  await expect(f.recipient).toHaveValue(f.peer.id);
  expect((await f.send(body)).to).toEqual([f.peer.id]);
  await f.recipient.selectOption("");
  const quoted = `\`\`\`txt\n@${f.agent.handle}\n\`\`\`\n> @${f.agent.handle}\n\n"@${f.agent.handle}" reference`;
  expect((await f.send(quoted)).to).toEqual([]);
  await page.reload();
  await expect(f.recipient).toHaveValue("");
  await f.main.fill("@missing-recipient must not fall back");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
});
