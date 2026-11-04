import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const conversationsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

async function presetFixture(page: Page, request: APIRequestContext) {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json();
  const workspace = workspaces[0] as { id: string; name: string };
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch`)).json();
  await page.goto(launchUrl);
  const local = (path: string, method = "GET", body?: unknown) => page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
  const open = async () => {
    await page.getByRole("button", { name: `Create Conversation in ${workspace.name}` }).click();
    return page.getByRole("dialog", { name: `Create a Conversation in ${workspace.name}` });
  };
  return { workspace, local, open };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("reviews, saves, reuses, edits and deletes a Workspace preset before creating a Conversation", async ({ page, request }) => {
  const { workspace, local, open } = await presetFixture(page, request);
  const { members } = await (await request.get(`${conversationsBase}/workspaces/${workspace.id}/members`)).json();
  const agent = (members as Array<{ identityId: string; mentionHandle: string }>).find(({ mentionHandle }) => mentionHandle === "builder")!;
  expect((await local(`/local/workspaces/${workspace.id}/config`, "PATCH", { rootUri: "/tmp" })).status).toBe(200);
  expect((await local(`/local/workspaces/${workspace.id}/agents/${agent.identityId}/config`, "PATCH", { runtimeAdapter: "pi", status: "active" })).status).toBe(200);
  const initialCount = (await (await request.get(`${conversationsBase}/workspaces/${workspace.id}/conversations`)).json()).conversations.length;
  await page.route(`**/local/workspaces/${workspace.id}/runtime-options?*`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `http://127.0.0.1:${process.env.MINU_TEST_CONTROL_PORT ?? 58411}${url.pathname}${url.search}` });
    const body = await response.json();
    body.models.push({ provider: "test", id: "plain", name: "Plain", reasoning: false, enabled: true });
    await route.fulfill({ response, json: body });
  });
  let dialog = await open();
  await dialog.getByLabel("Conversation name", { exact: true }).fill("preset-review");
  await dialog.getByRole("combobox", { name: "Preset", exact: true }).selectOption("exploration");
  await expect(dialog.getByRole("button", { name: "Create Conversation", exact: true })).toBeDisabled();
  await dialog.getByLabel("Role 1", { exact: true }).fill("Research lead");
  await dialog.getByRole("combobox", { name: "Agent for role 1", exact: true }).selectOption(agent.identityId);
  await dialog.getByRole("combobox", { name: "Conversation model", exact: true }).selectOption(JSON.stringify(["openai", "gpt-browser-fast"]));
  await dialog.getByRole("combobox", { name: "Conversation effort", exact: true }).selectOption("high");
  await dialog.getByRole("combobox", { name: "Conversation model", exact: true }).selectOption(JSON.stringify(["test", "plain"]));
  const effort = dialog.getByRole("combobox", { name: "Conversation effort", exact: true });
  await expect(effort).toHaveValue("off");
  await expect(effort.getByRole("option", { name: "high", exact: true })).toHaveCount(0);
  await dialog.getByRole("combobox", { name: "Conversation model", exact: true }).selectOption(JSON.stringify(["openai", "gpt-browser-fast"]));
  await effort.selectOption("high");
  await dialog.getByLabel("Collaboration guidance (optional)").fill("Check in after discovery.");
  await dialog.getByText("Save or manage presets", { exact: true }).click();
  await dialog.getByLabel("Preset name", { exact: true }).fill("Research team");
  await dialog.getByRole("button", { name: "Save as new preset", exact: true }).click();
  await expect(dialog.getByText("Preset saved.", { exact: true })).toBeVisible();
  expect((await (await request.get(`${conversationsBase}/workspaces/${workspace.id}/conversations`)).json()).conversations.length).toBe(initialCount);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  dialog = await open();
  await dialog.getByRole("combobox", { name: "Preset", exact: true }).selectOption({ label: "Research team" });
  await expect(dialog.getByRole("combobox", { name: "Agent for role 1", exact: true })).toHaveValue(agent.identityId);
  await expect(dialog.getByRole("combobox", { name: "Conversation effort", exact: true })).toHaveValue("high");
  await dialog.getByLabel("Conversation name", { exact: true }).fill("reviewed-preset");
  await dialog.getByRole("combobox", { name: "Conversation effort", exact: true }).selectOption("low");
  await dialog.getByLabel("Collaboration guidance (optional)").fill("Check in before implementation.");
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("button", { name: "Create Conversation", exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole("button", { name: "Create Conversation", exact: true })).toBeInViewport();
  await page.screenshot({ path: "test-results/conversation-preset-mobile.png" });
  const creation = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/local/workspaces/${workspace.id}/conversations`));
  await dialog.getByRole("button", { name: "Create Conversation", exact: true }).click();
  const response = await creation;
  expect(response.ok()).toBe(true);
  const { conversation } = await response.json();
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversation.id}$`));
  const setup = (await local(`/local/conversations/${conversation.id}/creation-setup`)).body.setup;
  expect(setup.reasoningLevel).toBe("low");
  expect(setup.guidance).toBe("Check in before implementation.");
  expect(setup.model).toEqual({ provider: "openai", id: "gpt-browser-fast" });
  expect(setup.participants).toEqual([{ identityId: agent.identityId, role: "Research lead" }]);
  await page.setViewportSize({ width: 1280, height: 900 });
  dialog = await open();
  await dialog.getByRole("combobox", { name: "Preset", exact: true }).selectOption({ label: "Research team" });
  await expect(dialog.getByRole("combobox", { name: "Conversation effort", exact: true })).toHaveValue("high");
  await expect(dialog.getByLabel("Collaboration guidance (optional)")).toHaveValue("Check in after discovery.");
  await dialog.getByText("Save or manage presets", { exact: true }).click();
  await dialog.getByLabel("Preset name", { exact: true }).fill("Updated research team");
  await dialog.getByRole("button", { name: "Save preset changes", exact: true }).click();
  await expect(dialog.getByText("Preset saved.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Preset", exact: true }).locator("option:checked")).toHaveText("Updated research team");
  await dialog.getByRole("button", { name: "Delete preset", exact: true }).click();
  await expect(dialog.getByText("Preset deleted. Your draft is still available.", { exact: true })).toBeVisible();
  expect((await local(`/local/conversations/${conversation.id}/creation-setup`)).body.setup).toEqual(setup);
});

