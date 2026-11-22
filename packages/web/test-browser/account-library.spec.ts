import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { LocalAccountLibraryItem } from "@minu/channels-control/contracts";

const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;
const library = "/local/account/library";
async function login(page: Page, request: APIRequestContext, destination = "/app/account/settings", actor = "owner") {
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}&actor=${actor}`)).json();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("main", { name: "Account settings", exact: true })).toBeVisible();
}
async function call(page: Page, path = library, method = "GET", body?: unknown) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, { method, credentials: "include", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
}

for (const kind of ["skill", "agent-template"] as const) {
  const root = `/app/account/settings/${kind === "skill" ? "skills" : "agents"}`;
  const editorName = kind === "skill" ? "Account skill editor" : "Account agent template editor";
  test(`account ${kind} list/create/edit/archive uses typed APIs and survives reload`, async ({ page, request }, info) => {
    await login(page, request, root);
    const main = page.getByRole("main", { name: "Account settings", exact: true });
    await main.getByRole("link", { name: kind === "skill" ? "New skill" : "New agent template", exact: true }).click();
    const editor = main.getByRole("form", { name: editorName, exact: true });
    const name = `Account ${kind} CRUD`;
    await editor.getByLabel("Name", { exact: true }).fill(name);
    await editor.getByLabel("Description", { exact: true }).fill("Reusable account configuration");
    await editor.getByLabel("Instructions", { exact: true }).fill("PRIVATE_ACCOUNT_INSTRUCTIONS");
    let selectedSkillId: string | undefined;
    if (kind === "agent-template") {
      const selected = await call(page, library, "POST", { kind: "skill", name: "Template selected skill", description: "Shared selection", content: "Shared body" });
      expect(selected.status).toBe(201);
      selectedSkillId = selected.body.id;
      // Reopen the unsaved editor to load the newly created library skill.
      await page.reload();
      await editor.getByLabel("Name", { exact: true }).fill(name);
      await editor.getByLabel("Description", { exact: true }).fill("Reusable account configuration");
      await editor.getByLabel("Instructions", { exact: true }).fill("PRIVATE_ACCOUNT_INSTRUCTIONS");
      await editor.getByLabel("Runtime adapter", { exact: true }).fill("pi");
      await editor.getByLabel("Reasoning level", { exact: true }).selectOption("high");
      await editor.getByLabel("Model provider", { exact: true }).fill("provider");
      await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await editor.getByLabel("Model ID", { exact: true }).fill("model");
      await editor.getByLabel("Template selected skill", { exact: true }).check();
    }
    const writes: string[] = [];
    page.on("request", req => { if (req.url().includes(library) && ["POST", "PATCH"].includes(req.method())) writes.push(req.method()); });
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${root}/[a-f0-9-]+$`));
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue(name);
    const id = page.url().split("/").at(-1)!;
    const original = await call(page, `${library}/${id}`);
    expect(original.body.version).toBe(1);
    if (kind === "agent-template") expect(original.body.configuration).toEqual({ personaPrompt: "PRIVATE_ACCOUNT_INSTRUCTIONS", runtimeAdapter: "pi", reasoningLevel: "high", modelProvider: "provider", modelId: "model", accountSkillIds: [selectedSkillId] });
    await page.reload();
    await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("PRIVATE_ACCOUNT_INSTRUCTIONS");
    await editor.getByLabel("Name", { exact: true }).fill(`${name} edited`);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor.getByRole("status")).toHaveText("Saved");
    const updated = (await call(page, `${library}/${id}`)).body as LocalAccountLibraryItem;
    expect(updated.id).toBe(original.body.id);
    expect(updated.version).toBe(2);
    expect((await call(page, `${library}/${id}/versions`)).body[0]).toEqual(original.body);
    await main.getByRole("link", { name: "Cancel", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${root}$`));
    const table = main.getByRole("table");
    await expect(table.getByRole("link", { name: `${name} edited`, exact: true })).toBeVisible();
    await expect(table).not.toContainText("PRIVATE_ACCOUNT_INSTRUCTIONS");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`account-${kind}-mobile.png`) });
    await table.getByRole("button", { name: `Archive ${name} edited`, exact: true }).click();
    await expect(table.getByRole("link", { name: `${name} edited`, exact: true })).toHaveCount(0);
    expect((await call(page, `${library}/${id}`)).body.state).toBe("archived");
    await page.reload();
    await expect(main.getByRole("table").getByRole("link", { name: `${name} edited`, exact: true })).toHaveCount(0);
    expect(writes).toEqual(["POST", "PATCH", "PATCH"]);
    expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes("PRIVATE_ACCOUNT_INSTRUCTIONS")))).toBe(false);
  });

  test(`account ${kind} refresh failure and reload preserve unsaved edits, while denied refresh tears down the editor`, async ({ page, request }) => {
    await page.clock.install();
    await login(page, request, root);
    const content = kind === "skill" ? { kind, name: "Refresh skill", description: "Saved description", content: "Saved instructions" }
      : { kind, name: "Refresh template", description: "Saved description", configuration: { personaPrompt: "Saved instructions" } };
    const initial = (await call(page, library, "POST", content)).body as LocalAccountLibraryItem;
    await page.goto(`${root}/${initial.id}`);
    const editor = page.getByRole("form", { name: editorName, exact: true });
    await editor.getByLabel("Name", { exact: true }).fill("PRIVATE_UNSAVED_NAME");
    await editor.getByLabel("Description", { exact: true }).fill("PRIVATE_UNSAVED_DESCRIPTION");
    await editor.getByLabel("Instructions", { exact: true }).fill("PRIVATE_UNSAVED_INSTRUCTIONS");
    let failureStatus = 503;
    await page.route(`**${library}`, route => route.request().method() === "GET" && failureStatus
      ? route.fulfill({ status: failureStatus, json: { error: failureStatus === 503 ? "Library refresh unavailable" : "Account access denied" } }) : route.continue());
    await page.clock.fastForward(6_000); // The shared query client keeps successful reads fresh for five seconds.
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByRole("alert")).toContainText("Library refresh unavailable");
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("PRIVATE_UNSAVED_NAME");
    await expect(editor.getByLabel("Description", { exact: true })).toHaveValue("PRIVATE_UNSAVED_DESCRIPTION");
    await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("PRIVATE_UNSAVED_INSTRUCTIONS");
    failureStatus = 0;
    await page.getByRole("button", { name: "Reload library", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("PRIVATE_UNSAVED_NAME");
    await expect(editor.getByLabel("Description", { exact: true })).toHaveValue("PRIVATE_UNSAVED_DESCRIPTION");
    await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("PRIVATE_UNSAVED_INSTRUCTIONS");
    expect((await call(page, `${library}/${initial.id}`)).body).toEqual(initial);
    failureStatus = kind === "skill" ? 401 : 403;
    await page.clock.fastForward(6_000);
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByRole("alert")).toHaveText("Account library access unavailable.");
    await expect(editor).toHaveCount(0);
    await expect(page.getByText("PRIVATE_UNSAVED_INSTRUCTIONS", { exact: true })).toHaveCount(0);
  });

  test(`account ${kind} session-query failure and Retry preserve drafts, while denied session tears down the editor`, async ({ page, request }) => {
    await page.clock.install();
    await login(page, request, root);
    const content = kind === "skill" ? { kind, name: "Session recovery skill", description: "Saved description", content: "Saved instructions" }
      : { kind, name: "Session recovery template", description: "Saved description", configuration: { personaPrompt: "Saved instructions" } };
    const initial = (await call(page, library, "POST", content)).body as LocalAccountLibraryItem;
    await page.goto(`${root}/${initial.id}`);
    const editor = page.getByRole("form", { name: editorName, exact: true });
    await editor.getByLabel("Name", { exact: true }).fill("PRIVATE_SESSION_DRAFT_NAME");
    await editor.getByLabel("Description", { exact: true }).fill("PRIVATE_SESSION_DRAFT_DESCRIPTION");
    await editor.getByLabel("Instructions", { exact: true }).fill("PRIVATE_SESSION_DRAFT_INSTRUCTIONS");
    let failureStatus = 503;
    await page.route("**/local/session", route => failureStatus
      ? route.fulfill({ status: failureStatus, json: { error: failureStatus === 503 ? "Session refresh unavailable" : "Session access denied" } }) : route.continue());
    await page.clock.fastForward(6_000);
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByRole("alert")).toContainText("Session refresh unavailable");
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("PRIVATE_SESSION_DRAFT_NAME");
    await expect(editor.getByLabel("Description", { exact: true })).toHaveValue("PRIVATE_SESSION_DRAFT_DESCRIPTION");
    await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("PRIVATE_SESSION_DRAFT_INSTRUCTIONS");
    failureStatus = 0;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("PRIVATE_SESSION_DRAFT_NAME");
    await expect(editor.getByLabel("Description", { exact: true })).toHaveValue("PRIVATE_SESSION_DRAFT_DESCRIPTION");
    await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("PRIVATE_SESSION_DRAFT_INSTRUCTIONS");
    expect((await call(page, `${library}/${initial.id}`)).body).toEqual(initial);
    failureStatus = kind === "skill" ? 401 : 403;
    await page.clock.fastForward(6_000);
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByRole("alert")).toContainText("Session access denied");
    await expect(editor).toHaveCount(0);
    failureStatus = 0;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("Saved instructions");
  });

  test(`account ${kind} failed and stale saves retain drafts and require explicit conflict review`, async ({ page, request }) => {
    await login(page, request, root);
    const content = kind === "skill" ? { kind, name: "Conflict skill", description: "Original description", content: "Original instructions" }
      : { kind, name: "Conflict template", description: "Original description", configuration: { personaPrompt: "Original instructions" } };
    const initial = (await call(page, library, "POST", content)).body as LocalAccountLibraryItem;
    const path = `${library}/${initial.id}`;
    await page.goto(`${root}/${initial.id}`);
    const editor = page.getByRole("form", { name: editorName, exact: true });
    await editor.getByLabel("Instructions", { exact: true }).fill("LOCAL_UNSAVED_DRAFT");
    let fail = true;
    await page.route(`**${path}`, route => route.request().method() === "PATCH" && fail ? route.fulfill({ status: 503, json: { error: "Save unavailable" } }) : route.continue());
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("Save unavailable");
    await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("LOCAL_UNSAVED_DRAFT");
    expect((await call(page, path)).body).toEqual(initial);
    fail = false;
    const otherContent = kind === "skill" ? { ...content, content: "OTHER_SAVED_VERSION" }
      : { ...content, configuration: { personaPrompt: "OTHER_SAVED_VERSION" } };
    expect((await call(page, path, "PATCH", { action: "save", expectedVersion: 1, content: otherContent })).status).toBe(200);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText(/changed/);
    await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("LOCAL_UNSAVED_DRAFT");
    await editor.getByRole("button", { name: "Review latest", exact: true }).click();
    await expect(editor.getByRole("region", { name: "Latest saved version", exact: true })).toContainText("OTHER_SAVED_VERSION");
    await editor.getByRole("button", { name: "Keep my edits", exact: true }).click();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor.getByRole("status")).toHaveText("Saved");
    const saved = (await call(page, path)).body;
    expect(kind === "skill" ? saved.content : saved.configuration.personaPrompt).toBe("LOCAL_UNSAVED_DRAFT");
    expect(saved.version).toBe(3);
    await editor.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${root}$`));
    expect((await call(page, path)).body.state).toBe("archived");
  });
}

