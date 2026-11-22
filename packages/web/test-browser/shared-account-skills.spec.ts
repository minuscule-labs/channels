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
  const { workspace } = await (await request.post(`${api}/workspaces`, { data: { name: `Shared skills ${suffix}`, slug: `shared-skills-${suffix}` } })).json();
  await request.post(`${api}/workspaces/${workspace.id}/members`, { data: { identityId: owner, mentionHandle: "owner", accessRole: "owner" } });
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent("/app/account/settings")}`)).json();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  expect((await call(page, `/local/workspaces/${workspace.id}/config`, "PUT", { rootUri: "/tmp" })).status).toBe(200);
  const content = { kind: "skill", name: `Shared procedure ${suffix}`, description: "Reusable procedure", content: "ACCOUNT_SHARED_ORIGINAL" };
  const skill = (await call(page, "/local/account/library", "POST", content)).body;
  const template = (await call(page, "/local/account/library", "POST", { kind: "agent-template", name: `Agent ${suffix}`, description: "Template", configuration: { runtimeAdapter: "pi", accountSkillIds: [skill.id] } })).body;
  const result = await call(page, `/local/workspaces/${workspace.id}/agents/from-account-template`, "POST", { templateId: template.id, expectedTemplateVersion: 1, displayName: `Agent ${suffix}`, mentionHandle: `agent-${suffix}` });
  expect(result.status).toBe(201);
  const agentId = result.body.identity.id;
  const path = `/app/workspaces/${workspace.id}/agents/${agentId}`;
  const configPath = `/local/workspaces/${workspace.id}/agents/${agentId}/config`;
  await page.goto(path);
  const form = page.getByRole("form", { name: "Agent skill selection", exact: true });
  await expect(form.getByRole("group", { name: "Account skills", exact: true }).getByRole("checkbox", { name: skill.name, exact: true })).toBeChecked();
  return { workspace, agentId, path, configPath, content, skill, form };
}

test("account selection and explicit independent copies stay isolated and editable in workspace skills", async ({ page, request }) => {
  const f = await setup(page, request, "copy");
  await f.form.getByRole("button", { name: `Make independent copy of ${f.skill.name}`, exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/skills\/[a-f0-9-]+$/);
  const copyId = page.url().split("/").at(-1)!;
  const editor = page.getByLabel("Skill editor", { exact: true });
  await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("ACCOUNT_SHARED_ORIGINAL");
  await editor.getByLabel("Name", { exact: true }).fill("Independent local procedure");
  await editor.getByLabel("Instructions", { exact: true }).fill("LOCAL_CUSTOM_PROCEDURE");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByText("Saved", { exact: true })).toBeVisible();
  expect((await call(page, `/local/account/library/${f.skill.id}`)).body.content).toBe("ACCOUNT_SHARED_ORIGINAL");
  await page.goto(f.path);
  await f.form.getByRole("group", { name: "Account skills", exact: true }).getByRole("checkbox", { name: f.skill.name, exact: true }).uncheck();
  await f.form.getByRole("group", { name: "Workspace skills", exact: true }).getByRole("checkbox", { name: "Independent local procedure", exact: true }).check();
  await f.form.getByRole("button", { name: "Save skill selection", exact: true }).click();
  await expect(f.form.getByRole("status")).toHaveText("Saved");
  const config = (await call(page, f.configPath)).body;
  expect(config.accountSkills.skillIds).toEqual([]);
  expect(config.workspaceSkillIds).toEqual([copyId]);
  expect((await call(page, `/local/account/library/${f.skill.id}`, "PATCH", { action: "save", expectedVersion: 1, content: { ...f.content, content: "SHARED_UPDATED_INDEPENDENTLY" } })).status).toBe(200);
  expect((await call(page, `/local/workspaces/${f.workspace.id}/authored-documents/${copyId}`)).body.content).toBe("LOCAL_CUSTOM_PROCEDURE");
  await page.reload();
  await expect(f.form.getByRole("group", { name: "Workspace skills", exact: true }).getByRole("checkbox", { name: "Independent local procedure", exact: true })).toBeChecked();
});

for (const boundary of ["session", "account", "config"] as const) {
  test(`unsaved skill selection survives a transient ${boundary} refresh failure and recovery`, async ({ page, request }) => {
    await page.clock.install();
    const f = await setup(page, request, `refresh-${boundary}`);
    const checkbox = f.form.getByRole("group", { name: "Account skills", exact: true }).getByRole("checkbox", { name: f.skill.name, exact: true });
    await checkbox.uncheck();
    const match = boundary === "session" ? "**/local/session" : boundary === "account" ? "**/local/account/library" : `**${f.configPath}`;
    let fail = true;
    await page.route(match, route => route.request().method() === "GET" && fail ? route.fulfill({ status: 503, json: { error: "Temporary skill selection refresh failure" } }) : route.continue());
    await page.clock.fastForward(61_000);
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByRole("alert").filter({ hasText: "Temporary skill selection refresh failure" }).first()).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    fail = false;
    await page.clock.fastForward(61_000);
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByRole("alert").filter({ hasText: "Temporary skill selection refresh failure" })).toHaveCount(0);
    await expect(checkbox).not.toBeChecked();
    expect((await call(page, f.configPath)).body.accountSkills.skillIds).toEqual([f.skill.id]);
    await f.form.getByRole("button", { name: "Save skill selection", exact: true }).click();
    await expect(f.form.getByRole("status")).toHaveText("Saved");
    expect((await call(page, f.configPath)).body.accountSkills.skillIds).toEqual([]);
  });
}

test("failed skill saves preserve selection and stale independent copies require explicit source reload", async ({ page, request }) => {
  const f = await setup(page, request, "errors");
  const checkbox = f.form.getByRole("group", { name: "Account skills", exact: true }).getByRole("checkbox", { name: f.skill.name, exact: true });
  await checkbox.uncheck();
  await page.route(`**${f.configPath}`, route => route.request().method() === "PATCH" ? route.fulfill({ status: 503, json: { error: "Save unavailable" } }) : route.continue());
  await f.form.getByRole("button", { name: "Save skill selection", exact: true }).click();
  await expect(f.form.getByRole("alert")).toContainText("Save unavailable");
  await expect(checkbox).not.toBeChecked();
  expect((await call(page, f.configPath)).body.accountSkills.skillIds).toEqual([f.skill.id]);
  expect((await call(page, `/local/account/library/${f.skill.id}`, "PATCH", { action: "save", expectedVersion: 1, content: { ...f.content, content: "NEW_SHARED_BODY" } })).status).toBe(200);
  await f.form.getByRole("button", { name: `Make independent copy of ${f.skill.name}`, exact: true }).click();
  await expect(f.form.getByRole("alert").filter({ hasText: "Account skill changed" })).toBeVisible();
  expect((await call(page, `/local/workspaces/${f.workspace.id}/authored-documents`)).body).toEqual([]);
  await f.form.getByRole("alert").filter({ hasText: "Account skill changed" }).getByRole("button", { name: "Reload skills", exact: true }).click();
  await f.form.getByRole("button", { name: `Make independent copy of ${f.skill.name}`, exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/skills\/[a-f0-9-]+$/);
  await expect(page.getByLabel("Skill editor", { exact: true }).getByLabel("Instructions", { exact: true })).toHaveValue("NEW_SHARED_BODY");
});