test("late preset saves and deletes cannot replace another active draft", async ({ page, request }) => {
  const { workspace, local, open } = await presetFixture(page, request);
  const path = `/local/workspaces/${workspace.id}/conversation-presets`;
  const a = `preset_${"a".repeat(32)}`, b = `preset_${"b".repeat(32)}`;
  for (const [id, name, guidance] of [[a, "Draft A", "Guidance A"], [b, "Draft B", "Guidance B"]]) {
    expect((await local(`${path}/${id}`, "PUT", { name, guidance, participants: [], expectedRevision: null })).status).toBe(200);
  }
  const dialog = await open();
  const selection = dialog.getByRole("combobox", { name: "Preset", exact: true });
  const guidance = dialog.getByLabel("Collaboration guidance (optional)");
  await selection.selectOption(a);
  await dialog.getByText("Save or manage presets", { exact: true }).click();
  const saveEntered = gate(), saveHeld = gate(), deleteEntered = gate(), deleteHeld = gate();
  let holdSave = true;
  await page.route(`**${path}/${a}`, async (route) => {
    if (route.request().method() === "PUT" && holdSave) {
      holdSave = false; saveEntered.release(); await saveHeld.promise;
    }
    await route.continue();
  });
  await page.route(`**${path}/${b}`, async (route) => {
    if (route.request().method() === "DELETE") { deleteEntered.release(); await deleteHeld.promise; }
    await route.continue();
  });
  try {
    await dialog.getByRole("button", { name: "Save preset changes", exact: true }).click();
    await saveEntered.promise;
    await selection.selectOption(b);
    const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`${path}/${a}`));
    saveHeld.release(); expect((await saved).ok()).toBe(true);
    await expect(selection).toHaveValue(b);
    await expect(guidance).toHaveValue("Guidance B");
    await guidance.fill("Changed B");
    const update = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes(`${path}/`));
    await dialog.getByRole("button", { name: "Save preset changes", exact: true }).click();
    expect((await (await update).json()).id).toBe(b);
    await expect(dialog.getByText("Preset saved.", { exact: true })).toBeVisible();
    const presets = (await local(path)).body.presets as Array<{ id: string; guidance: string }>;
    expect(presets.find(({ id }) => id === a)!.guidance).toBe("Guidance A");
    expect(presets.find(({ id }) => id === b)!.guidance).toBe("Changed B");
    await dialog.getByRole("button", { name: "Delete preset", exact: true }).click();
    await deleteEntered.promise;
    await selection.selectOption(a);
    const removed = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(`${path}/${b}`));
    deleteHeld.release(); expect((await removed).ok()).toBe(true);
    await expect.poll(async () => (await local(path)).body.presets.some((preset: { id: string }) => preset.id === b)).toBe(false);
    await expect(selection).toHaveValue(a);
    await expect(guidance).toHaveValue("Guidance A");
  } finally { saveHeld.release(); deleteHeld.release(); }
});

