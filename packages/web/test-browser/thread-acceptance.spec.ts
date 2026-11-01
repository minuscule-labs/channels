import type { ConversationMessage, ConversationMetadata, ConversationThread } from "@minu/channels-core/types";
import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

// Independently derived from the approved thread UX and run.md AC1/2/4.
// No mocked application API, cache, localStorage, or internal component calls.
const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;
const rootAlpha = "ACCEPTANCE_ROOT_ALPHA";
const rootBeta = "ACCEPTANCE_ROOT_BETA";

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
  const { conversation } = await json<{ conversation: ConversationMetadata }>(request.post(`${api}/conversations`, { data: {
    workspaceId: workspace.id, participantIds: primary.participants.map(({ id }) => id), name: "verifier-thread-acceptance",
  } }));
  for (const body of [rootAlpha, rootBeta]) await json(request.post(`${api}/conversations/${conversation.id}/messages`, {
    data: { participantId: owner.id, body },
  }));
  const destination = `/app/workspaces/${workspace.id}/conversations/${conversation.id}`;
  const { launchUrl } = await json<{ launchUrl: string }>(request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}`));
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Live updates live").first()).toBeVisible();
  return {
    conversation, owner,
    async threads() { return (await json<{ threads: ConversationThread[] }>(request.get(`${api}/conversations/${conversation.id}/threads`))).threads; },
    async messages(id: string) { return (await json<{ messages: ConversationMessage[] }>(request.get(`${api}/conversations/${id}/messages`))).messages; },
  };
}

const panel = (page: Page) => page.getByRole("dialog", { name: "Thread", exact: true });
const reply = (page: Page) => panel(page).getByRole("combobox", { name: "Thread reply", exact: true });
const mainComposer = (page: Page) => page.getByRole("combobox", { name: "Conversation message", exact: true });
const rootAction = (page: Page, body: string) => page.getByRole("log", { name: "Conversation messages", exact: true }).first()
  .getByRole("article").filter({ hasText: body }).getByRole("button", { name: /thread/i });
async function open(page: Page, body: string) {
  await rootAction(page, body).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("article", { name: "Thread root", exact: true })).toContainText(body);
}
async function close(page: Page) {
  await panel(page).getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
}
async function send(page: Page, body: string) {
  await reply(page).fill(body);
  await reply(page).press("Enter");
  await expect(reply(page)).toHaveValue("");
  await expect(panel(page).getByText(body, { exact: true })).toBeVisible();
}

test("acceptance: main/A/B drafts stay independent; peer replies update the right root and survive reload", async ({ page, request }, testInfo) => {
  const f = await setup(request, page);
  await mainComposer(page).fill("MAIN_UNSENT_DRAFT");
  await open(page, rootAlpha);
  await reply(page).fill("ALPHA_UNSENT_DRAFT");
  await close(page);
  await open(page, rootBeta);
  await expect(reply(page)).toHaveValue("");
  await reply(page).fill("BETA_UNSENT_DRAFT");
  await close(page);
  await open(page, rootAlpha);
  await expect(reply(page)).toHaveValue("ALPHA_UNSENT_DRAFT");
  await send(page, "ALPHA_FIRST_REPLY");
  await send(page, "ALPHA_SECOND_REPLY");
  await reply(page).fill("ALPHA_NEXT_DRAFT");
  await close(page);
  await expect(rootAction(page, rootAlpha)).toContainText("2 replies");
  await expect(mainComposer(page)).toHaveValue("MAIN_UNSENT_DRAFT");
  await expect(page.getByText("ALPHA_FIRST_REPLY", { exact: true })).toHaveCount(0);
  await expect(page.getByText("ALPHA_SECOND_REPLY", { exact: true })).toHaveCount(0);
  const threads = await f.threads();
  expect(threads).toHaveLength(2);
  const alphaRoot = (await f.messages(f.conversation.id)).find(({ body }) => body === rootAlpha)!;
  const alpha = threads.find(({ thread }) => thread.rootMessageId === alphaRoot.id)!;
  const beta = threads.find(({ id }) => id !== alpha.id)!;
  await json(request.post(`${api}/conversations/${beta.id}/messages`, { data: { participantId: f.owner.id, body: "BETA_PEER_REPLY" } }));
  await expect(rootAction(page, rootBeta)).toContainText("1 reply");
  await expect(rootAction(page, rootAlpha)).toContainText("2 replies");
  await expect(page.getByText("BETA_PEER_REPLY", { exact: true })).toHaveCount(0);
  await open(page, rootBeta);
  await expect(reply(page)).toHaveValue("BETA_UNSENT_DRAFT");
  await expect(panel(page).getByText("BETA_PEER_REPLY", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("ALPHA_FIRST_REPLY", { exact: true })).toHaveCount(0);
  await close(page);
  await page.reload();
  await expect(mainComposer(page)).toHaveValue("MAIN_UNSENT_DRAFT");
  await open(page, rootAlpha);
  await expect(reply(page)).toHaveValue("ALPHA_NEXT_DRAFT");
  await expect(panel(page).getByRole("log").getByRole("article")).toHaveText([/ALPHA_FIRST_REPLY/, /ALPHA_SECOND_REPLY/]);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(rootAction(page, rootAlpha)).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, rootBeta);
  await expect(reply(page)).toHaveValue("BETA_UNSENT_DRAFT");
  const bounds = await panel(page).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await expect(reply(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("independent-thread-mobile.png") });
  expect((await f.messages(f.conversation.id)).map(({ body }) => body)).toEqual([rootAlpha, rootBeta]);
  expect((await f.messages(alpha.id)).map(({ body }) => body)).toEqual(["ALPHA_FIRST_REPLY", "ALPHA_SECOND_REPLY"]);
  expect((await f.messages(beta.id)).map(({ body }) => body)).toEqual(["BETA_PEER_REPLY"]);
});

test("acceptance: lost reply acknowledgement retains A's retry key across B/main sends and browser reload", async ({ page, request }) => {
  const f = await setup(request, page);
  await open(page, rootAlpha);
  const alpha = (await f.threads())[0]!;
  const sends: Array<{ scope: string; key: string | undefined }> = [];
  let lost = false;
  let committedStatus: number | undefined;
  await page.route("**/conversations/*/messages", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    const scope = new URL(req.url()).pathname.split("/").at(-2)!;
    sends.push({ scope, key: req.headers()["idempotency-key"] });
    if (scope === alpha.id && !lost) {
      lost = true;
      // Node's resolver need not implement Chromium's *.localhost loopback mapping.
      const target = new URL(req.url());
      target.hostname = "127.0.0.1";
      const response = await route.fetch({ url: target.href }); // Real fixture API; lose only its acknowledgement.
      committedStatus = response.status();
      return route.abort("failed");
    }
    return route.continue();
  });
  const body = "SAME_TEXT_IN_THREE_SCOPES";
  await reply(page).fill(body);
  await reply(page).press("Enter");
  await expect(panel(page).getByRole("button", { name: "Retry same message", exact: true })).toBeVisible();
  expect(committedStatus).toBe(201);
  await close(page);
  await mainComposer(page).fill(body);
  await mainComposer(page).press("Enter");
  await expect(mainComposer(page)).toHaveValue("");
  await open(page, rootBeta);
  await expect(reply(page)).toHaveValue("");
  await expect(panel(page).getByRole("button", { name: "Retry same message", exact: true })).toHaveCount(0);
  await send(page, body);
  await close(page);
  const beta = (await f.threads()).find(({ id }) => id !== alpha.id)!;
  await page.reload();
  await open(page, rootAlpha);
  await expect(reply(page)).toHaveValue(body);
  await panel(page).getByRole("button", { name: "Retry same message", exact: true }).click();
  await expect(reply(page)).toHaveValue("");
  await expect(panel(page).getByText(body, { exact: true })).toHaveCount(1);
  const alphaSends = sends.filter(({ scope }) => scope === alpha.id);
  expect(alphaSends).toHaveLength(2);
  expect(alphaSends[0]!.key).toBeTruthy();
  expect(alphaSends[1]!.key).toBe(alphaSends[0]!.key);
  const keys = [alphaSends[0]!.key, sends.find(({ scope }) => scope === beta.id)?.key,
    sends.find(({ scope }) => scope === f.conversation.id)?.key];
  expect(keys.every(Boolean)).toBe(true);
  expect(new Set(keys).size).toBe(3);
  for (const id of [f.conversation.id, alpha.id, beta.id]) {
    expect((await f.messages(id)).filter((message) => message.body === body)).toHaveLength(1);
  }
  await close(page);
  await expect(rootAction(page, rootAlpha)).toContainText("1 reply");
  await expect(rootAction(page, rootBeta)).toContainText("1 reply");
});

// Manual v1 (Conversation messages 59–62): a rendered summary can be transferred
// as an ordinary human message. No new Copy/Share action or system clipboard use.
test("acceptance: manual summary copy/post returns only the selected outcome to main without syncing thread history", async ({ page, request }) => {
  const f = await setup(request, page);
  await open(page, rootAlpha);
  const thread = (await f.threads())[0]!;
  const ask = "@builder Summarize this thread's decision for the main conversation.";
  await send(page, ask);
  const trigger = (await f.messages(thread.id)).find(({ body }) => body === ask)!;
  const agent = f.conversation.participants.find(({ type }) => type === "agent")!;
  const summary = "Summary: choose BLUE for this workstream. Next: validate the decision in the main conversation.";
  // A controlled provider outcome through the real response API; this is not a
  // test of a live model's ability to produce an accurate natural-language summary.
  await json(request.post(`${api}/conversations/${thread.id}/responses`, { data: {
    participantId: agent.id, body: summary, triggerMessageId: trigger.id, triggerSequence: trigger.sequence,
  } }));
  const rendered = panel(page).getByRole("log").getByText(summary, { exact: true });
  await expect(rendered).toBeVisible();
  const original = (await f.messages(thread.id)).find(({ body }) => body === summary)!;
  const threadIds = (await f.messages(thread.id)).map(({ id }) => id);
  expect((await f.messages(f.conversation.id)).map(({ body }) => body)).toEqual([rootAlpha, rootBeta]);
  const copiedText = await rendered.innerText(); // Read visible text; do not mutate the user's OS clipboard.
  await close(page);
  await expect(page.getByText(summary, { exact: true })).toHaveCount(0);
  await mainComposer(page).fill(copiedText);
  await mainComposer(page).press("Enter");
  await expect(mainComposer(page)).toHaveValue("");
  await expect(page.getByRole("log").getByText(summary, { exact: true })).toBeVisible();
  const main = await f.messages(f.conversation.id);
  expect(main.map(({ body }) => body)).toEqual([rootAlpha, rootBeta, copiedText]);
  const shared = main.at(-1)!;
  expect(shared.participantId).toBe(f.owner.id);
  expect(shared.id).not.toBe(original.id);
  expect(shared.conversationId).toBe(f.conversation.id);
  expect(shared.replyTo).toBeUndefined();
  expect((await f.messages(thread.id)).map(({ id }) => id)).toEqual(threadIds);

  await open(page, rootAlpha);
  const later = "THREAD_ONLY_CLARIFICATION_AFTER_MANUAL_SHARE";
  await send(page, later);
  await expect(panel(page).getByText(summary, { exact: true })).toBeVisible();
  await close(page);
  await expect(rootAction(page, rootAlpha)).toContainText("3 replies");
  await expect(page.getByText(later, { exact: true })).toHaveCount(0);
  expect((await f.messages(f.conversation.id)).map(({ id, body }) => ({ id, body })))
    .toEqual(main.map(({ id, body }) => ({ id, body })));
  expect((await f.messages(thread.id)).map(({ body }) => body)).toEqual([ask, summary, later]);
});
