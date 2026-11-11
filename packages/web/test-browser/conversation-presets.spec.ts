import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const conversationsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

async function presetFixture(page: Page, request: APIRequestContext) {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json();
  const workspace = workspaces[0] as { id: string; name: string };
  const { members } = await (await request.get(`${conversationsBase}/workspaces/${workspace.id}/members`)).json();
  const agent = members.find(({ mentionHandle }: { mentionHandle: string }) => mentionHandle === "builder");
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(`/app/workspaces/${workspace.id}/settings/presets`)}`)).json();
  await page.goto(launchUrl);
  const local = (path: string, method = "GET", body?: unknown) => page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
  expect((await local(`/local/workspaces/${workspace.id}/config`, "PATCH", { rootUri: "/tmp" })).status).toBe(200);
  expect((await local(`/local/workspaces/${workspace.id}/agents/${agent.identityId}/config`, "PATCH", { runtimeAdapter: "pi", status: "active" })).status).toBe(200);
  const root = `/app/workspaces/${workspace.id}/settings/presets`;
  return { workspace, local, agent, root, owner: members.find(({ mentionHandle }: { mentionHandle: string }) => mentionHandle === "david") };
}

async function editPreset(page: Page, name: string) {
  await page.getByRole("button", { name: `Preset actions for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
}

function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

