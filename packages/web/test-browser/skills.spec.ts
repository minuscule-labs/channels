import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;
const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
interface Setup { workspaceId: string; parentId: string; threadId: string; selectedId: string; observerId: string; memberId: string; ownerId: string; channelSkill: string; workspaceSkill: string; baseline: number }
async function setup(page: Page, request: APIRequestContext, enabled = true) {
  const response = await request.post(`${fixture}/setup?enabled=${enabled ? 1 : 0}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const data = await response.json() as Setup;
  await open(page, request, data, data.parentId);
  return data;
}
async function open(page: Page, request: APIRequestContext, data: Setup, scope: string, actor = "member") {
  const destination = `/app/workspaces/${data.workspaceId}/conversations/${scope}`;
  const response = await request.get(`${fixture}/control-launch?actor=${actor}&destination=${encodeURIComponent(destination)}`);
  await page.goto((await response.json()).launchUrl);
  await expect(page.getByRole("combobox", { name: /^(Conversation message|Thread reply)$/ })).toBeEnabled();
}
const message = (page: Page) => page.getByRole("combobox", { name: /^(Conversation message|Thread reply)$/ });
const recipient = (page: Page) => page.getByRole("combobox", { name: "Skill recipients", exact: true });
async function pick(page: Page, source: "Channel" | "Workspace", slash = true) {
  if (slash) await message(page).fill("/skills");
  else await page.getByRole("button", { name: "Skills", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Skills", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Search skills" }).fill("Decision");
  await dialog.getByRole("option").filter({ hasText: source }).first().click();
  await expect(dialog).not.toBeVisible();
}
async function metrics(request: APIRequestContext, data: Setup) {
  const { calls, sessions } = await (await request.get(`${fixture}/metrics`)).json();
  return { calls: calls.slice(data.baseline) as Array<{ conversationId: string; identityId: string; turnId: string; input: string }>, sessions };
}
async function messages(request: APIRequestContext, scope: string) {
  return (await (await request.get(`${api}/conversations/${scope}/messages`)).json()).messages as Array<{ id: string; participantId: string; authoredInvocationId?: string; replyTo?: string; body: string; to: string[] }>;
}

test("member discovers duplicate sources and unsupported Harness; explicit submit reaches only the preserved recipient", async ({ page, request }) => {
  const data = await setup(page, request);
  const sessions = (await metrics(request, data)).sessions;
  await expect(recipient(page)).toHaveCount(0);
  await message(page).fill("/skills");
  const dialog = page.getByRole("dialog", { name: "Skills", exact: true });
  await expect(dialog.getByRole("option").filter({ hasText: "Channel" })).toHaveCount(1);
  await expect(dialog.getByRole("option").filter({ hasText: "Workspace" })).toHaveCount(1);
  await expect(dialog.getByRole("option").filter({ hasText: "Harness" }).first()).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Search skills" }).fill("Channel decision");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await dialog.getByRole("option").click();
  await recipient(page).selectOption(data.selectedId);
  await expect(recipient(page)).toHaveValue(data.selectedId);
  await message(page).fill("Capture this @observer @channel");
  await expect(recipient(page)).toHaveValue(data.selectedId);
  await expect(page.getByLabel("Selected skill").getByRole("status")).toHaveText("Ready");
  await page.getByRole("button", { name: "Send skill", exact: true }).click();
  await expect(page.getByLabel("Skill receipt").getByRole("status")).toHaveText("Published");
  await expect(message(page)).toHaveValue("");
  await expect.poll(async () => (await metrics(request, data)).calls.filter(call => call.input.includes("PRIVATE_CHANNEL_PROCEDURE_V1")).length).toBe(1);
  const result = await metrics(request, data);
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0]).toMatchObject({ conversationId: data.parentId, identityId: data.selectedId });
  expect(result.sessions).toBe(sessions);
  const history = await messages(request, data.parentId);
  const trigger = history.find(row => row.authoredInvocationId)!;
  expect(trigger.participantId).toBe(data.memberId);
  expect(trigger.to).toEqual([data.selectedId]);
  expect(trigger.body).toBe("Capture this @observer @channel");
  expect(result.calls[0]!.turnId).toBe(`conversation:${data.parentId}:${data.selectedId}:${trigger.id}`);
  expect(JSON.stringify(history)).not.toMatch(/PRIVATE_.*PROCEDURE|private-browser/);
  await page.getByRole("button", { name: "Inspect receipt" }).click();
  expect((await metrics(request, data)).calls).toHaveLength(1);
});

test("parent/thread and human drafts, skill choices and recipients remain independent through real thread delivery", async ({ page, request }) => {
  const data = await setup(page, request);
  await pick(page, "Workspace");
  await recipient(page).selectOption(data.observerId);
  await message(page).fill("Parent draft");
  await open(page, request, data, data.threadId);
  await expect(page.getByLabel("Selected skill")).toHaveCount(0);
  await expect(message(page)).toHaveValue("");
  await pick(page, "Channel");
  await recipient(page).selectOption(data.selectedId);
  await message(page).fill("Thread arguments");
  await page.getByRole("button", { name: "Send skill", exact: true }).click();
  await expect(page.getByLabel("Skill receipt").getByRole("status")).toHaveText("Published");
  await expect.poll(async () => (await metrics(request, data)).calls.length).toBe(1);
  expect((await metrics(request, data)).calls[0]).toMatchObject({ conversationId: data.threadId, identityId: data.selectedId });
  await open(page, request, data, data.parentId);
  await expect(message(page)).toHaveValue("Parent draft");
  await expect(recipient(page)).toHaveValue(data.observerId);
  await expect(page.getByLabel("Selected skill")).toContainText("Workspace");
  await open(page, request, data, data.parentId, "owner");
  await expect(message(page)).toHaveValue("");
  await expect(page.getByLabel("Selected skill")).toHaveCount(0);
  await expect(recipient(page)).toHaveCount(0);
  await open(page, request, data, data.parentId);
  await expect(message(page)).toHaveValue("Parent draft");
  await expect(recipient(page)).toHaveValue(data.observerId);
});

test("recipient changes, new pending revision and retirement block rather than substitute or restart", async ({ page, request }) => {
  const data = await setup(page, request);
  const sessions = (await metrics(request, data)).sessions;
  await pick(page, "Channel");
  await recipient(page).selectOption(data.selectedId);
  await message(page).fill("Preserved arguments");
  await recipient(page).selectOption(data.ownerId);
  await expect(page.getByLabel("Selected skill").getByRole("status")).toHaveText("Unavailable");
  await expect(page.getByRole("button", { name: "Send skill" })).toBeDisabled();
  await recipient(page).selectOption(data.selectedId);
  await expect(page.getByLabel("Selected skill").getByRole("status")).toHaveText("Ready");
  await request.post(`${fixture}/change?workspace=${data.workspaceId}&document=${data.channelSkill}&action=publish`);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Skills", exact: true });
  await expect(dialog.getByRole("option").filter({ hasText: "Channel" })).toContainText("r2 · Pending", { timeout: 10_000 });
  await dialog.getByRole("option").filter({ hasText: "Channel" }).click();
  await expect(page.getByLabel("Selected skill").getByRole("status")).toHaveText("Pending");
  await expect(page.getByRole("button", { name: "Send skill" })).toBeDisabled();
  await request.post(`${fixture}/change?workspace=${data.workspaceId}&document=${data.channelSkill}&action=archive`);
  await expect(page.getByLabel("Selected skill").getByRole("status")).toHaveText("Unavailable", { timeout: 10_000 });
  await expect(message(page)).toHaveValue("Preserved arguments");
  expect((await metrics(request, data)).calls).toHaveLength(0);
  expect((await metrics(request, data)).sessions).toBe(sessions);
});

test("lost acceptance acknowledgment preserves changed draft recipients across reload before original publication", async ({ page, request }, testInfo) => {
  const data = await setup(page, request);
  let accepts = 0, publishes = 0;
  await page.route(`**/local/conversations/${data.parentId}/skill-invocations`, async route => {
    if (route.request().method() === "POST") {
      accepts += 1;
      const target = new URL(route.request().url()); target.hostname = "127.0.0.1";
      const committed = await route.fetch({ url: target.href, headers: { ...route.request().headers(), host: target.host } });
      expect(committed.status()).toBe(202);
      await route.abort("failed");
    }
    else await route.continue();
  });
  page.on("request", event => { if (event.method() === "POST" && event.url().endsWith("/skill-invocation-publications")) publishes += 1; });
  await pick(page, "Channel"); await recipient(page).selectOption(data.selectedId); await message(page).fill("Uncertain acceptance");
  await page.getByRole("button", { name: "Send skill" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Submission unconfirmed" })).toBeVisible();
  await expect(message(page)).toHaveValue("Uncertain acceptance");
  expect(publishes).toBe(0);
  await page.getByRole("button", { name: "Inspect receipt" }).click();
  await expect(page.getByLabel("Skill receipt").getByRole("status")).toHaveText("Not linked");
  expect(accepts).toBe(1); expect(publishes).toBe(0);
  await recipient(page).selectOption(data.observerId);
  await expect(page.getByRole("button", { name: "Publish accepted" })).toBeDisabled();
  await page.reload();
  await expect(message(page)).toHaveValue("Uncertain acceptance");
  await expect(recipient(page)).toHaveValue(data.observerId);
  await page.getByRole("button", { name: "Inspect receipt" }).click();
  await expect(page.getByLabel("Skill receipt").getByRole("status")).toHaveText("Not linked");
  await expect(page.getByRole("button", { name: "Inspect receipt" })).toBeEnabled();
  await expect(recipient(page)).toHaveValue(data.observerId);
  await expect(page.getByRole("button", { name: "Publish accepted" })).toBeDisabled();
  expect(accepts).toBe(1); expect(publishes).toBe(0);
  expect((await metrics(request, data)).calls).toHaveLength(0);
  const screenshot = testInfo.outputPath("changed-recipient-original-publication-blocked.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("changed-recipient-original-publication-blocked", { path: screenshot, contentType: "image/png" });
  await recipient(page).selectOption(data.selectedId);
  await message(page).fill("A different task");
  await expect(page.getByRole("button", { name: "Publish accepted" })).toBeDisabled();
  expect((await metrics(request, data)).calls).toHaveLength(0);
  await message(page).fill("Uncertain acceptance");
  await page.getByRole("button", { name: "Publish accepted" }).click();
  await expect(page.getByLabel("Skill receipt").getByRole("status")).toHaveText("Published");
  expect(accepts).toBe(1); expect(publishes).toBe(1);
  await expect.poll(async () => (await metrics(request, data)).calls.length).toBe(1);
  expect((await metrics(request, data)).calls[0]!.identityId).toBe(data.selectedId);
  const trigger = (await messages(request, data.parentId)).find(row => row.authoredInvocationId)!;
  expect(trigger.to).toEqual([data.selectedId]);
});

test("committed lost publication acknowledgment survives reload and inspection never resends", async ({ page, request }) => {
  const data = await setup(page, request);
  let publications = 0;
  await page.route(`**/local/conversations/${data.parentId}/skill-invocation-publications`, async route => {
    if (route.request().method() === "POST") {
      publications += 1;
      const target = new URL(route.request().url()); target.hostname = "127.0.0.1";
      const committed = await route.fetch({ url: target.href, headers: { ...route.request().headers(), host: target.host } });
      expect(committed.status()).toBe(200);
      await route.abort("failed");
    }
    else await route.continue();
  });
  await pick(page, "Channel"); await recipient(page).selectOption(data.selectedId); await message(page).fill("Uncertain publication");
  await page.getByRole("button", { name: "Send skill" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Submission unconfirmed" })).toBeVisible();
  await expect(page.getByLabel("Skill receipt").getByRole("button", { name: "New request" })).toBeDisabled();
  await page.reload();
  await expect(message(page)).toHaveValue("Uncertain publication");
  await expect(recipient(page)).toHaveValue(data.selectedId);
  await page.getByRole("button", { name: "Inspect receipt" }).click();
  await expect(page.getByLabel("Skill receipt").getByRole("status")).toHaveText("Published");
  await expect(message(page)).toHaveValue("");
  expect(publications).toBe(1);
  await expect.poll(async () => (await metrics(request, data)).calls.length).toBe(1);
});

for (const entry of ["button", "slash"] as const) {
test(`multiple human-chosen agents survive ${entry} skill entry, argument mentions and reload, then both receive exactly one turn`, async ({ page, request }, testInfo) => {
  const data = await setup(page, request);
  await message(page).fill("@selected @observer Initial task");
  await expect(recipient(page)).toHaveCount(0);
  if (entry === "slash") {
    await message(page).fill("/skills\n@selected @observer Initial task");
    await expect(page.getByRole("dialog", { name: "Skills", exact: true })).toBeVisible();
    await page.getByRole("dialog", { name: "Skills", exact: true }).getByRole("option").filter({ hasText: "Workspace" }).click();
  } else await pick(page, "Workspace", false);
  await expect(recipient(page)).toHaveValue("__multiple__");
  await message(page).fill("Changed arguments @owner @channel");
  await expect(recipient(page)).toHaveValue("__multiple__");
  await page.reload();
  await expect(message(page)).toHaveValue("Changed arguments @owner @channel");
  await expect(recipient(page)).toHaveValue("__multiple__");
  await page.getByRole("button", { name: "Send skill" }).click();
  await expect(page.getByLabel("Skill receipt").getByRole("status")).toHaveText("Published");
  await expect.poll(async () => (await metrics(request, data)).calls.length).toBe(2);
  expect((await metrics(request, data)).calls.map(call => call.identityId).sort()).toEqual([data.selectedId, data.observerId].sort());
  const trigger = (await messages(request, data.parentId)).find(row => row.authoredInvocationId)!;
  expect(trigger.to.sort()).toEqual([data.selectedId, data.observerId].sort());
  await expect.poll(async () => (await messages(request, data.parentId)).filter(row => row.replyTo === trigger.id).length).toBe(2);
  const screenshot = testInfo.outputPath(`two-recipients-${entry}-published.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(`two-recipients-${entry}-published`, { path: screenshot, contentType: "image/png" });
});
}