test("lost preset-save responses recover by exact retry or reload and allow a new draft", async ({ page, request }) => {
  const { workspace, local, open } = await presetFixture(page, request);
  const path = `/local/workspaces/${workspace.id}/conversation-presets`;
  const before = (await local(path)).body.presets.length;
  const dialog = await open();
  await dialog.getByText("Save or manage presets", { exact: true }).click();
  await dialog.getByLabel("Preset name", { exact: true }).fill("Retry saved preset");
  await dialog.getByLabel("Collaboration guidance (optional)").fill("Retry guidance");
  const committedIds: string[] = [];
  let dropNext = true;
  await page.route(`**${path}/*`, async (route) => {
    if (route.request().method() === "PUT" && dropNext) {
      dropNext = false;
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `http://127.0.0.1:${process.env.MINU_TEST_CONTROL_PORT ?? 58411}${url.pathname}` });
      expect(response.ok()).toBe(true);
      committedIds.push(url.pathname.split("/").at(-1)!);
      await route.abort("failed"); return;
    }
    await route.continue();
  });
  const saveNew = dialog.getByRole("button", { name: "Save as new preset", exact: true });
  await saveNew.click();
  await expect(dialog.getByRole("button", { name: "Reload presets", exact: true })).toBeVisible();
  await saveNew.click();
  await expect(dialog.getByText("Preset saved.", { exact: true })).toBeVisible();
  const selection = dialog.getByRole("combobox", { name: "Preset", exact: true });
  await expect(selection).toHaveValue(committedIds[0]!);
  expect((await local(path)).body.presets.length).toBe(before + 1);
  // Save a copy while editing an existing preset, then recover that copy's ID.
  await dialog.getByLabel("Preset name", { exact: true }).fill("Recovered copy");
  await dialog.getByLabel("Collaboration guidance (optional)").fill("Copy guidance");
  dropNext = true;
  await saveNew.click();
  await dialog.getByRole("button", { name: "Reload presets", exact: true }).click();
  await expect(selection).toHaveValue(committedIds[1]!);
  expect(committedIds[1]).not.toBe(committedIds[0]);
  await expect(dialog.getByLabel("Preset name", { exact: true })).toHaveValue("Recovered copy");
  await dialog.getByLabel("Collaboration guidance (optional)").fill("Repaired copy");
  await dialog.getByRole("button", { name: "Save preset changes", exact: true }).click();
  await expect(dialog.getByText("Preset saved.", { exact: true })).toBeVisible();
  const presets = (await local(path)).body.presets as Array<{ id: string; guidance: string; revision: number }>;
  expect(presets.length).toBe(before + 2);
  expect(presets.find(({ id }) => id === committedIds[0])!.guidance).toBe("Retry guidance");
  expect(presets.find(({ id }) => id === committedIds[1])).toMatchObject({ guidance: "Repaired copy", revision: 2 });
  await selection.selectOption("exploration");
  await saveNew.click();
  await expect(dialog.getByText("Preset saved.", { exact: true })).toBeVisible();
  expect((await local(path)).body.presets.length).toBe(before + 3);
});
