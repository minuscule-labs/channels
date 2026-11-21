import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;
const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
async function call(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, { method, credentials: "include", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
}
async function setup(page: Page, request: APIRequestContext, suffix: string) {
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent("/app/account/settings/presets")}`)).json();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  const skill = (await call(page, "/local/account/library", "POST", { kind: "skill", name: `Preset skill ${suffix}`, description: "Shared procedure", content: "PRIVATE_PRESET_SKILL_BODY" })).body;
  const template = (await call(page, "/local/account/library", "POST", { kind: "agent-template", name: `Preset agent ${suffix}`, description: "Starter", configuration: { personaPrompt: "BASE_AGENT_INSTRUCTIONS", runtimeAdapter: "pi", accountSkillIds: [skill.id] } })).body;
  const content = { kind: "workspace-preset", name: `Workspace preset ${suffix}`, description: "Reusable setup", definition: {
    agents: [{ key: "review", templateId: template.id, displayName: "Reviewer", mentionHandle: "reviewer", accountSkillIds: [skill.id] }],
    conversationPresets: [{ name: "Review", agentKeys: ["review"], guidance: "Review the change" }], instructions: "WORKSPACE_PRESET_DEFAULTS", turnTimeoutMs: 7_200_000,
  } };
  return { skill, template, content };
}
async function openCreation(page: Page, presetId: string, name: string) {
  await page.getByRole("button", { name: "Add Workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add Workspace", exact: true });
  await dialog.getByLabel("Workspace preset", { exact: true }).selectOption(presetId);
  const review = dialog.getByRole("region", { name: "Review workspace composition", exact: true });
  await expect(review).toBeVisible();
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByLabel("Source folder", { exact: true }).fill("/tmp");
  return { dialog, review };
}

test("account workspace preset CRUD and reviewed workspace composition create independent starters and shared references", async ({ page, request }) => {
  const f = await setup(page, request, "crud");
  await page.reload();
  await page.getByRole("link", { name: "New workspace preset", exact: true }).click();
  const editor = page.getByRole("form", { name: "Workspace preset editor", exact: true });
  await editor.getByLabel("Name", { exact: true }).fill(f.content.name);
  await editor.getByLabel("Description", { exact: true }).fill("Account setup");
  await editor.getByRole("button", { name: "Add starter agent", exact: true }).click();
  const agent = editor.getByRole("region", { name: "Starter agent 1", exact: true });
  await agent.getByLabel("Agent template", { exact: true }).selectOption(f.template.id);
  await agent.getByLabel("Display name", { exact: true }).fill("Reviewer");
  await agent.getByLabel("Mention handle", { exact: true }).fill("reviewer");
  await editor.getByLabel("Workspace instructions", { exact: true }).fill("WORKSPACE_PRESET_DEFAULTS");
  await editor.getByLabel("Turn timeout", { exact: true }).selectOption("7200000");
  await editor.getByRole("button", { name: "Add conversation preset", exact: true }).click();
  const conversation = editor.getByRole("region", { name: "Conversation preset 1", exact: true });
  await conversation.getByLabel("Preset name", { exact: true }).fill("Review");
  await conversation.getByLabel("Guidance", { exact: true }).fill("Review the change");
  await conversation.getByRole("checkbox", { name: "Reviewer", exact: true }).check();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/presets\/[a-f0-9-]+$/);
  const presetId = page.url().split("/").at(-1)!;
  await editor.getByLabel("Description", { exact: true }).fill("Edited reusable setup");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByRole("status")).toHaveText("Saved");
  await page.reload();
  await expect(editor.getByLabel("Description", { exact: true })).toHaveValue("Edited reusable setup");
  const { dialog, review } = await openCreation(page, presetId, "Composed browser workspace");
  await review.getByLabel("Workspace instructions", { exact: true }).fill("CUSTOM_WORKSPACE_BEFORE_CREATE");
  const starter = review.getByRole("region", { name: "Starter agent 1", exact: true });
  await starter.getByLabel("Display name", { exact: true }).fill("Local reviewer");
  await starter.getByLabel("Mention handle", { exact: true }).fill("local-reviewer");
  await starter.getByLabel("Agent instructions", { exact: true }).fill("CUSTOM_AGENT_BEFORE_CREATE");
  await expect(starter.getByRole("checkbox", { name: f.skill.name, exact: true })).toBeChecked();
  const submitted = page.waitForRequest(req => req.url().endsWith("/local/workspace-compositions") && req.method() === "POST");
  await dialog.getByRole("button", { name: "Create Workspace", exact: true }).click();
  const payload = (await submitted).postDataJSON();
  await expect(page).toHaveURL(/\/workspaces\/workspace_[a-f0-9]+\/conversations\/conversation_[a-f0-9]+$/);
  const receipt = (await call(page, `/local/workspace-compositions/${payload.requestId}`)).body;
  const config = (await call(page, `/local/workspaces/${receipt.workspaceId}/agents/${receipt.agents[0].identityId}/config`)).body;
  expect(config.instructions.text).toBe("CUSTOM_AGENT_BEFORE_CREATE");
  expect(config.accountSkills.skillIds).toEqual([f.skill.id]);
  const documents = (await call(page, `/local/workspaces/${receipt.workspaceId}/authored-documents`)).body;
  expect((await call(page, `/local/workspaces/${receipt.workspaceId}/authored-documents/${documents[0].id}`)).body.content).toBe("CUSTOM_WORKSPACE_BEFORE_CREATE");
  expect((await call(page, `/local/workspaces/${receipt.workspaceId}/conversation-presets`)).body.presets[0].participants).toEqual([{ identityId: receipt.agents[0].identityId }]);
  expect((await call(page, `/local/account/library/${f.template.id}`)).body.configuration.personaPrompt).toBe("BASE_AGENT_INSTRUCTIONS");
  expect(await page.evaluate(() => Object.values(localStorage).some(value => /CUSTOM_AGENT_BEFORE_CREATE|PRIVATE_PRESET_SKILL_BODY/.test(value)))).toBe(false);
  await page.goto(`/app/account/settings/presets/${presetId}`);
  await editor.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page).toHaveURL(/\/account\/settings\/presets$/);
  await expect(page.getByRole("table").getByRole("link", { name: f.content.name, exact: true })).toHaveCount(0);
});

test("cancelled preset review creates nothing and retains editable setup on reopen", async ({ page, request }) => {
  const f = await setup(page, request, "cancel");
  const preset = (await call(page, "/local/account/library", "POST", f.content)).body;
  await page.reload();
  const { dialog, review } = await openCreation(page, preset.id, "Cancelled composition");
  await review.getByLabel("Workspace instructions", { exact: true }).fill("UNSAVED_REVIEW_DRAFT");
  const before = (await (await request.get(`${api}/workspaces`)).json()).workspaces;
  let writes = 0;
  page.on("request", req => { if (req.url().endsWith("/local/workspace-compositions") && req.method() === "POST") writes++; });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Add Workspace", exact: true }).click();
  await expect(dialog.getByLabel("Workspace instructions", { exact: true })).toHaveValue("UNSAVED_REVIEW_DRAFT");
  expect((await (await request.get(`${api}/workspaces`)).json()).workspaces).toEqual(before);
  expect(writes).toBe(0);
});

test("partial workspace creation resumes from its durable receipt after reload and source retirement", async ({ page, request }) => {
  const f = await setup(page, request, "resume");
  const preset = (await call(page, "/local/account/library", "POST", f.content)).body;
  await page.reload();
  const { dialog } = await openCreation(page, preset.id, "Durable partial workspace");
  await request.post(`${fixture}/fail-composition-config`);
  const submitted = page.waitForRequest(req => req.url().endsWith("/local/workspace-compositions") && req.method() === "POST");
  await dialog.getByRole("button", { name: "Create Workspace", exact: true }).click();
  const input = (await submitted).postDataJSON();
  await expect(dialog.getByRole("alert")).toContainText("incomplete");
  const original = (await call(page, `/local/workspace-compositions/${input.requestId}`)).body;
  expect(original.state).toBe("pending");
  expect((await call(page, `/local/account/library/${preset.id}`, "PATCH", { action: "archive", expectedVersion: 1 })).status).toBe(200);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Add Workspace", exact: true }).click();
  await dialog.getByRole("button", { name: "Resume Durable partial workspace", exact: true }).click();
  await expect(dialog.getByLabel("Workspace creation status", { exact: true })).toHaveText("pending");
  await expect(dialog.getByLabel("Workspace preset", { exact: true }).getByRole("option", { name: `${f.content.name} (Archived)`, exact: true })).toBeAttached();
  await dialog.getByRole("button", { name: "Retry workspace creation", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${original.workspaceId}/conversations/${original.conversationId}$`));
  const final = (await call(page, `/local/workspace-compositions/${input.requestId}`)).body;
  expect(final.agents).toEqual(original.agents);
  expect(final.state).toBe("complete");
  const { members } = await (await request.get(`${api}/workspaces/${original.workspaceId}/members`)).json();
  expect(members).toHaveLength(2);
});