test("workspace sidebar, page-scoped Conversation tabs, preset editor and creation", async ({ page, request }, info) => {
  const { workspace, local, agent, root, owner } = await presetFixture(page, request);
  const folderResponse = await request.post(`${conversationsBase}/workspaces/${workspace.id}/folders`, { data: { actorIdentityId: owner.identityId, name: "Preset delivery" } });
  expect(folderResponse.ok()).toBe(true);
  const { folder: filingFolder } = await folderResponse.json();
  await page.route(`**/local/workspaces/${workspace.id}/runtime-options?*`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `http://127.0.0.1:${process.env.MINU_TEST_CONTROL_PORT ?? 58411}${url.pathname}${url.search}` });
    const body = await response.json();
    body.models.push({ provider: "test", id: "plain", name: "Plain", reasoning: false, enabled: true });
    await route.fulfill({ response, json: body });
  });
  const content = page.getByRole("main", { name: "Workspace Settings" });
  const navigation = page.getByRole("navigation", { name: "Workspace settings", exact: true });
  await expect(content.getByRole("navigation")).toHaveCount(0);
  await expect(navigation.getByRole("link")).toHaveCount(6);
  const bounds = await navigation.getByRole("link").evaluateAll((links) => links.map((link) => { const rect = link.getBoundingClientRect(); return { x: rect.x, y: rect.y }; }));
  expect(bounds).toHaveLength(6);
  expect(new Set(bounds.map(({ x }) => x)).size).toBe(1);
  expect(bounds.every(({ y }, index) => !index || y > bounds[index - 1]!.y)).toBe(true);
  await expect(navigation.getByRole("link", { name: /Conversation presets/ })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "New preset", exact: true }).click();
  await expect(navigation.getByRole("link", { name: /Conversation presets/ })).toHaveAttribute("aria-current", "page");
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(content.locator(":scope > div > header > div > p")).toHaveText("Conversation presets");
  await page.getByLabel("Preset name", { exact: true }).fill("Research team");
  await page.screenshot({ path: info.outputPath("preset-new-desktop.png") });
  await page.getByRole("checkbox", { name: /Builder Agent/ }).check();
  await page.getByLabel("Instructions", { exact: true }).fill("Check in after discovery.");
  for (const label of ["Starting point", "Role 1", "Conversation model", "Conversation effort", "Turn timeout", "Idle agent sleep"]) {
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Add role", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}/preset_`));
  await expect(page.getByLabel("Preset name", { exact: true })).toHaveValue("Research team");
  await page.reload();
  await expect(navigation.getByRole("link", { name: /Conversation presets/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("Preset name", { exact: true })).toHaveValue("Research team");
  await page.screenshot({ path: info.outputPath("preset-edit-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("preset-edit-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  const presetId = new URL(page.url()).pathname.split("/").at(-1)!;
  expect(presetId).toMatch(/^preset_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
  await page.getByRole("link", { name: "← Conversation presets", exact: true }).click();
  const table = page.getByRole("table", { name: "Conversation presets", exact: true });
  await expect(table.getByRole("cell", { name: "Research team", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveText(["Name", "Team", "Actions"]);
  await page.screenshot({ path: info.outputPath("presets-table-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("presets-table-mobile.png") });
  await page.getByRole("button", { name: "Preset actions for Research team", exact: true }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Edit", "Remove"]);
  await page.screenshot({ path: info.outputPath("presets-table-mobile-menu.png") });
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await navigation.getByRole("link", { name: "Defaults & timeouts", exact: true }).click();
  await expect(content.getByLabel("Turn timeout", { exact: true })).toHaveValue(String(60 * 60_000));
  await expect(content.getByLabel("Turn timeout", { exact: true }).getByRole("option")).toHaveText(["30 minutes", "1 hour (default)", "2 hours"]);
  await page.screenshot({ path: info.outputPath("workspace-turn-timeout-default.png") });
  await content.getByLabel("Turn timeout", { exact: true }).selectOption(String(120 * 60_000));
  await content.getByRole("button", { name: "Save turn timeout", exact: true }).click();
  await expect(content.getByText("Saved", { exact: true })).toBeVisible();
  expect((await local(`/local/workspaces/${workspace.id}/config`)).body.turnTimeoutMs).toBe(7_200_000);
  await page.reload();
  await expect(content.getByLabel("Turn timeout", { exact: true })).toHaveValue("7200000");

  await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  await page.getByRole("button", { name: `Quick create Conversation in ${workspace.name}` }).click();
  const creation = page.getByRole("main", { name: "Create a Conversation" });
  await creation.getByLabel("Conversation name", { exact: true }).fill("reviewed-preset");
  await creation.getByLabel("Preset (optional)", { exact: true }).selectOption(presetId);
  await expect(creation.getByRole("checkbox", { name: /Builder Agent/ })).toBeChecked();
  await expect(creation.getByLabel("Conversation model", { exact: true })).toHaveCount(0);
  await expect(creation.getByLabel("Collaboration guidance (optional)")).toHaveCount(0);
  await expect(creation.getByLabel("Preset name", { exact: true })).toHaveCount(0);
  await expect(creation.getByRole("link", { name: "Manage presets", exact: true })).toHaveCount(0);
  await expect(creation.getByRole("button", { name: /preset/i })).toHaveCount(0);
  await creation.getByRole("combobox", { name: "Folder", exact: true }).selectOption(filingFolder.id);
  await creation.getByLabel("Working folder", { exact: true }).fill("/tmp");
  await page.setViewportSize({ width: 390, height: 844 });
  await creation.getByRole("button", { name: "Create Conversation", exact: true }).scrollIntoViewIfNeeded();
  await expect(creation.getByRole("button", { name: "Create Conversation", exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath("create-conversation-mobile.png") });
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/local/workspaces/${workspace.id}/conversations`));
  await creation.getByRole("button", { name: "Create Conversation", exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const { conversation } = await response.json();
  expect(conversation.id).toMatch(/^conversation_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
  expect(conversation.folderId).toBe(filingFolder.id);
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversation.id}$`));
  const original = (await local(`/local/conversations/${conversation.id}/creation-setup`)).body.setup;
  expect(original).toMatchObject({ participants: [{ identityId: agent.identityId }], workingFolder: { relativePath: "." }, guidance: "Check in after discovery." });
  for (const field of ["model", "reasoningLevel", "turnTimeoutMs", "idleSleepTimeoutMs"]) expect(original).not.toHaveProperty(field);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Conversation actions for reviewed-preset", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("main", { name: "Conversation settings" });
  for (const name of ["Participants & roles", "Collaboration", "Session defaults"]) await expect(settings.getByRole("heading", { name, exact: true })).toHaveCount(0);
  await expect(settings.getByLabel("Collaboration guidance (optional)")).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Save Conversation settings", exact: true })).toHaveCount(0);
  await expect(settings.getByLabel("Turn timeout", { exact: true })).toHaveCount(0);
  await expect(settings.getByLabel("Idle agent sleep", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("conversation-settings.png") });
  expect((await local(`/local/conversations/${conversation.id}/settings`)).body.settings).toMatchObject({ guidance: "Check in after discovery.", revision: 0 });
  expect((await local(`/local/conversations/${conversation.id}/creation-setup`)).body.setup).toEqual(original);
  await page.goto(`${root}/${presetId}`);
  await page.getByRole("button", { name: "Delete preset", exact: true }).click();
  await page.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}$`));
  expect((await local(`/local/conversations/${conversation.id}/creation-setup`)).body.setup).toEqual(original);
});

test("Conversation drafts use UUIDv7, retain ids across retries, and reset only for a new draft", async ({ page, request }) => {
  const { workspace, local } = await presetFixture(page, request);
  const path = `/local/workspaces/${workspace.id}/conversations`;
  const before = (await (await request.get(`${conversationsBase}/workspaces/${workspace.id}/conversations`)).json()).conversations.length;
  await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  await page.getByRole("button", { name: `Quick create Conversation in ${workspace.name}` }).click();
  const creation = page.getByRole("main", { name: "Create a Conversation" });
  await creation.getByLabel("Conversation name", { exact: true }).fill("uuidv7-draft");
  const submittedIds: string[] = [];
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    submittedIds.push((route.request().postDataJSON() as { id: string }).id);
    if (submittedIds.length <= 2) {
      await route.fulfill({ status: 503, json: { error: "Temporary creation failure" } });
    } else await route.continue();
  });
  const submit = creation.getByRole("button", { name: "Create Conversation", exact: true });
  await submit.click();
  await expect(creation.getByRole("button", { name: "Start a new draft", exact: true })).toBeVisible();
  expect(submittedIds[0]).toMatch(/^conversation_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
  await creation.getByLabel("Conversation name", { exact: true }).fill("uuidv7-draft-retry");
  await submit.click();
  await expect.poll(() => submittedIds.length).toBe(2);
  await expect(submit).toBeEnabled();
  expect(submittedIds[1]).toBe(submittedIds[0]);
  await creation.getByRole("button", { name: "Start a new draft", exact: true }).click();
  const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(path));
  await submit.click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const { conversation } = await response.json();
  expect(submittedIds).toHaveLength(3);
  expect(submittedIds[2]).toMatch(/^conversation_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
  expect(submittedIds[2]).not.toBe(submittedIds[0]);
  expect(conversation.id).toBe(submittedIds[2]);
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversation.id}$`));
  expect((await local(`/local/conversations/${conversation.id}/creation-setup`)).status).toBe(200);
  const after = await (await request.get(`${conversationsBase}/workspaces/${workspace.id}/conversations`)).json();
  expect(after.conversations).toHaveLength(before + 1);
});

test("late preset saves and deletes cannot redirect or replace another editor", async ({ page, request }) => {
  const { workspace, local, root } = await presetFixture(page, request);
  const path = `/local/workspaces/${workspace.id}/conversation-presets`;
  const a = `preset_${"a".repeat(32)}`, b = `preset_${"b".repeat(32)}`;
  for (const [id, name] of [[a, "Draft A"], [b, "Draft B"]]) expect((await local(`${path}/${id}`, "PUT", { name, guidance: name, participants: [], expectedRevision: null })).status).toBe(200);
  await page.goto(`${root}/${a}`);
  const entered = gate(), held = gate(), deleteEntered = gate(), deleteHeld = gate();
  await page.route(`**${path}/${a}`, async (route) => { if (route.request().method() === "PUT") { entered.release(); await held.promise; } await route.continue(); });
  await page.route(`**${path}/${b}`, async (route) => { if (route.request().method() === "DELETE") { deleteEntered.release(); await deleteHeld.promise; } await route.continue(); });
  try {
    await page.getByRole("button", { name: "Save preset", exact: true }).click(); await entered.promise;
    await page.getByRole("link", { name: "← Conversation presets", exact: true }).click();
    await editPreset(page, "Draft B");
    await page.getByLabel("Instructions").fill("Changed B");
    const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`${path}/${a}`));
    held.release(); await saved;
    await expect(page).toHaveURL(new RegExp(`${b}$`));
    await expect(page.getByLabel("Instructions")).toHaveValue("Changed B");
    await page.getByRole("button", { name: "Delete preset", exact: true }).click();
    await page.getByRole("button", { name: "Confirm delete", exact: true }).click(); await deleteEntered.promise;
    await page.getByRole("link", { name: "← Conversation presets", exact: true }).click();
    await editPreset(page, "Draft A");
    const deleted = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(`${path}/${b}`));
    deleteHeld.release(); await deleted;
    await expect(page).toHaveURL(new RegExp(`${a}$`));
    await expect(page.getByLabel("Instructions")).toHaveValue("Draft A");
  } finally { held.release(); deleteHeld.release(); }
});

test("lost preset-save responses recover by exact retry or reload with the same draft id", async ({ page, request }) => {
  const { workspace, local, root } = await presetFixture(page, request);
  const path = `/local/workspaces/${workspace.id}/conversation-presets`;
  const before = (await local(path)).body.presets.length;
  await page.getByRole("link", { name: "New preset", exact: true }).click();
  await page.getByLabel("Preset name", { exact: true }).fill("Retry saved preset");
  await page.getByLabel("Instructions").fill("Original guidance");
  const committedIds: string[] = [];
  let dropNext = true;
  await page.route(`**${path}/*`, async (route) => {
    if (route.request().method() === "PUT" && dropNext) {
      dropNext = false;
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `http://127.0.0.1:${process.env.MINU_TEST_CONTROL_PORT ?? 58411}${url.pathname}` });
      expect(response.ok()).toBe(true); committedIds.push(url.pathname.split("/").at(-1)!);
      await route.abort("failed"); return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reload presets", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${committedIds[0]}$`));
  expect((await local(path)).body.presets.length).toBe(before + 1);
  await page.getByLabel("Preset name", { exact: true }).fill("Recovered preset");
  dropNext = true;
  await page.getByRole("button", { name: "Save as new preset", exact: true }).click();
  await page.getByRole("button", { name: "Reload presets", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${committedIds[1]}$`));
  await expect(page.getByLabel("Preset name", { exact: true })).toHaveValue("Recovered preset");
  await page.getByLabel("Instructions").fill("Repaired guidance");
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${committedIds[1]}$`));
  const presets = (await local(path)).body.presets as Array<{ id: string; guidance: string; revision: number }>;
  expect(presets.length).toBe(before + 2);
  expect(presets.find(({ id }) => id === committedIds[1])).toMatchObject({ guidance: "Repaired guidance", revision: 2 });
  expect(presets.find(({ id }) => id === committedIds[0])).toMatchObject({ guidance: "Original guidance", revision: 1 });
  expect(committedIds[1]).not.toBe(committedIds[0]);
  for (const id of committedIds) expect(id).toMatch(/^preset_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
});

test("preset table actions confirm removal and require explicit reload after a conflict", async ({ page, request }, info) => {
  const { workspace, local, root } = await presetFixture(page, request);
  const path = `/local/workspaces/${workspace.id}/conversation-presets`;
  const id = `preset_${"c".repeat(32)}`;
  expect((await local(`${path}/${id}`, "PUT", { name: "Table preset", participants: [], expectedRevision: null })).status).toBe(200);
  await page.reload();
  const writes: Array<{ method: string; body: unknown }> = [];
  page.on("request", request => {
    if (request.url().endsWith(`${path}/${id}`) && ["PUT", "DELETE"].includes(request.method())) writes.push({ method: request.method(), body: request.postDataJSON() });
  });
  await editPreset(page, "Table preset");
  await expect(page.getByLabel("Preset name", { exact: true })).toHaveValue("Table preset");
  await page.getByLabel("Preset name", { exact: true }).fill("Unsaved edit");
  await page.getByRole("link", { name: "Cancel", exact: true }).click();
  const remove = async () => {
    await page.getByRole("button", { name: "Preset actions for Table preset", exact: true }).click();
    await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
  };
  await remove();
  await page.getByRole("button", { name: "Keep preset", exact: true }).click();
  expect(writes).toEqual([]);
  await remove();
  await page.screenshot({ path: info.outputPath("preset-remove-confirmation.png") });
  // The confirmation retains its reviewed revision even if another writer saves meanwhile.
  expect((await local(`${path}/${id}`, "PUT", { name: "Table preset", guidance: "Concurrent edit", participants: [], expectedRevision: 1 })).status).toBe(200);
  const conflict = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().endsWith(`${path}/${id}`));
  await page.getByRole("button", { name: "Confirm delete", exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(page.getByRole("button", { name: "Reload presets", exact: true })).toBeVisible();
  expect(writes.filter(write => write.method === "DELETE")).toEqual([{ method: "DELETE", body: { expectedRevision: 1 } }]);
  await page.getByRole("button", { name: "Reload presets", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm delete", exact: true })).toHaveCount(0);
  await remove();
  const deleted = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().endsWith(`${path}/${id}`));
  await page.getByRole("button", { name: "Confirm delete", exact: true }).click();
  expect((await deleted).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Preset actions for Table preset", exact: true })).toHaveCount(0);
  expect(writes.filter(write => write.method === "DELETE").at(-1)).toEqual({ method: "DELETE", body: { expectedRevision: 2 } });
  expect((await local(path)).body.presets.some((preset: { id: string }) => preset.id === id)).toBe(false);
  await expect(page).toHaveURL(new RegExp(`${root}$`));
});

test("late table Remove cannot leave a newer unsaved preset editor", async ({ page, request }) => {
  const { workspace, local, root } = await presetFixture(page, request);
  const path = `/local/workspaces/${workspace.id}/conversation-presets`;
  const id = `preset_${"d".repeat(32)}`;
  expect((await local(`${path}/${id}`, "PUT", { name: "Delayed removal", participants: [], expectedRevision: null })).status).toBe(200);
  await page.reload();
  const committed = gate(), held = gate();
  await page.route(`**${path}/${id}`, async route => {
    if (route.request().method() !== "DELETE") return route.continue();
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `http://127.0.0.1:${process.env.MINU_TEST_CONTROL_PORT ?? 58411}${url.pathname}` });
    expect(response.ok()).toBe(true);
    committed.release();
    await held.promise;
    await route.fulfill({ response });
  });
  const delivered = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().endsWith(`${path}/${id}`));
  try {
    await page.getByRole("button", { name: "Preset actions for Delayed removal", exact: true }).click();
    await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
    await page.getByRole("button", { name: "Confirm delete", exact: true }).click();
    await committed.promise;
    await page.getByRole("link", { name: "New preset", exact: true }).click();
    await page.getByLabel("Preset name", { exact: true }).fill("Keep newer preset draft");
    await page.getByLabel("Instructions").fill("Keep newer guidance");
  } finally { held.release(); }
  await delivered;
  expect((await local(path)).body.presets.some((preset: { id: string }) => preset.id === id)).toBe(false);
  await expect(page).toHaveURL(new RegExp(`${root}/new$`));
  await expect(page.getByLabel("Preset name", { exact: true })).toHaveValue("Keep newer preset draft");
  await expect(page.getByLabel("Instructions")).toHaveValue("Keep newer guidance");
});

test("creation preset selection copies participants and instructions without authoring or preset writes", async ({ page, request }, info) => {
  const { workspace, local, agent, root } = await presetFixture(page, request);
  const path = `/local/workspaces/${workspace.id}/conversation-presets`;
  const id = `preset_${"e".repeat(32)}`;
  const setup = { participants: [{ identityId: agent.identityId }], guidance: "Keep saved guidance" };
  expect((await local(`${path}/${id}`, "PUT", { ...setup, name: "Selection only", expectedRevision: null })).status).toBe(200);
  const before = (await local(path)).body;
  const writes: string[] = [];
  page.on("request", request => {
    if (request.url().includes(path) && request.method() !== "GET") writes.push(request.method());
  });
  const destination = `/app/workspaces/${workspace.id}/conversations/new`;
  await page.goto(destination);
  const creation = page.getByRole("main", { name: "Create a Conversation", exact: true });
  const picker = creation.getByLabel("Preset (optional)", { exact: true });
  await picker.selectOption(id);
  await expect(creation.getByRole("checkbox", { name: /Builder Agent/ })).toBeChecked();
  await picker.selectOption("");
  await expect(creation.getByRole("checkbox", { name: /Builder Agent/ })).not.toBeChecked();
  await picker.selectOption(id);
  await expect(creation.getByRole("link", { name: /preset/i })).toHaveCount(0);
  await expect(creation.getByRole("button", { name: /preset/i })).toHaveCount(0);
  await expect(creation.getByLabel("Preset name", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("creation-preset-selection-desktop.png") });
  await creation.getByRole("link", { name: "Cancel", exact: true }).click();
  expect((await local(path)).body).toEqual(before);
  expect(writes).toEqual([]);
  await page.goto(destination);
  await picker.selectOption(id);
  await creation.getByLabel("Conversation name", { exact: true }).fill("selection-only-preserved");
  const created = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/local/workspaces/${workspace.id}/conversations`));
  await creation.getByRole("button", { name: "Create Conversation", exact: true }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const { conversation } = await response.json();
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversation.id}$`));
  expect((await local(`/local/conversations/${conversation.id}/creation-setup`)).body.setup).toMatchObject(setup);
  expect((await local(path)).body).toEqual(before);
  expect(writes).toEqual([]);
  await page.goto(root);
  await expect(page.getByRole("table", { name: "Conversation presets", exact: true })).toBeVisible();
});

test("members cannot manage or remove Workspace presets", async ({ page, request }) => {
  const { workspace, local, root } = await presetFixture(page, request);
  const path = `/local/workspaces/${workspace.id}/conversation-presets`;
  const id = `preset_${"f".repeat(32)}`;
  expect((await local(`${path}/${id}`, "PUT", { name: "Protected preset", participants: [], expectedRevision: null })).status).toBe(200);
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(root)}&actor=member`)).json();
  await page.goto(launchUrl);
  await expect(page.getByText(/An active Workspace owner or admin is required/)).toBeVisible();
  await expect(page.getByRole("table", { name: "Conversation presets", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "New preset", exact: true })).toHaveCount(0);
  expect(await page.evaluate(async path => (await fetch(path, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1 }) })).status, `${path}/${id}`)).toBe(403);
  const ownerLaunch = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(root)}`)).json();
  await page.goto(ownerLaunch.launchUrl);
  expect((await local(path)).body.presets.find((preset: { id: string }) => preset.id === id)).toMatchObject({ name: "Protected preset", revision: 1 });
});

test("Conversation settings keeps roster editing without advanced reads or legacy settings writes", async ({ page, request }) => {
  const { workspace, local, agent } = await presetFixture(page, request);
  const createdAgent = await request.post(`${conversationsBase}/identities`, { data: { type: "agent", displayName: "Recovery Reviewer" } });
  expect(createdAgent.ok()).toBe(true);
  const { identity } = await createdAgent.json();
  expect((await request.post(`${conversationsBase}/workspaces/${workspace.id}/members`, { data: { identityId: identity.id, mentionHandle: "recovery-reviewer" } })).ok()).toBe(true);
  expect((await local(`/local/workspaces/${workspace.id}/agents/${identity.id}/config`, "PATCH", { runtimeAdapter: "pi", status: "active" })).status).toBe(200);
  const id = await page.evaluate(() => `conversation_${crypto.randomUUID().replaceAll("-", "")}`);
  expect((await local(`/local/workspaces/${workspace.id}/conversations`, "POST", {
    id, name: "preserved-settings-roster", participants: [{ identityId: agent.identityId, role: "Builder" }, { identityId: identity.id, role: "Reviewer" }],
    guidance: "Preserved legacy collaboration", model: { provider: "openai", id: "gpt-browser-deep" }, reasoningLevel: "high",
  })).status).toBe(201);
  const settingsPath = `/local/conversations/${id}/settings`, snapshotPath = `/local/conversations/${id}/creation-setup`;
  const before = (await local(settingsPath)).body, snapshot = (await local(snapshotPath)).body;
  const advancedRequests: string[] = [];
  page.on("request", request => {
    if (request.url().endsWith(settingsPath) || request.url().includes("/runtime-options")) advancedRequests.push(request.url());
  });
  await page.goto(`/app/workspaces/${workspace.id}/conversations/${id}/settings`);
  const settings = page.getByRole("main", { name: "Conversation settings" });
  await expect(settings.getByLabel("Conversation name", { exact: true })).toHaveValue("preserved-settings-roster");
  for (const name of ["Participants & roles", "Collaboration", "Session defaults"]) await expect(settings.getByRole("heading", { name, exact: true })).toHaveCount(0);
  for (const name of ["Role 1", "Conversation model", "Conversation effort", "Collaboration guidance (optional)"]) await expect(settings.getByLabel(name, { exact: true })).toHaveCount(0);
  await settings.getByRole("checkbox", { name: /Recovery Reviewer/ }).uncheck();
  const rosterSaved = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/conversations/${id}/participants`));
  await settings.getByRole("button", { name: "Save participants", exact: true }).click();
  expect((await rosterSaved).ok()).toBe(true);
  await page.reload();
  await expect(settings.getByRole("checkbox", { name: /Recovery Reviewer/ })).not.toBeChecked();
  await expect(settings.getByRole("button", { name: "Save Conversation settings", exact: true })).toHaveCount(0);
  expect(advancedRequests).toEqual([]);
  expect((await local(settingsPath)).body).toEqual(before);
  expect((await local(snapshotPath)).body).toEqual(snapshot);
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(`/app/workspaces/${workspace.id}/conversations/${id}/settings`)}&actor=member`)).json();
  await page.goto(launchUrl);
  await expect(page.getByText(/An active Workspace owner or admin is required/)).toBeVisible();
  await expect(settings.getByRole("button", { name: "Save participants", exact: true })).toHaveCount(0);
  await expect(settings.getByLabel("Instructions", { exact: true })).toHaveCount(0);
});
