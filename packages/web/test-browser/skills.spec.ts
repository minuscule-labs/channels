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
  await expect(message(page)).toBeEnabled();
}
const message = (page: Page) => page.getByRole("combobox", { name: /^(Conversation message|Thread reply)$/ });
const sendSkill = (page: Page) => page.getByRole("button", { name: "Send skill" });
const receipt = (page: Page) => page.getByLabel("Skill receipt").getByRole("status");
async function published(page: Page) {
  // Wait on the retained receipt, not on controls that must disappear on success.
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.endsWith(".skill-request"))
    .some(key => JSON.parse(localStorage.getItem(key)!).publication?.status === "observed"))).toBe(true);
  await expect(message(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.getByLabel("Skill receipt")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Inspect receipt" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New request" })).toHaveCount(0);
}
async function pick(page: Page, source: "Channel" | "Workspace") {
  await message(page).fill("/Decision");
  const popup = page.getByRole("listbox", { name: "Skill suggestions", exact: true });
  await expect(popup).toBeVisible();
  await popup.getByRole("option").filter({ hasText: source }).first().click();
  await expect(popup).not.toBeVisible();
}
async function removeSkill(page: Page) {
  await page.getByRole("button", { name: "Skill details for Decision", exact: true }).click();
  await page.getByRole("button", { name: "Remove skill", exact: true }).click();
}
async function metrics(request: APIRequestContext, data: Setup) {
  const { calls, sessions } = await (await request.get(`${fixture}/metrics`)).json();
  return { calls: calls.slice(data.baseline) as Array<{ conversationId: string; identityId: string; turnId: string; input: string }>, sessions };
}
async function messages(request: APIRequestContext, scope: string) {
  return (await (await request.get(`${api}/conversations/${scope}/messages`)).json()).messages as Array<{ id: string; participantId: string; authoredInvocationId?: string; replyTo?: string; body: string; to: string[] }>;
}

test.use({ video: process.env.MINU_TEST_RECORD_VIDEO === "1" ? "on" : "off" });

test.describe("shared playbook message flow", () => {

  test("Channel-wide and human sends retain name-only Skill badges after reload", async ({ page, request }, info) => {
    const data = await setup(page, request);
    await pick(page, "Workspace");
    await message(page).fill("@channel Summarize the shared decision");
    await expect(sendSkill(page)).toBeEnabled();
    await page.screenshot({ path: info.outputPath("channel-wide-skill-draft.png") });
    await sendSkill(page).click();
    await published(page);
    await expect.poll(async () => (await metrics(request, data)).calls.length).toBe(2);
    const trigger = (await messages(request, data.parentId)).find(row => row.authoredInvocationId)!;
    expect(trigger.to).toEqual(["@conversation"]);
    const article = page.locator(`article[data-message-sequence="${(trigger as { sequence?: number }).sequence}"]`);
    await expect(article.getByLabel("Attached skill")).toHaveText("Decision");
    await expect(article.getByLabel("Attached skill")).not.toContainText("r1");
    await page.screenshot({ path: info.outputPath("channel-wide-skill-sent.png") });

    await message(page).fill("@owner For your review");
    await expect(sendSkill(page)).toBeEnabled();
    await sendSkill(page).click();
    await published(page);
    const human = (await messages(request, data.parentId)).find(row => row.body === "@owner For your review")!;
    expect(human.to).toEqual([data.ownerId]);
    await page.reload();
    await expect(page.getByLabel("Attached skill")).toHaveCount(2);
    await expect.poll(async () => (await metrics(request, data)).calls.length).toBe(2);
    await page.screenshot({ path: info.outputPath("sent-skill-badges-after-reload.png") });
  });

  test("create a shared Skill after agents start, then send it without a reset", async ({ page, request }, info) => {
    const data = await setup(page, request);
    const before = await metrics(request, data);
    await open(page, request, data, data.parentId, "owner");
    await page.goto(`/app/workspaces/${data.workspaceId}/settings/skills/new`);
    const editor = page.getByRole("region", { name: "Authored skills", exact: true });
    await editor.getByLabel("Name", { exact: true }).fill("Development Playbook");
    await editor.getByLabel("Description", { exact: true }).fill("Shared implementation procedure");
    await editor.getByLabel("Instructions", { exact: true }).fill("PRIVATE_WORKSPACE_PROCEDURE_NEW_AFTER_SESSION");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await open(page, request, data, data.parentId);
    await message(page).fill("/Development");
    const popup = page.getByRole("listbox", { name: "Skill suggestions" });
    await expect(popup.getByRole("option")).toHaveCount(1);
    await expect(popup).not.toContainText(/Harness|Ready|Pending|Unavailable/);
    await page.screenshot({ path: info.outputPath("new-skill-existing-session-picker.png") });
    await message(page).press("Enter");
    await message(page).fill("@selected Implement the agreed task");
    await expect(sendSkill(page)).toBeEnabled();
    await sendSkill(page).click();
    await published(page);
    await expect.poll(async () => (await metrics(request, data)).calls.length).toBe(1);
    await expect(page.getByLabel("Attached skill")).toHaveText("Development Playbook");
    const after = await metrics(request, data);
    expect(after.sessions).toBe(before.sessions);
    expect(after.calls[0]!.input).toContain("PRIVATE_WORKSPACE_PROCEDURE_NEW_AFTER_SESSION");
    expect((await messages(request, data.parentId)).map(row => row.body).join("\n")).not.toContain("PRIVATE_WORKSPACE_PROCEDURE");
    await page.screenshot({ path: info.outputPath("new-skill-sent-existing-session.png") });
  });

  test("unaddressed Skill publication does not silently target all agents", async ({ page, request }, info) => {
    const data = await setup(page, request);
    await pick(page, "Workspace");
    await expect(sendSkill(page)).toBeEnabled();
    await sendSkill(page).click();
    await published(page);
    const trigger = (await messages(request, data.parentId)).find(row => row.authoredInvocationId)!;
    expect(trigger.to).toEqual([]);
    await expect(page.getByLabel("Attached skill")).toHaveText("Decision");
    expect((await metrics(request, data)).calls).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("unaddressed-skill-normal-routing.png") });
  });
});