test("timeout before reservation retains the exact intent through receipt 404 and a later rejected retry", async ({ page, request }) => {
  const f = await setup(page, request, "delayed-reservation");
  const preset = (await call(page, "/local/account/library", "POST", f.content)).body;
  await page.reload();
  const before = (await (await request.get(`${api}/workspaces`)).json()).workspaces.length;
  const { dialog } = await openCreation(page, preset.id, "Delayed reservation workspace");
  const payloads: Array<Record<string, unknown>> = [];
  page.on("request", req => { if (req.url().endsWith("/local/workspace-compositions") && req.method() === "POST") payloads.push(req.postDataJSON()); });
  await request.post(`${fixture}/hold-composition-reservation`);
  try {
    await dialog.getByRole("button", { name: "Create Workspace", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Retry workspace creation", exact: true })).toBeEnabled({ timeout: 10_000 });
    await expect(dialog.getByLabel("Name", { exact: true })).toBeDisabled();
    const id = payloads[0]!.requestId;
    expect((await call(page, `/local/workspace-compositions/${id}`)).status).toBe(404);
    await dialog.getByRole("button", { name: "Inspect creation", exact: true }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "receipt unavailable" })).toBeVisible();
    await expect(dialog.getByLabel("Name", { exact: true })).toBeDisabled();
    // This retry can definitively reject while the original dispatch is still waiting.
    // It must not erase the earlier uncertainty or unlock a new creation identity.
    expect((await call(page, `/local/account/library/${preset.id}`, "PATCH", { action: "save", expectedVersion: 1, content: { ...f.content, description: "Changed after original dispatch" } })).status).toBe(200);
    const rejected = page.waitForResponse(response => response.url().endsWith("/local/workspace-compositions") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Retry workspace creation", exact: true }).click();
    expect((await (await rejected).json()).compositionOutcome).toBe("rejected-before-reservation");
    await expect(dialog.getByRole("alert").filter({ hasText: "preset changed" })).toBeVisible();
    await expect(dialog.getByLabel("Name", { exact: true })).toBeDisabled();
    expect(payloads[1]).toEqual(payloads[0]);
    await request.post(`${fixture}/release-composition-reservation`);
    await expect.poll(async () => (await call(page, `/local/workspace-compositions/${id}`)).body.state).toBe("complete");
    await dialog.getByRole("button", { name: "Retry workspace creation", exact: true }).click();
    await expect(page).toHaveURL(/\/workspaces\/workspace_[a-f0-9]+\/conversations\/conversation_[a-f0-9]+$/);
    expect(payloads).toHaveLength(3);
    expect(payloads[2]).toEqual(payloads[0]);
    expect((await (await request.get(`${api}/workspaces`)).json()).workspaces.length).toBe(before + 1);
  } finally { await request.post(`${fixture}/release-composition-reservation`); }
});

test("reload before reservation preserves recovery identity without persisting the private plan", async ({ page, request }) => {
  const f = await setup(page, request, "reload-before-reservation");
  const preset = (await call(page, "/local/account/library", "POST", f.content)).body;
  await page.reload();
  const before = (await (await request.get(`${api}/workspaces`)).json()).workspaces.length;
  const { dialog } = await openCreation(page, preset.id, "Reloaded unknown creation");
  await dialog.getByLabel("Workspace instructions", { exact: true }).fill("PRIVATE_REVIEW_PLAN_NEVER_IN_STORAGE");
  const payloads: Array<Record<string, unknown>> = [];
  page.on("request", req => { if (req.url().endsWith("/local/workspace-compositions") && req.method() === "POST") payloads.push(req.postDataJSON()); });
  await request.post(`${fixture}/hold-composition-reservation`);
  try {
    await dialog.getByRole("button", { name: "Create Workspace", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Retry workspace creation", exact: true })).toBeEnabled({ timeout: 10_000 });
    const id = payloads[0]!.requestId;
    const markers = () => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("minu-channels:workspace-creation-intent:")));
    expect((await markers()).map(([, value]) => value)).toEqual([id]);
    expect(await page.evaluate(() => Object.values(localStorage).some(value => /PRIVATE_REVIEW_PLAN_NEVER_IN_STORAGE|PRIVATE_PRESET_SKILL_BODY|Reloaded unknown creation/.test(value)))).toBe(false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add Workspace", exact: true }).click();
    await expect(dialog.getByLabel("Workspace creation status", { exact: true })).toHaveText("Unresolved");
    await expect(dialog.getByLabel("Name", { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel("Source folder", { exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Retry workspace creation", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Inspect creation", exact: true }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "receipt unavailable" })).toBeVisible();
    expect((await call(page, `/local/workspace-compositions/${id}`)).status).toBe(404);
    expect(payloads).toHaveLength(1);
    expect((await markers()).map(([, value]) => value)).toEqual([id]);
    await request.post(`${fixture}/release-composition-reservation`);
    await expect.poll(async () => (await call(page, `/local/workspace-compositions/${id}`)).body.state).toBe("complete");
    await dialog.getByRole("button", { name: "Inspect creation", exact: true }).click();
    await expect(dialog.getByLabel("Workspace instructions", { exact: true })).toHaveValue("PRIVATE_REVIEW_PLAN_NEVER_IN_STORAGE");
    await dialog.getByRole("button", { name: "Retry workspace creation", exact: true }).click();
    await expect(page).toHaveURL(/\/workspaces\/workspace_[a-f0-9]+\/conversations\/conversation_[a-f0-9]+$/);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]!.requestId).toBe(id);
    expect(payloads[1]!.plan).toEqual(payloads[0]!.plan);
    expect((await (await request.get(`${api}/workspaces`)).json()).workspaces.length).toBe(before + 1);
    expect(await markers()).toEqual([]);
  } finally { await request.post(`${fixture}/release-composition-reservation`); }
});

test("workspace composition does not dispatch if its recovery identity cannot be persisted", async ({ page, request }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string) {
      if (key.startsWith("minu-channels:workspace-creation-intent:")) throw new Error("Recovery identity storage unavailable");
      original.call(this, key, value);
    };
  });
  const f = await setup(page, request, "unavailable-intent-storage");
  const preset = (await call(page, "/local/account/library", "POST", f.content)).body;
  await page.reload();
  const { dialog } = await openCreation(page, preset.id, "Do not dispatch without recovery identity");
  let writes = 0;
  page.on("request", req => { if (req.url().endsWith("/local/workspace-compositions") && req.method() === "POST") writes++; });
  await dialog.getByRole("button", { name: "Create Workspace", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Recovery identity storage unavailable");
  await expect(dialog.getByLabel("Name", { exact: true })).toBeEnabled();
  expect(writes).toBe(0);
});

