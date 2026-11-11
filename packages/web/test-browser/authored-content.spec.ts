import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { LocalAuthoredDocument } from "@minu/channels-control/contracts";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

async function setup(page: Page, request: APIRequestContext, suffix: string) {
  const { workspaces } = await (await request.get(`${api}/workspaces`)).json() as { workspaces: Array<{ id: string; name: string }> };
  const primary = workspaces.find(workspace => workspace.name === "Browser Test")!;
  const { members } = await (await request.get(`${api}/workspaces/${primary.id}/members`)).json() as { members: Array<{ identityId: string; mentionHandle: string }> };
  const owner = members.find(member => member.mentionHandle === "david")!.identityId;
  const agent = members.find(member => member.mentionHandle === "builder")!.identityId;
  const name = `Authored ${suffix}`;
  const response = await request.post(`${api}/workspaces`, { data: { slug: `authored-${suffix}`, name } });
  expect(response.ok()).toBe(true);
  const { workspace } = await response.json() as { workspace: { id: string; name: string } };
  for (const [identityId, mentionHandle, accessRole] of [[owner, "owner", "owner"], [agent, "builder", "member"]] as const) {
    expect((await request.post(`${api}/workspaces/${workspace.id}/members`, { data: { identityId, mentionHandle, accessRole } })).ok()).toBe(true);
  }
  const { conversation } = await (await request.post(`${api}/conversations`, { data: { workspaceId: workspace.id, name: `authored-${suffix}`, actorIdentityId: owner, participantIds: [owner, agent] } })).json() as { conversation: { id: string; name: string } };
  const destination = `/app/workspaces/${workspace.id}/conversations/${conversation.id}`;
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}`)).json() as { launchUrl: string };
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  async function call(path: string, method = "GET", body?: unknown) {
    return page.evaluate(async ({ path, method, body }) => {
      const response = await fetch(path, { method, credentials: "include", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }, { path, method, body });
  }
  const library = `/local/workspaces/${workspace.id}/authored-documents`;
  async function openChannel() {
    await page.goto(destination);
    await page.getByRole("button", { name: `Conversation actions for ${conversation.name}`, exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    return page.getByRole("main", { name: "Conversation settings", exact: true });
  }
  async function openWorkspaceInstructions() {
    await page.goto(`/app/workspaces/${workspace.id}/settings/instructions`);
    return page.getByRole("main", { name: "Workspace Settings", exact: true });
  }
  async function seedInstructions() {
    const created = await call(library, "POST", { kind: "instructions", content: "ORIGINAL_PUBLISHED_BODY" });
    expect(created.status).toBe(201);
    const document = created.body as LocalAuthoredDocument;
    expect((await call(`${library}/${document.id}`, "PATCH", { action: "publish", expectedVersion: 1 })).status).toBe(200);
    return document;
  }
  return { workspace, conversation, call, library, openChannel, openWorkspaceInstructions, seedInstructions };
}

test("atomic Workspace Save preserves snapshots without channel authoring", async ({ page, request }, info) => {
  const f = await setup(page, request, "management");
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  page.on("request", request => {
    if (request.url().includes("/authored-documents") && ["POST", "PATCH"].includes(request.method())) writes.push({ method: request.method(), body: request.postDataJSON() });
  });
  await page.getByRole("button", { name: `Workspace actions for ${f.workspace.name}`, exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const workspacePage = page.getByRole("main", { name: "Workspace Settings", exact: true });
  const navigation = page.getByRole("navigation", { name: "Workspace settings", exact: true });
  await expect(workspacePage.getByRole("navigation")).toHaveCount(0);
  await expect(workspacePage.getByRole("region", { name: "Workspace instructions", exact: true })).toHaveCount(0);
  await navigation.getByRole("link", { name: "Instructions", exact: true }).click();
  await expect(navigation.getByRole("link", { name: "Instructions", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(workspacePage.getByRole("region", { name: "Authored skills", exact: true })).toHaveCount(0);
  const workspaceInstructions = workspacePage.getByRole("region", { name: "Workspace instructions", exact: true });
  await workspaceInstructions.getByLabel("Instructions", { exact: true }).fill("WORKSPACE_NOTE_BASE");
  await expect(workspacePage.getByRole("button", { name: /^(Publish|Save draft|Revision history)$/ })).toHaveCount(0);
  await workspaceInstructions.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => ((await f.call(f.library)).body as LocalAuthoredDocument[]).find(doc => doc.kind === "instructions" && !doc.conversationId)?.publishedRevision).toBe(1);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body.action).toBe("commit");
  await expect(workspaceInstructions.getByText(/Draft v|Published r|Unpublished/)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("workspace-instructions-sidebar.png") });
  await navigation.getByRole("link", { name: "Skills", exact: true }).click();
  await expect(workspacePage.getByRole("region", { name: "Workspace instructions", exact: true })).toHaveCount(0);
  const workspaceSkills = workspacePage.getByRole("region", { name: "Authored skills", exact: true });
  await workspaceSkills.getByRole("link", { name: "New skill", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/skills\/new$/);
  await expect(workspaceSkills.getByRole("table")).toHaveCount(0);
  await workspaceSkills.getByLabel("Name", { exact: true }).fill("Summarize");
  await workspaceSkills.getByLabel("Description", { exact: true }).fill("Summarize supplied context into concise bullet points.");
  await workspaceSkills.getByLabel("Instructions", { exact: true }).fill("Summarize the supplied context. Preserve key facts and action items. Do not invent missing information.");
  await page.screenshot({ path: info.outputPath("workspace-skill-new.png") });
  await workspaceSkills.getByRole("button", { name: "Save", exact: true }).click();
  await expect(workspaceSkills.getByRole("button", { name: "Archive skill", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/\/settings\/skills\/[a-f0-9-]+$/);
  await page.screenshot({ path: info.outputPath("workspace-skills-sidebar.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(workspaceSkills.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("workspace-skills-save-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await expect(navigation.getByRole("link", { name: "Skills", exact: true })).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("link", { name: "Instructions", exact: true }).click();
  await expect(workspaceInstructions.getByLabel("Instructions", { exact: true })).toHaveValue("WORKSPACE_NOTE_BASE");
  const channelDialog = await f.openChannel();
  await expect(channelDialog.getByLabel("Conversation name", { exact: true })).toHaveValue(f.conversation.name);
  await expect(channelDialog.getByRole("region", { name: "Channel instructions", exact: true })).toHaveCount(0);
  await expect(channelDialog.getByRole("region", { name: "Authored skills", exact: true })).toHaveCount(0);
  await expect(channelDialog.getByLabel("Instructions", { exact: true })).toHaveCount(0);
  expect(writes).toHaveLength(2);
  expect(writes.every(write => write.method === "POST" && write.body.action === "commit" && !write.body.conversationId)).toBe(true);
  const effective = (await f.call(`/local/conversations/${f.conversation.id}/authored-context`)).body;
  expect(effective.instructions).toContain("WORKSPACE_NOTE_BASE");
  const records = (await f.call(f.library)).body as LocalAuthoredDocument[];
  expect(records.filter(document => document.kind === "instructions").map(document => document.conversationId ?? "workspace")).toEqual(["workspace"]);
  expect(records.find(document => document.name === "Summarize")?.publishedRevision).toBe(1);
  expect(await page.evaluate(() => Object.values(localStorage).some(value => /WORKSPACE_NOTE_BASE|Summarize the supplied context/.test(value)))).toBe(false);
});

test("stale saves preserve the local draft and require explicit review before reusing the current token", async ({ page, request }) => {
  const f = await setup(page, request, "conflict");
  const document = await f.seedInstructions();
  const dialog = await f.openWorkspaceInstructions();
  const editor = dialog.getByRole("region", { name: "Workspace instructions", exact: true });
  const textarea = editor.getByLabel("Instructions", { exact: true });
  await expect(textarea).toHaveValue("ORIGINAL_PUBLISHED_BODY");
  await textarea.fill("LOCAL_UNSAVED_DRAFT");
  const path = `${f.library}/${document.id}`;
  expect((await f.call(path, "PATCH", { action: "save", expectedVersion: 2, content: "OTHER_EDITOR_DRAFT" })).status).toBe(200);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText(/changed/);
  await expect(textarea).toHaveValue("LOCAL_UNSAVED_DRAFT");
  await editor.getByRole("button", { name: "Review latest", exact: true }).click();
  await expect(editor.getByRole("region", { name: "Latest saved version", exact: true })).toContainText("OTHER_EDITOR_DRAFT");
  await editor.getByRole("button", { name: "Keep my edits", exact: true }).click();
  await expect(textarea).toHaveValue("LOCAL_UNSAVED_DRAFT");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByText("Saved", { exact: true })).toBeVisible();
  expect((await f.call(path)).body.content).toBe("LOCAL_UNSAVED_DRAFT");
  expect((await f.call(`${path}/revisions`)).body[0].content).toBe("ORIGINAL_PUBLISHED_BODY");
});

test("old drafts activate only on explicit Save and failed saves retain local edits and saved content", async ({ page, request }, info) => {
  const f = await setup(page, request, "atomic-save");
  const created = await f.call(f.library, "POST", { kind: "instructions", content: "LEGACY_UNPUBLISHED_BODY" });
  expect(created.status).toBe(201);
  const path = `${f.library}/${created.body.id}`;
  const dialog = await f.openWorkspaceInstructions();
  const editor = dialog.getByRole("region", { name: "Workspace instructions", exact: true });
  await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("LEGACY_UNPUBLISHED_BODY");
  expect((await f.call(path)).body.publishedRevision).toBeUndefined();
  await page.reload();
  await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("LEGACY_UNPUBLISHED_BODY");
  expect((await f.call(path)).body.publishedRevision).toBeUndefined();
  let writes = 0;
  let reject = false;
  await page.route(`**${path}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++;
    expect(route.request().postDataJSON().action).toBe("commit");
    if (reject) return route.fulfill({ status: 503, json: { error: "Save unavailable" } });
    return route.continue();
  });
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByText("Saved", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  expect((await f.call(path)).body.publishedRevision).toBe(1);
  const before = (await f.call(path)).body;
  reject = true;
  await editor.getByLabel("Instructions", { exact: true }).fill("UNSAVED_LOCAL_EDIT");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("Save unavailable");
  expect(writes).toBe(2);
  await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("UNSAVED_LOCAL_EDIT");
  expect((await f.call(path)).body).toEqual(before);
  expect((await f.call(`${path}/revisions`)).body).toHaveLength(1);
  await expect(editor.getByRole("button", { name: /^(Publish|Save draft|Revision history)$/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("atomic-save-failure-retains-edit.png") });
});

