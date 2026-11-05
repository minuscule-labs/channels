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
  return { workspace, local, agent, root };
}

function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

test("page-scoped tabs, preset editor, simple creation and later settings editing", async ({ page, request }) => {
  const { workspace, local, agent, root } = await presetFixture(page, request);
  await page.route(`**/local/workspaces/${workspace.id}/runtime-options?*`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `http://127.0.0.1:${process.env.MINU_TEST_CONTROL_PORT ?? 58411}${url.pathname}${url.search}` });
    const body = await response.json();
    body.models.push({ provider: "test", id: "plain", name: "Plain", reasoning: false, enabled: true });
    await route.fulfill({ response, json: body });
  });
  const content = page.getByRole("main", { name: "Workspace settings" });
  const tabs = content.getByRole("navigation", { name: "Workspace settings" });
  await expect(tabs.getByRole("link")).toHaveCount(4);
  const bounds = await tabs.getByRole("link").evaluateAll((links) => links.map((link) => { const rect = link.getBoundingClientRect(); return { x: rect.x, y: rect.y }; }));
  expect(bounds).toHaveLength(4);
  expect(new Set(bounds.map(({ y }) => y)).size).toBe(1);
  expect(bounds.every(({ x }, index) => !index || x > bounds[index - 1]!.x)).toBe(true);
  await expect(tabs.getByRole("link", { name: /Conversation presets/ })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "New preset", exact: true }).click();
  await page.getByLabel("Preset name", { exact: true }).fill("Research team");
  await page.getByLabel("Starting point", { exact: true }).selectOption("exploration");
  await page.getByLabel("Agent for role 1", { exact: true }).selectOption(agent.identityId);
  await page.getByLabel("Role 1", { exact: true }).fill("Research lead");
  await page.getByLabel("Conversation model", { exact: true }).selectOption(JSON.stringify(["openai", "gpt-browser-fast"]));
  await page.getByLabel("Conversation effort", { exact: true }).selectOption("high");
  await page.getByLabel("Conversation model", { exact: true }).selectOption(JSON.stringify(["test", "plain"]));
  await expect(page.getByLabel("Conversation effort", { exact: true })).toHaveValue("off");
  await expect(page.getByLabel("Conversation effort", { exact: true }).getByRole("option", { name: "high", exact: true })).toHaveCount(0);
  await page.getByLabel("Conversation model", { exact: true }).selectOption("");
  await page.getByLabel("Conversation effort", { exact: true }).selectOption("");
  await page.getByLabel("Collaboration guidance (optional)").fill("Check in after discovery.");
  await page.getByLabel("Turn timeout", { exact: true }).selectOption(String(5 * 60_000));
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}/preset_`));
  await expect(page.getByLabel("Preset name", { exact: true })).toHaveValue("Research team");
  const presetId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.getByRole("link", { name: "← Conversation presets", exact: true }).click();
  await expect(page.getByRole("link", { name: "Research team", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/workspace-settings-presets.png" });
  await content.getByRole("navigation", { name: "Workspace settings" }).getByRole("link", { name: "Defaults & timeouts", exact: true }).click();
  await content.getByLabel("Turn timeout", { exact: true }).selectOption(String(10 * 60_000));
  await content.getByRole("button", { name: "Save turn timeout", exact: true }).click();
  await expect(content.getByText("Saved", { exact: true })).toBeVisible();
  expect((await local(`/local/workspaces/${workspace.id}/config`)).body.turnTimeoutMs).toBe(600_000);

  await page.getByRole("button", { name: `Create Conversation in ${workspace.name}` }).click();
  const creation = page.getByRole("main", { name: "Create a Conversation" });
  await creation.getByLabel("Conversation name", { exact: true }).fill("reviewed-preset");
  await creation.getByLabel("Preset (optional)", { exact: true }).selectOption(presetId);
  await expect(creation.getByRole("checkbox", { name: /Builder Agent/ })).toBeChecked();
  await expect(creation.getByLabel("Conversation model", { exact: true })).toHaveCount(0);
  await expect(creation.getByLabel("Collaboration guidance (optional)")).toHaveCount(0);
  await expect(creation.getByLabel("Preset name", { exact: true })).toHaveCount(0);
  await creation.getByLabel("Working folder", { exact: true }).fill("/tmp");
  await page.setViewportSize({ width: 390, height: 844 });
  await creation.getByRole("button", { name: "Create Conversation", exact: true }).scrollIntoViewIfNeeded();
  await expect(creation.getByRole("button", { name: "Create Conversation", exact: true })).toBeInViewport();
  await page.screenshot({ path: "test-results/create-conversation-mobile.png" });
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/local/workspaces/${workspace.id}/conversations`));
  await creation.getByRole("button", { name: "Create Conversation", exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const { conversation } = await response.json();
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversation.id}$`));
  const original = (await local(`/local/conversations/${conversation.id}/creation-setup`)).body.setup;
  expect(original).toMatchObject({ participants: [{ identityId: agent.identityId, role: "Research lead" }], turnTimeoutMs: 300_000, workingFolder: { relativePath: "." }, guidance: "Check in after discovery." });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Conversation actions for reviewed-preset", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("main", { name: "Conversation settings" });
  await settings.getByLabel("Collaboration guidance (optional)").fill("Check in before implementation.");
  await settings.getByLabel("Turn timeout", { exact: true }).selectOption(String(10 * 60_000));
  await settings.getByRole("button", { name: "Save Conversation settings", exact: true }).click();
  await expect(settings.getByText("Conversation settings saved", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/conversation-settings.png" });
  expect((await local(`/local/conversations/${conversation.id}/settings`)).body.settings).toMatchObject({ guidance: "Check in before implementation.", turnTimeoutMs: 600_000, revision: 1 });
  expect((await local(`/local/conversations/${conversation.id}/creation-setup`)).body.setup).toEqual(original);
  await page.goto(`${root}/${presetId}`);
  await page.getByRole("button", { name: "Delete preset", exact: true }).click();
  await page.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}$`));
  expect((await local(`/local/conversations/${conversation.id}/creation-setup`)).body.setup).toEqual(original);
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
    await page.getByRole("link", { name: "Draft B", exact: true }).click();
    await page.getByLabel("Collaboration guidance (optional)").fill("Changed B");
    const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`${path}/${a}`));
    held.release(); await saved;
    await expect(page).toHaveURL(new RegExp(`${b}$`));
    await expect(page.getByLabel("Collaboration guidance (optional)")).toHaveValue("Changed B");
    await page.getByRole("button", { name: "Delete preset", exact: true }).click();
    await page.getByRole("button", { name: "Confirm delete", exact: true }).click(); await deleteEntered.promise;
    await page.getByRole("link", { name: "← Conversation presets", exact: true }).click();
    await page.getByRole("link", { name: "Draft A", exact: true }).click();
    const deleted = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(`${path}/${b}`));
    deleteHeld.release(); await deleted;
    await expect(page).toHaveURL(new RegExp(`${a}$`));
    await expect(page.getByLabel("Collaboration guidance (optional)")).toHaveValue("Draft A");
  } finally { held.release(); deleteHeld.release(); }
});