test("inline slash popup preserves drafts, supports keyboard selection and metadata-only chips without dropdowns or sending", async ({ page, request }, info) => {
  const data = await setup(page, request);
  const input = message(page), popup = page.getByRole("listbox", { name: "Skill suggestions", exact: true });
  await expect(page.getByRole("button", { name: "Skills", exact: true })).toHaveCount(0);
  await input.fill("@obs");
  await expect(page.getByRole("listbox", { name: "Mention suggestions" })).toBeVisible();
  await input.press("Escape");
  await input.fill("/Decision\nKeep draft");
  await expect(popup).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Skills", exact: true })).toHaveCount(0);
  await input.press("Escape");
  await expect(popup).not.toBeVisible();
  await expect(input).toHaveValue("/Decision\nKeep draft");
  await input.fill("/");
  const authored = popup.getByRole("option");
  await expect(authored).toHaveCount(2);
  await expect(authored.filter({ hasText: "Harness" })).toHaveCount(0);
  await expect(popup).not.toContainText(/Ready|Pending|Unavailable/);
  await expect(authored.filter({ hasText: "Channel · r1" })).toHaveCount(1);
  await expect(authored.filter({ hasText: "Workspace · r1" })).toHaveCount(1);
  await input.press("ArrowDown");
  await expect(authored.nth(1)).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowUp");
  await expect(authored.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: info.outputPath("inline-skill-popup.png") });
  await input.fill("/Workspace\nKeep draft");
  await expect(popup.getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  await expect(input).toHaveValue("Keep draft");
  await expect(input).toBeFocused();
  const chip = page.locator(".composer").getByLabel("Selected skill");
  await expect(chip).toHaveText("Decision");
  await expect(page.locator(".composer select")).toHaveCount(0);
  await expect(page.getByLabel("Skill availability")).toHaveCount(0);
  await input.fill("/literal arguments @selected");
  await input.press("Escape");
  await expect(popup).not.toBeVisible();
  await expect(sendSkill(page)).toBeEnabled();
  await chip.getByRole("button", { name: "Skill details for Decision" }).click();
  await expect(page.getByText("Workspace decision", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "View instructions", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await removeSkill(page);
  await expect(chip).toHaveCount(0);
  await expect(input).toHaveValue("/literal arguments @selected");
  expect((await metrics(request, data)).calls).toHaveLength(0);
});

test("inline pill supports Backspace, range editing and mention completion with exact context delivery", async ({ page, request }, info) => {
  const data = await setup(page, request);
  await pick(page, "Channel");
  const input = message(page), chip = page.getByLabel("Selected skill");
  const layout = await input.evaluate(element => {
    const chip = document.querySelector('[aria-label="Selected skill"]')!.getBoundingClientRect();
    return { top: chip.top - element.getBoundingClientRect().top, indent: parseFloat(getComputedStyle(element).textIndent), width: chip.width };
  });
  expect(layout.top).toBeCloseTo(10, 0);
  expect(layout.indent).toBeGreaterThan(layout.width);
  await input.fill("@sel");
  await expect(page.getByRole("listbox", { name: "Mention suggestions" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("skill-mentions.png") });
  await input.press("Enter");
  await expect(input).toHaveValue("@selected ");
  await expect(sendSkill(page)).toBeEnabled();
  await input.press("ControlOrMeta+Enter");
  await input.pressSequentially("Additional context: café & <details>.");
  const context = await input.inputValue();
  await input.press("Backspace");
  await expect(chip).toHaveText("Decision");
  await expect(input).toHaveValue(context.slice(0, -1));
  await input.fill(context);
  await input.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(0, 1));
  await input.press("Backspace");
  await expect(chip).toHaveText("Decision");
  await expect(input).toHaveValue(context.slice(1));
  await input.fill(context);
  await input.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(0, 0));
  await input.press("Backspace");
  await expect(chip).toHaveCount(0);
  await expect(input).toHaveValue(context);
  await expect(input).toBeFocused();
  await page.reload();
  await expect(input).toHaveValue(context);
  await input.fill(`/Channel\n${context}`);
  await page.getByRole("listbox", { name: "Skill suggestions" }).getByRole("option").click();
  await expect(sendSkill(page)).toBeEnabled();
  await page.screenshot({ path: info.outputPath("skill-context-no-dropdown.png") });
  await page.getByRole("button", { name: "Send skill", exact: true }).click();
  await published(page);
  const trigger = (await messages(request, data.parentId)).find(row => row.authoredInvocationId)!;
  expect(trigger.body).toBe(context);
  expect(trigger.to).toEqual([data.selectedId]);
  await expect.poll(async () => (await metrics(request, data)).calls.length).toBe(1);
  expect((await metrics(request, data)).calls[0]!.input).toContain(context);
});

test("skill mentions use ordinary editing rules, ignore quoted/code context, and retain the sticky recipient after send", async ({ page, request }) => {
  const data = await setup(page, request), sessions = (await metrics(request, data)).sessions;
  await pick(page, "Channel");
  await message(page).fill("@selected Initial task");
  await expect(sendSkill(page)).toBeEnabled();
  await message(page).fill("@owner Human target");
  await expect(sendSkill(page)).toBeEnabled();
  await message(page).fill("@observer Capture this\n> @owner @channel\n`@selected`\n```\n@owner\n```");
  await message(page).press("Escape");
  await expect(sendSkill(page)).toBeEnabled();
  await page.getByRole("button", { name: "Send skill" }).click();
  await published(page);
  await expect(message(page)).toHaveValue("");
  await expect.poll(async () => (await metrics(request, data)).calls.length).toBe(1);
  const trigger = (await messages(request, data.parentId)).find(row => row.authoredInvocationId)!;
  expect(trigger.to).toEqual([data.observerId]);
  expect((await metrics(request, data)).calls[0]!.identityId).toBe(data.observerId);
  expect((await metrics(request, data)).sessions).toBe(sessions);
  expect(JSON.stringify(await messages(request, data.parentId))).not.toMatch(/PRIVATE_.*PROCEDURE|private-browser/);
  await removeSkill(page);
  await message(page).fill("Sticky ordinary follow-up");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(message(page)).toHaveValue("");
  expect((await messages(request, data.parentId)).find(row => row.body === "Sticky ordinary follow-up")!.to).toEqual([data.observerId]);
  await page.reload();
  await pick(page, "Workspace");
  await message(page).fill("No mention, same sticky agent");
  await expect(sendSkill(page)).toBeEnabled();
  await page.getByRole("button", { name: "Send skill" }).click();
  await published(page);
  expect((await messages(request, data.parentId)).find(row => row.body === "No mention, same sticky agent")!.to).toEqual([data.observerId]);
});

test("multi-recipient skill sends and Channel-wide drafts do not replace the single sticky target", async ({ page, request }) => {
  const data = await setup(page, request);
  await pick(page, "Channel");
  for (const body of ["@selected Set sticky", "@selected @observer Both agents"]) {
    await message(page).fill(body);
    await page.getByRole("button", { name: "Send skill" }).click();
    await published(page);
    await expect(message(page)).toHaveValue("");
  }
  await message(page).fill("@channel Channel-wide draft");
  await expect(sendSkill(page)).toBeEnabled();
  await message(page).fill("@missing Unknown recipient");
  await expect(page.getByRole("button", { name: "Send skill" })).toBeDisabled();
  await message(page).fill("Sticky after removing mentions");
  await expect(sendSkill(page)).toBeEnabled();
  await page.getByRole("button", { name: "Send skill" }).click();
  await published(page);
  const history = await messages(request, data.parentId);
  expect(history.find(row => row.body === "Sticky after removing mentions")!.to).toEqual([data.selectedId]);
  expect(history.find(row => row.body === "@selected @observer Both agents")!.to.sort()).toEqual([data.selectedId, data.observerId].sort());
  expect(history.some(row => row.body.includes("Channel-wide draft") || row.body.includes("Unknown recipient"))).toBe(false);
});

test("new active mentions entered with a slash draft replace the prior sticky recipient", async ({ page, request }) => {
  const data = await setup(page, request);
  await pick(page, "Channel");
  await message(page).fill("@observer Establish sticky B");
  await page.getByRole("button", { name: "Send skill" }).click();
  await published(page);
  await removeSkill(page);
  const context = "@selected New recipient supplied with slash draft";
  await message(page).fill(`/Channel\n${context}`);
  await page.getByRole("listbox", { name: "Skill suggestions" }).getByRole("option").click();
  await expect(message(page)).toHaveValue(context);
  await page.getByRole("button", { name: "Send skill" }).click();
  await published(page);
  const trigger = (await messages(request, data.parentId)).find(row => row.body === context)!;
  expect(trigger.to).toEqual([data.selectedId]);
  await expect.poll(async () => (await metrics(request, data)).calls.filter(call => call.turnId.endsWith(`:${trigger.id}`)).map(call => call.identityId)).toEqual([data.selectedId]);
});

test("observed empty-argument multi-target receipts do not restore targets into a new draft after reload", async ({ page, request }) => {
  const data = await setup(page, request);
  await pick(page, "Channel");
  await message(page).fill("@selected Establish sticky A");
  await page.getByRole("button", { name: "Send skill" }).click();
  await published(page);
  await message(page).fill("@selected @observer Current recipients");
  await removeSkill(page);
  await pick(page, "Channel"); // Query-only entry must preserve A+B even with empty arguments.
  await expect(message(page)).toHaveValue("");
  await page.getByRole("button", { name: "Send skill" }).click();
  await published(page);
  const before = (await messages(request, data.parentId)).filter(row => row.authoredInvocationId);
  expect(before).toHaveLength(2);
  expect(before.find(row => row.body.startsWith("Use playbook:"))!.to.sort()).toEqual([data.selectedId, data.observerId].sort());
  await page.reload();
  await message(page).fill("Fresh mention-free follow-up");
  await page.getByRole("button", { name: "Send skill" }).click();
  await published(page);
  const trigger = (await messages(request, data.parentId)).find(row => row.body === "Fresh mention-free follow-up")!;
  expect(trigger.to).toEqual([data.selectedId]);
  await expect.poll(async () => (await metrics(request, data)).calls.filter(call => call.turnId.endsWith(`:${trigger.id}`)).map(call => call.identityId)).toEqual([data.selectedId]);
});

test("parent/thread and human drafts, skill choices and recipients remain independent through thread delivery", async ({ page, request }) => {
  const data = await setup(page, request);
  await pick(page, "Workspace");
  await message(page).fill("@observer Parent draft");
  await open(page, request, data, data.threadId);
  await expect(page.getByLabel("Selected skill")).toHaveCount(0);
  await expect(message(page)).toHaveValue("");
  await pick(page, "Channel");
  await message(page).fill("@selected Thread arguments");
  await page.getByRole("button", { name: "Send skill" }).click();
  await published(page);
  await expect.poll(async () => (await metrics(request, data)).calls.length).toBe(1);
  expect((await metrics(request, data)).calls[0]).toMatchObject({ conversationId: data.threadId, identityId: data.selectedId });
  await open(page, request, data, data.parentId);
  await expect(message(page)).toHaveValue("@observer Parent draft");
  await expect(page.getByLabel("Selected skill")).toHaveText("Decision");
  await open(page, request, data, data.parentId, "owner");
  await expect(message(page)).toHaveValue("");
  await expect(page.getByLabel("Selected skill")).toHaveCount(0);
  await open(page, request, data, data.parentId);
  await expect(message(page)).toHaveValue("@observer Parent draft");
});

test("new published revisions are usable without restarting while retirement still blocks", async ({ page, request }) => {
  const data = await setup(page, request), sessions = (await metrics(request, data)).sessions;
  await pick(page, "Channel");
  await message(page).fill("@selected Preserved arguments");
  await request.post(`${fixture}/change?workspace=${data.workspaceId}&document=${data.channelSkill}&action=publish`);
  await removeSkill(page);
  await message(page).fill("/Channel\n@selected Preserved arguments");
  const popup = page.getByRole("listbox", { name: "Skill suggestions" });
  await expect(popup.getByRole("option")).toContainText("r2", { timeout: 10_000 });
  await expect(popup).not.toContainText(/Ready|Pending|Unavailable/);
  await popup.getByRole("option").click();
  await expect(sendSkill(page)).toBeEnabled();
  await request.post(`${fixture}/change?workspace=${data.workspaceId}&document=${data.channelSkill}&action=archive`);
  await expect(sendSkill(page)).toBeDisabled({ timeout: 10_000 });
  await expect(message(page)).toHaveValue("@selected Preserved arguments");
  expect((await metrics(request, data)).calls).toHaveLength(0);
  expect((await metrics(request, data)).sessions).toBe(sessions);
});

test("successful skill sends hide recovery controls in flight, after completion and after reload", async ({ page, request }) => {
  const data = await setup(page, request);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let accepting = false;
  await page.route(`**/local/conversations/${data.parentId}/skill-invocations`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    accepting = true;
    await held;
    await route.continue();
  });
  try {
    await pick(page, "Channel");
    await message(page).fill("@selected First successful task");
    await page.getByRole("button", { name: "Send skill" }).click();
    await expect.poll(() => accepting).toBe(true);
    await expect(page.getByRole("button", { name: "Submitting skill" })).toBeDisabled();
    await expect(page.getByLabel("Skill receipt")).toHaveCount(0);
    release();
    await published(page);
    await expect(message(page)).toHaveValue("");
    await page.reload();
    await published(page);
    await message(page).fill("Second successful task");
    await page.getByRole("button", { name: "Send skill" }).click();
    await published(page);
    await expect(message(page)).toHaveValue("");
    await expect.poll(async () => (await messages(request, data.parentId)).filter(row => row.authoredInvocationId).length).toBe(2);
  } finally { release(); }
});

