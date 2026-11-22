import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;
async function call(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, { method, credentials: "include", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
}
async function setup(page: Page, request: APIRequestContext, suffix: string) {
  const { workspaces } = await (await request.get(`${api}/workspaces`)).json();
  const primary = workspaces.find((w: { name: string }) => w.name === "Browser Test");
  const { members } = await (await request.get(`${api}/workspaces/${primary.id}/members`)).json();
  const owner = members.find((m: { mentionHandle: string }) => m.mentionHandle === "david").identityId;
  const { workspace } = await (await request.post(`${api}/workspaces`, { data: { name: `Template ${suffix}`, slug: `template-${suffix}` } })).json();
  expect((await request.post(`${api}/workspaces/${workspace.id}/members`, { data: { identityId: owner, mentionHandle: "owner", accessRole: "owner" } })).ok()).toBe(true);
  const root = `/app/workspaces/${workspace.id}/agents`;
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(`${root}/new`)}`)).json();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  expect((await call(page, `/local/workspaces/${workspace.id}/config`, "PUT", { rootUri: "/tmp" })).status).toBe(200);
  const skill = (await call(page, "/local/account/library", "POST", { kind: "skill", name: `Shared ${suffix}`, description: "Account skill", content: "SHARED_NOT_YET_ACTIVATED" })).body;
  const source = { kind: "agent-template", name: `Base ${suffix}`, description: "PRIVATE_SOURCE_DESCRIPTION", configuration: { personaPrompt: "SOURCE_ORIGINAL_INSTRUCTIONS", runtimeAdapter: "pi", accountSkillIds: [skill.id] } };
  const template = (await call(page, "/local/account/library", "POST", source)).body;
  await page.reload();
  await page.getByRole("button", { name: "Add from account agents", exact: true }).click();
  const form = page.getByRole("form", { name: "Add from account agents", exact: true });
  await form.getByLabel("Account agent template", { exact: true }).selectOption(template.id);
  return { workspace, root, form, template, source, skill };
}

test("workspace agents added from account templates are editable copies; future additions use source edits", async ({ page, request }) => {
  const f = await setup(page, request, "copies");
  await f.form.getByLabel("Display name", { exact: true }).fill("Workspace reviewer");
  await f.form.getByLabel("Mention handle", { exact: true }).fill("workspace-reviewer");
  await f.form.getByRole("button", { name: "Add agent", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${f.root}/identity_[a-f0-9]+$`));
  const firstId = page.url().split("/").at(-1)!;
  const instructions = page.getByRole("textbox", { name: /Agent instructions/ });
  await expect(instructions).toHaveValue("SOURCE_ORIGINAL_INSTRUCTIONS");
  const firstPath = `/local/workspaces/${f.workspace.id}/agents/${firstId}/config`;
  expect((await call(page, firstPath)).body.accountSkills.skillIds).toEqual([f.skill.id]);
  await instructions.fill("WORKSPACE_CUSTOM_INSTRUCTIONS");
  await page.getByRole("button", { name: "Save launch profile", exact: true }).click();
  await expect.poll(async () => (await call(page, firstPath)).body.instructions.text).toBe("WORKSPACE_CUSTOM_INSTRUCTIONS");
  expect((await call(page, `/local/account/library/${f.template.id}`)).body.configuration.personaPrompt).toBe("SOURCE_ORIGINAL_INSTRUCTIONS");
  expect((await call(page, `/local/account/library/${f.template.id}`, "PATCH", { action: "save", expectedVersion: 1, content: { ...f.source, configuration: { ...f.source.configuration, personaPrompt: "SOURCE_UPDATED_INSTRUCTIONS" } } })).status).toBe(200);
  await page.goto(`${f.root}/new`);
  await page.getByRole("button", { name: "Add from account agents", exact: true }).click();
  await f.form.getByLabel("Account agent template", { exact: true }).selectOption(f.template.id);
  await f.form.getByLabel("Display name", { exact: true }).fill("Second reviewer");
  await f.form.getByLabel("Mention handle", { exact: true }).fill("second-reviewer");
  await f.form.getByRole("button", { name: "Add agent", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${f.root}/identity_[a-f0-9]+$`));
  const secondId = page.url().split("/").at(-1)!;
  expect(secondId).not.toBe(firstId);
  await expect(instructions).toHaveValue("SOURCE_UPDATED_INSTRUCTIONS");
  expect((await call(page, firstPath)).body.instructions.text).toBe("WORKSPACE_CUSTOM_INSTRUCTIONS");
  await page.reload();
  await expect(instructions).toHaveValue("SOURCE_UPDATED_INSTRUCTIONS");
  const { identities } = await (await request.get(`${api}/identities`)).json();
  const added = identities.find((i: { id: string }) => i.id === secondId);
  expect(added.publicProfile).toBeUndefined();
  const { members } = await (await request.get(`${api}/workspaces/${f.workspace.id}/members`)).json();
  expect(members.find((m: { identityId: string }) => m.identityId === secondId).accessRole).toBe("member");
});

test("account agent selection shows a read-only launch summary and defaults instead of JSON", async ({ page, request }) => {
  const f = await setup(page, request, "launch-summary");
  const summary = f.form.locator('dl[aria-label="Template configuration"]');
  const value = (label: string) => summary.locator("div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");
  await expect(value("Harness")).toHaveText("Pi");
  for (const label of ["Provider", "Model", "Reasoning"]) await expect(value(label)).toHaveText("Default");
  const configured = (await call(page, "/local/account/library", "POST", { ...f.source, name: "Configured summary", configuration: { runtimeAdapter: "codex", modelProvider: "openai", modelId: "gpt-5", reasoningLevel: "xhigh" } })).body;
  const defaults = (await call(page, "/local/account/library", "POST", { ...f.source, name: "Default summary", configuration: {} })).body;
  await page.reload();
  await page.getByRole("button", { name: "Add from account agents", exact: true }).click();
  await f.form.getByLabel("Account agent template", { exact: true }).selectOption(configured.id);
  await expect(value("Harness")).toHaveText("Codex");
  await expect(value("Provider")).toHaveText("OpenAI");
  await expect(value("Model")).toHaveText("gpt-5");
  await expect(value("Reasoning")).toHaveText("Extra high");
  await expect(summary.locator("input, select, textarea")).toHaveCount(0);
  await f.form.getByLabel("Account agent template", { exact: true }).selectOption(defaults.id);
  for (const label of ["Harness", "Provider", "Model", "Reasoning"]) await expect(value(label)).toHaveText("Default");
  await expect(f.form.locator("details, pre")).toHaveCount(0);
  await expect(f.form).not.toContainText("SOURCE_ORIGINAL_INSTRUCTIONS");
});

test("stale template addition preserves fields and requires reloading before explicit addition", async ({ page, request }) => {
  const f = await setup(page, request, "stale");
  await page.setViewportSize({ width: 390, height: 844 });
  await f.form.getByLabel("Display name", { exact: true }).fill("Keep this name");
  await f.form.getByLabel("Mention handle", { exact: true }).fill("keep-this-handle");
  expect((await call(page, `/local/account/library/${f.template.id}`, "PATCH", { action: "save", expectedVersion: 1,
    content: { ...f.source, configuration: { ...f.source.configuration, personaPrompt: "UPDATED_BEFORE_ADD", modelProvider: "openai", modelId: "gpt-5" } } })).status).toBe(200);
  let writes = 0;
  page.on("request", req => { if (req.url().endsWith("/agents/from-account-template") && req.method() === "POST") writes++; });
  await f.form.getByRole("button", { name: "Add agent", exact: true }).click();
  await expect(f.form.getByRole("alert")).toContainText("Template changed");
  await expect(f.form.getByLabel("Display name", { exact: true })).toHaveValue("Keep this name");
  await expect(f.form.getByLabel("Mention handle", { exact: true })).toHaveValue("keep-this-handle");
  expect(writes).toBe(1);
  await f.form.getByRole("button", { name: "Reload account agents", exact: true }).click();
  await expect(f.form.locator("dl").filter({ has: page.locator("dt", { hasText: "Model" }) })).toContainText("gpt-5");
  await expect(f.form.locator("details, pre")).toHaveCount(0);
  await f.form.getByRole("button", { name: "Add agent", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${f.root}/identity_[a-f0-9]+$`));
  expect(writes).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