test("Workspace Skills opens a separate editor and removes through archive on mobile", async ({ page, request }, info) => {
  const f = await setup(page, request, "skills-table");
  const description = "A concise summary of supplied context. ".repeat(4);
  const created = await f.call(f.library, "POST", { action: "commit", kind: "skill", name: "Summarize", description, content: "PRIVATE_TABLE_BODY" });
  expect(created.status).toBe(201);
  const id = created.body.id;
  const root = `/app/workspaces/${f.workspace.id}/settings/skills`;
  await page.goto(root);
  const panel = page.getByRole("region", { name: "Authored skills", exact: true });
  const table = page.getByRole("table", { name: "Skills", exact: true });
  await expect(table.getByRole("columnheader", { name: "Name", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Description", exact: true })).toBeVisible();
  await expect(table.getByRole("cell", { name: description.trim(), exact: true })).toBeVisible();
  await expect(panel.getByText("PRIVATE_TABLE_BODY", { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel("Name", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("skills-table-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("skills-table-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 720 });
  const actions = table.getByRole("button", { name: "Skill actions for Summarize", exact: true });
  await actions.click(); await page.keyboard.press("Escape"); await expect(actions).toBeFocused();
  await actions.click(); await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}/${id}$`));
  await expect(table).toHaveCount(0);
  await expect(panel.getByLabel("Instructions", { exact: true })).toHaveValue("PRIVATE_TABLE_BODY");
  await panel.getByLabel("Description", { exact: true }).fill("Updated summary description");
  let writes = 0;
  const path = `${f.library}/${id}`;
  await page.route(`**${path}`, route => { if (route.request().method() === "PATCH") writes++; return route.continue(); });
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByText("Saved", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  await page.reload();
  await expect(panel.getByLabel("Description", { exact: true })).toHaveValue("Updated summary description");
  await page.screenshot({ path: info.outputPath("skill-edit-desktop.png") });
  await page.getByRole("link", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}$`));
  await expect(table.getByRole("cell", { name: "Updated summary description", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await actions.click();
  await page.screenshot({ path: info.outputPath("skills-table-mobile-menu.png") });
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await expect(table.getByRole("cell", { name: "Summarize", exact: true })).toHaveCount(0);
  expect(writes).toBe(2);
  expect((await f.call(path)).body.state).toBe("archived");
  expect((await f.call(`${path}/revisions`)).body).toHaveLength(2);
  await page.reload();
  await expect(table.getByRole("cell", { name: "Summarize", exact: true })).toHaveCount(0);
});

for (const action of ["create", "save", "archive"] as const) {
  test(`late ${action} after ${action === "save" ? "Back" : "Cancel"} cannot replace a newer Skill draft`, async ({ page, request }) => {
    const f = await setup(page, request, `late-${action}`);
    const original = action === "create" ? undefined : (await f.call(f.library, "POST", {
      action: "commit", kind: "skill", name: "Original", description: "Original description", content: "Original body",
    })).body as LocalAuthoredDocument | undefined;
    const list = `/app/workspaces/${f.workspace.id}/settings/skills`;
    await page.goto(`${list}/${original?.id ?? "new"}`);
    const editor = page.getByLabel("Skill editor", { exact: true });
    await expect(editor).toBeVisible();
    if (action !== "archive") {
      await editor.getByLabel("Name", { exact: true }).fill("Committed skill");
      await editor.getByLabel("Description", { exact: true }).fill("Committed description");
      await editor.getByLabel("Instructions", { exact: true }).fill("Committed body");
    }
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let committed!: () => void;
    const reached = new Promise<void>(resolve => { committed = resolve; });
    let result!: LocalAuthoredDocument;
    await page.route("**/authored-documents{,/*}", async route => {
      if (!["POST", "PATCH"].includes(route.request().method())) return route.continue();
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `http://127.0.0.1:${process.env.MINU_TEST_CONTROL_PORT ?? 58411}${url.pathname}` });
      expect(response.ok()).toBe(true);
      result = await response.json() as LocalAuthoredDocument;
      committed();
      await held;
      await route.fulfill({ response });
    });
    const completed = page.waitForResponse(response => response.url().includes("/authored-documents") && ["POST", "PATCH"].includes(response.request().method()));
    try {
      await editor.getByRole("button", { name: action === "archive" ? "Archive skill" : "Save", exact: true }).click();
      await reached;
      await page.getByRole("link", { name: action === "save" ? "← Skills" : "Cancel", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${list}$`));
      await page.getByRole("link", { name: "New skill", exact: true }).click();
      await editor.getByLabel("Name", { exact: true }).fill("New unsaved draft");
      await editor.getByLabel("Description", { exact: true }).fill("Keep this description");
      await editor.getByLabel("Instructions", { exact: true }).fill("Keep this body");
    } finally { release(); }
    await completed;
    // Read the actual committed outcome after delivery, without resubmitting the mutation.
    const saved = await f.call(`${f.library}/${result.id}`);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ state: action === "archive" ? "archived" : "active", content: action === "archive" ? "Original body" : "Committed body" });
    await expect(page).toHaveURL(new RegExp(`${list}/new$`));
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("New unsaved draft");
    await expect(editor.getByLabel("Description", { exact: true })).toHaveValue("Keep this description");
    await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("Keep this body");
  });
}

test("table Remove conflicts require explicit reload and denied removal tears down private metadata", async ({ page, request }) => {
  const f = await setup(page, request, "skills-table-denied");
  const created = await f.call(f.library, "POST", { action: "commit", kind: "skill", name: "Private skill", description: "Private summary", content: "PRIVATE_PROCEDURE_NOT_IN_TABLE" });
  const path = `${f.library}/${created.body.id}`;
  await page.goto(`/app/workspaces/${f.workspace.id}/settings/skills`);
  const panel = page.getByRole("region", { name: "Authored skills", exact: true });
  const table = panel.getByRole("table", { name: "Skills", exact: true });
  await expect(table.getByRole("cell", { name: "Private summary", exact: true })).toBeVisible();
  expect((await f.call(path, "PATCH", { action: "commit", expectedVersion: 1, name: "Private skill", description: "Other editor summary", content: "OTHER_PRIVATE_BODY" })).status).toBe(200);
  await table.getByRole("button", { name: "Skill actions for Private skill", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(/changed/);
  expect((await f.call(path)).body.state).toBe("active");
  await expect(table.getByRole("cell", { name: "Private summary", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Reload skills", exact: true }).click();
  await expect(table.getByRole("cell", { name: "Other editor summary", exact: true })).toBeVisible();
  let denied = 0;
  await page.route(`**${path}`, route => {
    if (route.request().method() !== "PATCH") return route.continue();
    denied++;
    return route.fulfill({ status: 403, json: { error: "Workspace owner or admin required" } });
  });
  await table.getByRole("button", { name: "Skill actions for Private skill", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByText("Other editor summary", { exact: true })).toHaveCount(0);
  expect(denied).toBe(1);
});

test("management stops and removes private editor state after an access-denied write", async ({ page, request }) => {
  const f = await setup(page, request, "access");
  const document = await f.seedInstructions();
  const dialog = await f.openWorkspaceInstructions();
  const editor = dialog.getByRole("region", { name: "Workspace instructions", exact: true });
  await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("ORIGINAL_PUBLISHED_BODY");
  await editor.getByLabel("Instructions", { exact: true }).fill("PRIVATE_LOCAL_DRAFT");
  let writes = 0;
  await page.route(`**${f.library}/${document.id}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++;
    return route.fulfill({ status: 403, json: { error: "Workspace owner or admin required" } });
  });
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(dialog.getByText("ORIGINAL_PUBLISHED_BODY", { exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
});

test("Conversation settings has no authoring reads or controls and preserves legacy data", async ({ page, request }, info) => {
  const f = await setup(page, request, "settings-cleanup");
  const id = await page.evaluate(() => `conversation_${crypto.randomUUID().replaceAll("-", "")}`);
  expect((await f.call(`/local/workspaces/${f.workspace.id}/conversations`, "POST", {
    id, name: "Preset instructions retained", participants: [], guidance: "PRESERVED_PRESET_INSTRUCTIONS",
  })).status).toBe(201);
  for (const document of [
    { kind: "instructions", conversationId: id, content: "LEGACY_CHANNEL_INSTRUCTIONS" },
    { kind: "skill", conversationId: id, name: "Legacy channel skill", description: "Keep legacy skill", content: "LEGACY_CHANNEL_SKILL" },
  ]) expect((await f.call(f.library, "POST", { action: "commit", ...document })).status).toBe(201);
  const snapshotPath = `/local/conversations/${id}/creation-setup`, settingsPath = `/local/conversations/${id}/settings`;
  const originalSnapshot = (await f.call(snapshotPath)).body, originalSettings = (await f.call(settingsPath)).body;
  const documents = (await f.call(f.library)).body as LocalAuthoredDocument[];
  const readDocuments = () => Promise.all(documents.map(async document => ({
    document: (await f.call(`${f.library}/${document.id}`)).body,
    revisions: (await f.call(`${f.library}/${document.id}/revisions`)).body,
  })));
  const originals = await readDocuments();
  const reads: string[] = [], writes: string[] = [];
  page.on("request", request => {
    if (request.method() === "GET" && /authored-documents|\/(creation-setup|authored-context|revisions)$|\/local\/conversations\/[^/]+\/settings$/.test(request.url())) reads.push(request.url());
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method())) writes.push(request.url());
  });
  await page.goto(`/app/workspaces/${f.workspace.id}/conversations/${id}/settings`);
  const main = page.getByRole("main", { name: "Conversation settings", exact: true });
  await expect(main.getByLabel("Conversation name", { exact: true })).toHaveValue("Preset instructions retained");
  for (const name of ["Channel instructions", "Workspace instructions", "Authored skills", "Effective instructions"]) await expect(main.getByRole("region", { name, exact: true })).toHaveCount(0);
  for (const name of ["Participants & roles", "Collaboration", "Session defaults", "Saved instructions", "Session instructions"]) await expect(main.getByRole("heading", { name, exact: true })).toHaveCount(0);
  await expect(main.getByLabel("Instructions", { exact: true })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "New skill", exact: true })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Save participants", exact: true })).toBeVisible();
  await expect(main.getByRole("region", { name: "Working folders", exact: true })).toBeVisible();
  expect(reads).toEqual([]);
  expect(writes).toEqual([]);
  await page.screenshot({ path: info.outputPath("conversation-settings-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("conversation-settings-mobile.png"), fullPage: true });
  await main.getByLabel("Conversation name", { exact: true }).fill("Renamed without authoring");
  const renamed = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/conversations/${id}`));
  await main.getByRole("button", { name: "Save name", exact: true }).click();
  expect((await renamed).ok()).toBe(true);
  await page.reload();
  await expect(main.getByLabel("Conversation name", { exact: true })).toHaveValue("Renamed without authoring");
  expect(reads).toEqual([]);
  expect(writes).toHaveLength(1);
  expect(writes[0]).not.toContain("/local/");
  const workspaceRoot = `/app/workspaces/${f.workspace.id}/settings`;
  await page.goto(`${workspaceRoot}/skills`);
  await expect(page.getByRole("table", { name: "Skills", exact: true })).toBeVisible();
  await expect(page.getByText("Legacy channel skill", { exact: true })).toHaveCount(0);
  const legacySkill = documents.find(document => document.kind === "skill")!;
  await page.goto(`${workspaceRoot}/skills/${legacySkill.id}`);
  await expect(page.getByRole("alert")).toContainText("Skill is unavailable");
  await expect(page.getByLabel("Skill editor", { exact: true })).toHaveCount(0);
  await page.goto(`${workspaceRoot}/instructions`);
  await expect(page.getByRole("region", { name: "Workspace instructions", exact: true }).getByLabel("Instructions", { exact: true })).toHaveValue("");
  expect(writes).toHaveLength(1);
  expect((await f.call(snapshotPath)).body).toEqual(originalSnapshot);
  expect((await f.call(settingsPath)).body).toEqual(originalSettings);
  expect(await readDocuments()).toEqual(originals);
});