test("lost acceptance acknowledgment preserves edited mention recipients across reload before original publication", async ({ page, request }, info) => {
  const data = await setup(page, request);
  let accepts = 0, publishes = 0;
  await page.route(`**/local/conversations/${data.parentId}/skill-invocations`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    accepts += 1;
    const target = new URL(route.request().url()); target.hostname = "127.0.0.1";
    const response = await route.fetch({ url: target.href, headers: { ...route.request().headers(), host: target.host } });
    expect(response.status()).toBe(202);
    await route.abort("failed");
  });
  page.on("request", event => { if (event.method() === "POST" && event.url().endsWith("/skill-invocation-publications")) publishes += 1; });
  await pick(page, "Channel");
  await message(page).fill("@selected Uncertain acceptance");
  await page.getByRole("button", { name: "Send skill" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Submission unconfirmed" })).toBeVisible();
  await page.getByRole("button", { name: "Inspect receipt" }).click();
  await expect(receipt(page)).toHaveText("Not linked");
  await message(page).fill("@observer Uncertain acceptance");
  await expect(page.getByRole("button", { name: "Publish accepted" })).toBeDisabled();
  await page.reload();
  await expect(message(page)).toHaveValue("@observer Uncertain acceptance");
  await page.getByRole("button", { name: "Inspect receipt" }).click();
  await expect(receipt(page)).toHaveText("Not linked");
  await expect(message(page)).toHaveValue("@observer Uncertain acceptance");
  await expect(page.getByRole("button", { name: "Publish accepted" })).toBeDisabled();
  expect(accepts).toBe(1); expect(publishes).toBe(0);
  expect((await metrics(request, data)).calls).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("changed-mention-original-publication-blocked.png") });
  await message(page).fill("@selected Different task");
  await expect(page.getByRole("button", { name: "Publish accepted" })).toBeDisabled();
  await message(page).fill("@selected Uncertain acceptance");
  await page.getByRole("button", { name: "Publish accepted" }).click();
  await published(page);
  expect(accepts).toBe(1); expect(publishes).toBe(1);
  await expect.poll(async () => (await metrics(request, data)).calls.length).toBe(1);
  expect((await messages(request, data.parentId)).find(row => row.authoredInvocationId)!.to).toEqual([data.selectedId]);
});

