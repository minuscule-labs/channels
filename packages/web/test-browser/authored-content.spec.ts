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
    await page.getByRole("button", { name: `Conversation actions for ${conversation.name}`, exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    return page.getByRole("dialog", { name: `Manage #${conversation.name}`, exact: true });
  }
  async function seedInstructions() {
    const created = await call(library, "POST", { kind: "instructions", conversationId: conversation.id, content: "ORIGINAL_PUBLISHED_BODY" });
    expect(created.status).toBe(201);
    const document = created.body as LocalAuthoredDocument;
    expect((await call(`${library}/${document.id}`, "PATCH", { action: "publish", expectedVersion: 1 })).status).toBe(200);
    return document;
  }
  return { workspace, conversation, call, library, openChannel, seedInstructions };
}

test("workspace/channel editors publish separate drafts, render inherited defaults, and manage playbook history", async ({ page, request }) => {
  const f = await setup(page, request, "management");
  await page.getByRole("button", { name: `Workspace actions for ${f.workspace.name}`, exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const workspaceDialog = page.getByRole("dialog", { name: `${f.workspace.name} configuration`, exact: true });
  const workspaceInstructions = workspaceDialog.getByRole("region", { name: "Workspace instructions", exact: true });
  await workspaceInstructions.getByLabel("Instructions", { exact: true }).fill("WORKSPACE_NOTE_BASE");
  await expect(workspaceInstructions.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await workspaceInstructions.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(workspaceInstructions.getByText("Unpublished", { exact: true })).toBeVisible();
  await workspaceInstructions.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(workspaceInstructions.getByText("Published r1", { exact: true })).toBeVisible();
  await workspaceDialog.getByRole("button", { name: "Close Workspace configuration", exact: true }).click();
  const channelDialog = await f.openChannel();
  const channelInstructions = channelDialog.getByRole("region", { name: "Channel instructions", exact: true });
  await channelInstructions.getByLabel("Instructions", { exact: true }).fill("CHANNEL_NOTE_OVERRIDE");
  await channelInstructions.getByRole("button", { name: "Save draft", exact: true }).click();
  await channelInstructions.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(channelInstructions.getByText("Published r1", { exact: true })).toBeVisible();
  const effective = channelDialog.getByRole("region", { name: "Effective instructions", exact: true });
  await expect(effective).toContainText("WORKSPACE_NOTE_BASE");
  await expect(effective).toContainText("CHANNEL_NOTE_OVERRIDE");
  await expect(effective.getByText("Not started", { exact: true })).toBeVisible();
  const skills = channelDialog.getByRole("region", { name: "Authored skills", exact: true });
  await skills.getByRole("button", { name: "New skill", exact: true }).click();
  await expect(skills.getByLabel("Skill scope", { exact: true })).toHaveValue("channel");
  await skills.getByLabel("Name", { exact: true }).fill("Release checklist");
  await skills.getByLabel("Description", { exact: true }).fill("Before a release");
  await skills.getByLabel("Instructions", { exact: true }).fill("Check tests and record the release decision.");
  await skills.getByRole("button", { name: "Save draft", exact: true }).click();
  await skills.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(skills.getByText("Published r1", { exact: true })).toBeVisible();
  await skills.getByRole("button", { name: "Revision history", exact: true }).click();
  await expect(skills.getByText(/Revision 1 ·/)).toBeVisible();
  await skills.getByRole("button", { name: "Archive skill", exact: true }).click();
  await expect(skills.getByText("Archived", { exact: true })).toBeVisible();
  const records = (await f.call(f.library)).body as LocalAuthoredDocument[];
  expect(records.filter(document => document.kind === "instructions").map(document => document.conversationId ?? "workspace").sort()).toEqual([f.conversation.id, "workspace"].sort());
  expect(records.find(document => document.kind === "skill")?.state).toBe("archived");
  expect(await page.evaluate(() => Object.values(localStorage).some(value => /WORKSPACE_NOTE_BASE|CHANNEL_NOTE_OVERRIDE|Release checklist/.test(value)))).toBe(false);
});

test("stale saves preserve the local draft and require explicit review before reusing the current token", async ({ page, request }) => {
  const f = await setup(page, request, "conflict");
  const document = await f.seedInstructions();
  const dialog = await f.openChannel();
  const editor = dialog.getByRole("region", { name: "Channel instructions", exact: true });
  const textarea = editor.getByLabel("Instructions", { exact: true });
  await expect(textarea).toHaveValue("ORIGINAL_PUBLISHED_BODY");
  await textarea.fill("LOCAL_UNSAVED_DRAFT");
  const path = `${f.library}/${document.id}`;
  expect((await f.call(path, "PATCH", { action: "save", expectedVersion: 2, content: "OTHER_EDITOR_DRAFT" })).status).toBe(200);
  await editor.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText(/changed/);
  await expect(textarea).toHaveValue("LOCAL_UNSAVED_DRAFT");
  await editor.getByRole("button", { name: "Review latest", exact: true }).click();
  await expect(editor.getByRole("region", { name: "Latest saved draft", exact: true })).toContainText("OTHER_EDITOR_DRAFT");
  await editor.getByRole("button", { name: "Keep draft on latest revision", exact: true }).click();
  await expect(textarea).toHaveValue("LOCAL_UNSAVED_DRAFT");
  await editor.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(editor.getByText("Draft v4", { exact: true })).toBeVisible();
  expect((await f.call(path)).body.content).toBe("LOCAL_UNSAVED_DRAFT");
  expect((await f.call(`${path}/revisions`)).body[0].content).toBe("ORIGINAL_PUBLISHED_BODY");
});

test("management stops and removes private editor state after an access-denied write", async ({ page, request }) => {
  const f = await setup(page, request, "access");
  const document = await f.seedInstructions();
  const dialog = await f.openChannel();
  const editor = dialog.getByRole("region", { name: "Channel instructions", exact: true });
  await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue("ORIGINAL_PUBLISHED_BODY");
  await editor.getByLabel("Instructions", { exact: true }).fill("PRIVATE_LOCAL_DRAFT");
  let writes = 0;
  await page.route(`**${f.library}/${document.id}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++;
    return route.fulfill({ status: 403, json: { error: "Workspace owner or admin required" } });
  });
  await editor.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(dialog.getByText("ORIGINAL_PUBLISHED_BODY", { exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
});