test("session identity changes discard the previous account draft without navigation", async ({ page, request }) => {
  await page.clock.install();
  await login(page, request);
  const initial = (await call(page, library, "POST", { kind: "skill", name: "Identity boundary skill", description: "Original account", content: "Original saved instructions" })).body as LocalAccountLibraryItem;
  await page.goto(`/app/account/settings/skills/${initial.id}`);
  const editor = page.getByRole("form", { name: "Account skill editor", exact: true });
  await editor.getByLabel("Instructions", { exact: true }).fill("PREVIOUS_ACCOUNT_UNSAVED_DRAFT");
  const session = (await call(page, "/local/session")).body;
  // Model a client session transition without reloading the page. Server owner isolation is tested separately.
  await page.route("**/local/session", route => route.fulfill({ json: { ...session, identityId: "replacement-account-identity" } }));
  await page.route(`**${library}`, route => route.fulfill({ json: [{ ...initial, ownerIdentityId: "replacement-account-identity", content: "Replacement account instructions" }] }));
  await page.clock.fastForward(6_000);
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("Replacement account instructions");
  await expect(editor.getByLabel("Instructions", { exact: true })).not.toHaveValue("PREVIOUS_ACCOUNT_UNSAVED_DRAFT");
  expect((await call(page, `${library}/${initial.id}`)).body).toEqual(initial);
});