test("an initial definitive pre-reservation rejection unlocks explicit re-review", async ({ page, request }) => {
  const f = await setup(page, request, "known-rejection");
  const preset = (await call(page, "/local/account/library", "POST", f.content)).body;
  await page.reload();
  const { dialog } = await openCreation(page, preset.id, "Definitively rejected draft");
  expect((await call(page, `/local/account/library/${preset.id}`, "PATCH", { action: "save", expectedVersion: 1, content: { ...f.content, description: "New source version" } })).status).toBe(200);
  const rejected = page.waitForResponse(response => response.url().endsWith("/local/workspace-compositions") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Create Workspace", exact: true }).click();
  expect((await (await rejected).json()).compositionOutcome).toBe("rejected-before-reservation");
  await expect(dialog.getByLabel("Name", { exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Review preset again", exact: true }).click();
  await expect(dialog.getByRole("status", { name: "" }).filter({ hasText: "Loading workspace preset" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create Workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/workspace_[a-f0-9]+\/conversations\/conversation_[a-f0-9]+$/);
});

test("lost composition responses freeze the intent and explicit inspect/retry cannot duplicate resources", async ({ page, request }) => {
  const f = await setup(page, request, "retry");
  const preset = (await call(page, "/local/account/library", "POST", f.content)).body;
  await page.reload();
  const before = (await (await request.get(`${api}/workspaces`)).json()).workspaces.length;
  const { dialog } = await openCreation(page, preset.id, "Retry composition");
  const payloads: Array<Record<string, unknown>> = [];
  let lost = false;
  await page.route("**/local/workspace-compositions", async route => {
    if (route.request().method() !== "POST") return route.continue();
    payloads.push(route.request().postDataJSON());
    if (lost) return route.continue();
    lost = true;
    const response = await route.fetch({ url: `http://127.0.0.1:${process.env.MINU_TEST_CONTROL_PORT ?? 58411}/local/workspace-compositions` });
    expect(response.ok()).toBe(true);
    return route.fulfill({ status: 503, json: { error: "Lost workspace creation response" } });
  });
  await dialog.getByRole("button", { name: "Create Workspace", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Lost workspace creation response");
  await expect(dialog.getByLabel("Name", { exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Inspect creation", exact: true }).click();
  await expect(dialog.getByLabel("Workspace creation status", { exact: true })).toHaveText("complete");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Add Workspace", exact: true }).click();
  await dialog.getByRole("button", { name: "Retry workspace creation", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/workspace_[a-f0-9]+\/conversations\/conversation_[a-f0-9]+$/);
  expect(payloads).toHaveLength(2);
  expect(payloads[0]!.requestId).toBe(payloads[1]!.requestId);
  expect(payloads[0]!.plan).toEqual(payloads[1]!.plan);
  expect((await (await request.get(`${api}/workspaces`)).json()).workspaces.length).toBe(before + 1);
  const receipt = (await call(page, `/local/workspace-compositions/${payloads[0]!.requestId}`)).body;
  const { members } = await (await request.get(`${api}/workspaces/${receipt.workspaceId}/members`)).json();
  expect(members).toHaveLength(2);
});