test("inspection preserves a newer draft and never republishes the original", async ({ page, request }) => {
  const data = await setup(page, request);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let inspected = false;
  await page.route(`**/local/conversations/${data.parentId}/skill-invocation-publications*`, async route => {
    const target = new URL(route.request().url()); target.hostname = "127.0.0.1";
    const response = await route.fetch({ url: target.href, headers: { ...route.request().headers(), host: target.host } });
    if (route.request().method() === "POST") { expect(response.status()).toBe(200); await route.abort("failed"); }
    else { inspected = true; await held; await route.fulfill({ response }); }
  });
  try {
    await pick(page, "Channel"); await recipient(page).selectOption(data.selectedId); await message(page).fill("Original arguments");
    await page.getByRole("button", { name: "Send skill" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Submission unconfirmed" })).toBeVisible();
    await page.getByRole("button", { name: "Inspect receipt" }).click();
    await expect.poll(() => inspected).toBe(true);
    await message(page).fill("A newer draft @owner");
    release();
    await expect(page.getByLabel("Skill receipt").getByRole("status")).toHaveText("Published");
    await expect(message(page)).toHaveValue("A newer draft @owner");
    await expect(recipient(page)).toHaveValue(data.selectedId);
    expect((await metrics(request, data)).calls).toHaveLength(1);
  } finally { release(); }
});

test("ordinary composer retains main selection rules after leaving skill mode", async ({ page, request }) => {
  const data = await setup(page, request);
  await message(page).fill("@selected Initial draft");
  await message(page).fill("/skills\n@selected Initial draft");
  await page.getByRole("dialog", { name: "Skills", exact: true }).press("Escape");
  await message(page).fill("Ordinary after canceled picker");
  await expect(recipient(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(message(page)).toHaveValue("");
  await pick(page, "Channel");
  await recipient(page).selectOption(data.selectedId);
  await message(page).fill("Ordinary after removed skill");
  await page.getByRole("button", { name: "Remove skill" }).click();
  await expect(recipient(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(message(page)).toHaveValue("");
  const ordinary = (await messages(request, data.parentId)).filter(row => row.body.startsWith("Ordinary after"));
  expect(ordinary).toHaveLength(2);
  expect(ordinary[0]!.to).toEqual([]);
  expect(ordinary[1]!.to).toEqual([data.selectedId]);
  for (const row of ordinary) expect(row.authoredInvocationId).toBeUndefined();
});

test("publication-off host remains read-only in the picker and never falls back to ordinary send", async ({ page, request }) => {
  const data = await setup(page, request, false);
  await pick(page, "Channel"); await recipient(page).selectOption(data.selectedId); await message(page).fill("Disabled invocation");
  await expect(page.getByLabel("Selected skill").getByRole("status")).toHaveText("Unavailable");
  await expect(page.getByRole("button", { name: "Send skill" })).toBeDisabled();
  await message(page).press("Enter");
  expect((await messages(request, data.parentId)).filter(message => message.authoredInvocationId)).toHaveLength(0);
  expect((await metrics(request, data)).calls).toHaveLength(0);
});