test("late account create cannot replace a newer draft after Cancel", async ({ page, request }) => {
  const root = "/app/account/settings/skills";
  await login(page, request, `${root}/new`);
  const editor = page.getByRole("form", { name: "Account skill editor", exact: true });
  await editor.getByLabel("Name", { exact: true }).fill("Delayed create");
  await editor.getByLabel("Description", { exact: true }).fill("Delayed description");
  await editor.getByLabel("Instructions", { exact: true }).fill("Delayed body");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  await page.route(`**${library}`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch({ url: `http://127.0.0.1:${process.env.MINU_TEST_CONTROL_PORT ?? 58411}${library}` }); started(); await gate; await route.fulfill({ response });
  });
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await pending;
  await page.getByRole("link", { name: "Cancel", exact: true }).click();
  await page.getByRole("link", { name: "New skill", exact: true }).click();
  await editor.getByLabel("Name", { exact: true }).fill("Newer draft");
  release();
  await expect.poll(async () => ((await call(page)).body as LocalAccountLibraryItem[]).some(item => item.name === "Delayed create")).toBe(true);
  await expect(page).toHaveURL(new RegExp(`${root}/new$`));
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Newer draft");
});

test("account libraries remain available before the first workspace on mobile", async ({ page, request }, info) => {
  await request.post(`${fixture}/hide-workspaces?value=true`);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, request);
    await page.goto("/");
    await expect(page.getByRole("dialog", { name: "Create your first Workspace", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Account settings", exact: true }).click();
    await page.getByRole("link", { name: "New skill", exact: true }).click();
    const editor = page.getByRole("form", { name: "Account skill editor", exact: true });
    await editor.getByLabel("Name", { exact: true }).fill("Before first workspace");
    await editor.getByLabel("Description", { exact: true }).fill("Account-only skill");
    await editor.getByLabel("Instructions", { exact: true }).fill("Account instructions");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/account\/settings\/skills\/[a-f0-9-]+$/);
    await page.reload();
    await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("Account instructions");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const heading = (await page.getByRole("heading", { name: "Account settings", exact: true }).boundingBox())!;
    const navigation = (await page.getByRole("button", { name: "Open navigation", exact: true }).boundingBox())!;
    expect(heading.y).toBeGreaterThan(navigation.y + navigation.height);
    await page.screenshot({ path: info.outputPath("account-skill-editor-mobile.png") });
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("dialog", { name: "Navigation", exact: true }).getByRole("link", { name: "Account settings", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Navigation", exact: true })).toHaveCount(0);
  } finally { await request.post(`${fixture}/hide-workspaces?value=false`); }
});

test("account entry point works without workspace admin rights and account libraries remain isolated", async ({ page, request }) => {
  await login(page, request);
  const item = (await call(page, library, "POST", { kind: "skill", name: "OWNER_PRIVATE_SKILL", description: "Owner only", content: "OWNER_PRIVATE_BODY" })).body;
  await login(page, request, "/app/account/settings", "member");
  await expect(page.getByRole("table").getByRole("link", { name: "OWNER_PRIVATE_SKILL", exact: true })).toHaveCount(0);
  expect((await call(page, `${library}/${item.id}`)).status).toBe(404);
  await page.goto(`/app/account/settings/skills/${item.id}`);
  await expect(page.getByRole("alert")).toHaveText("Library item unavailable.");
  await page.goto("/");
  await page.getByRole("link", { name: "Account settings", exact: true }).click();
  await page.getByRole("link", { name: "New skill", exact: true }).click();
  const editor = page.getByRole("form", { name: "Account skill editor", exact: true });
  await editor.getByLabel("Name", { exact: true }).fill("Member private skill");
  await editor.getByLabel("Description", { exact: true }).fill("No workspace admin required");
  await editor.getByLabel("Instructions", { exact: true }).fill("Member account instructions");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/account\/settings\/skills\/[a-f0-9-]+$/);
  await page.route("**/local/account/library/*", route => route.request().method() === "PATCH" ? route.fulfill({ status: 401, json: { error: "Session expired" } }) : route.continue());
  await editor.getByLabel("Name", { exact: true }).fill("Private unsaved edit");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Account library access unavailable.");
  await expect(editor).toHaveCount(0);
});