test("lost preset-save responses recover by exact retry or reload with the same draft id", async ({ page, request }) => {
  const { workspace, local, root } = await presetFixture(page, request);
  const path = `/local/workspaces/${workspace.id}/conversation-presets`;
  const before = (await local(path)).body.presets.length;
  await page.getByRole("link", { name: "New preset", exact: true }).click();
  await page.getByLabel("Preset name", { exact: true }).fill("Retry saved preset");
  await page.getByLabel("Collaboration guidance (optional)").fill("Original guidance");
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
  await page.getByLabel("Collaboration guidance (optional)").fill("Repaired guidance");
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${committedIds[1]}$`));
  const presets = (await local(path)).body.presets as Array<{ id: string; guidance: string; revision: number }>;
  expect(presets.length).toBe(before + 2);
  expect(presets.find(({ id }) => id === committedIds[1])).toMatchObject({ guidance: "Repaired guidance", revision: 2 });
  expect(presets.find(({ id }) => id === committedIds[0])).toMatchObject({ guidance: "Original guidance", revision: 1 });
  expect(committedIds[1]).not.toBe(committedIds[0]);
});

test("advanced settings reload reconciles roles with the edited roster", async ({ page, request }) => {
  const { workspace, local, agent } = await presetFixture(page, request);
  const createdAgent = await request.post(`${conversationsBase}/identities`, { data: { type: "agent", displayName: "Recovery Reviewer" } });
  expect(createdAgent.ok()).toBe(true);
  const { identity } = await createdAgent.json();
  expect((await request.post(`${conversationsBase}/workspaces/${workspace.id}/members`, { data: { identityId: identity.id, mentionHandle: "recovery-reviewer" } })).ok()).toBe(true);
  const id = await page.evaluate(() => `conversation_${crypto.randomUUID().replaceAll("-", "")}`);
  expect((await local(`/local/workspaces/${workspace.id}/conversations`, "POST", {
    id, name: "settings-reload-roster", participants: [{ identityId: agent.identityId, role: "Builder" }, { identityId: identity.id, role: "Reviewer" }],
  })).status).toBe(201);
  await page.goto(`/app/workspaces/${workspace.id}/conversations/${id}/settings`);
  const settings = page.getByRole("main", { name: "Conversation settings" });
  await settings.getByRole("checkbox", { name: /Recovery Reviewer/ }).uncheck();
  const rosterSaved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/conversations/${id}/participants`));
  await settings.getByRole("button", { name: "Save participants", exact: true }).click();
  expect((await rosterSaved).ok()).toBe(true);
  await expect(settings.getByLabel("Role 2", { exact: true })).toHaveCount(0);
  let reject = true;
  await page.route(`**/local/conversations/${id}/settings`, async (route) => {
    if (route.request().method() === "PUT" && reject) {
      reject = false;
      await route.fulfill({ status: 409, json: { error: "Settings changed; reload before saving" } });
    } else await route.continue();
  });
  await settings.getByRole("button", { name: "Save Conversation settings", exact: true }).click();
  await settings.getByRole("button", { name: "Reload settings", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Reload settings", exact: true })).toHaveCount(0);
  await expect(settings.getByLabel("Role 2", { exact: true })).toHaveCount(0);
  await settings.getByLabel("Collaboration guidance (optional)").fill("Recovered settings");
  await settings.getByRole("button", { name: "Save Conversation settings", exact: true }).click();
  await expect(settings.getByText("Conversation settings saved", { exact: true })).toBeVisible();
  expect((await local(`/local/conversations/${id}/settings`)).body.settings.participants).toEqual([{ identityId: agent.identityId, role: "Builder" }]);
});