test("committed lost publication acknowledgment survives reload and inspection never resends", async ({ page, request }) => {
  const data = await setup(page, request);
  let publications = 0;
  await page.route(`**/local/conversations/${data.parentId}/skill-invocation-publications`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    publications += 1;
    const target = new URL(route.request().url()); target.hostname = "127.0.0.1";
    const response = await route.fetch({ url: target.href, headers: { ...route.request().headers(), host: target.host } });
    expect(response.status()).toBe(200);
    await route.abort("failed");
  });
  await pick(page, "Channel");
  await message(page).fill("@selected Uncertain publication");
  await page.getByRole("button", { name: "Send skill" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Submission unconfirmed" })).toBeVisible();
  await expect(page.getByLabel("Skill receipt").getByRole("button", { name: "New request" })).toBeDisabled();
  await page.reload();
  await expect(message(page)).toHaveValue("@selected Uncertain publication");
  await page.getByRole("button", { name: "Inspect receipt" }).click();
  await published(page);
  await expect(message(page)).toHaveValue("");
  expect(publications).toBe(1);
  await expect.poll(async () => (await metrics(request, data)).calls.length).toBe(1);
});

for (const entry of ["slash", "alias"] as const) {
  test(`multiple mention recipients survive ${entry} skill attachment, context edits and reload, then each receive one turn`, async ({ page, request }) => {
    const data = await setup(page, request);
    await message(page).fill("@selected @observer Initial task");
    await message(page).fill(`${entry === "slash" ? "/Workspace" : "/skills Workspace"}\n@selected @observer Initial task`);
    await page.getByRole("listbox", { name: "Skill suggestions" }).getByRole("option").click();
    await message(page).fill("@selected @observer Changed context\n> @owner @channel\n`@owner`");
    await page.reload();
    await expect(sendSkill(page)).toBeEnabled();
    await page.getByRole("button", { name: "Send skill" }).click();
    await published(page);
    await expect.poll(async () => (await metrics(request, data)).calls.length).toBe(2);
    expect((await metrics(request, data)).calls.map(call => call.identityId).sort()).toEqual([data.selectedId, data.observerId].sort());
    const trigger = (await messages(request, data.parentId)).find(row => row.authoredInvocationId)!;
    expect(trigger.to.sort()).toEqual([data.selectedId, data.observerId].sort());
    await expect.poll(async () => (await messages(request, data.parentId)).filter(row => row.replyTo === trigger.id).length).toBe(2);
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
    await pick(page, "Channel");
    await message(page).fill("@selected Original arguments");
    await page.getByRole("button", { name: "Send skill" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Submission unconfirmed" })).toBeVisible();
    await page.getByRole("button", { name: "Inspect receipt" }).click();
    await expect.poll(() => inspected).toBe(true);
    await message(page).fill("@observer A newer draft");
    release();
    await published(page);
    await expect(message(page)).toHaveValue("@observer A newer draft");
    expect((await metrics(request, data)).calls).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Send skill" })).toBeEnabled();
  } finally { release(); }
});

test("ordinary composer retains selection rules after canceled picker or removed skill", async ({ page, request }) => {
  const data = await setup(page, request);
  await message(page).fill("@selected Initial draft");
  await message(page).fill("/skills\n@selected Initial draft");
  await message(page).press("Escape");
  await message(page).fill("Ordinary after canceled picker");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(message(page)).toHaveValue("");
  await pick(page, "Channel");
  await message(page).fill("@selected Ordinary after removed skill");
  await removeSkill(page);
  await expect(page.locator(".composer select")).toHaveCount(0);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(message(page)).toHaveValue("");
  const history = await messages(request, data.parentId);
  expect(history.find(row => row.body === "Ordinary after canceled picker")!.to).toEqual([]);
  expect(history.find(row => row.body === "@selected Ordinary after removed skill")!.to).toEqual([data.selectedId]);
});

test("publication-off host remains read-only and never falls back to ordinary send", async ({ page, request }) => {
  const data = await setup(page, request, false);
  await pick(page, "Channel");
  await message(page).fill("@selected Disabled invocation");
  await expect(sendSkill(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send skill" })).toBeDisabled();
  await message(page).press("Enter");
  expect((await messages(request, data.parentId)).filter(row => row.authoredInvocationId)).toHaveLength(0);
  expect((await metrics(request, data)).calls).toHaveLength(0);
});
