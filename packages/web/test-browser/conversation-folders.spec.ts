import type { ConversationFolder, ConversationMetadata, Workspace, WorkspaceMember } from "@minu/channels-core/types";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

async function seed(request: APIRequestContext, name: string) {
  const { workspaces } = await (await request.get(`${api}/workspaces`)).json() as { workspaces: Workspace[] };
  const workspace = workspaces.find(item => item.name === "Browser Test")!;
  const { members } = await (await request.get(`${api}/workspaces/${workspace.id}/members`)).json() as { members: WorkspaceMember[] };
  const ownerId = members.find(member => member.mentionHandle === "david")!.identityId;
  const agentId = members.find(member => member.mentionHandle === "builder")!.identityId;
  const created = await request.post(`${api}/conversations`, { data: { workspaceId: workspace.id, actorIdentityId: ownerId, participantIds: [ownerId], name } });
  expect(created.ok()).toBe(true);
  const { conversation } = await created.json() as { conversation: ConversationMetadata };
  const folder = async (folderName: string) => {
    const response = await request.post(`${api}/workspaces/${workspace.id}/folders`, { data: { actorIdentityId: ownerId, name: folderName } });
    expect(response.ok()).toBe(true);
    return (await response.json() as { folder: ConversationFolder }).folder;
  };
  const assign = async (id: string, folderId: string | null) => {
    const response = await request.patch(`${api}/conversations/${id}/folder`, { data: { actorIdentityId: ownerId, folderId } });
    expect(response.ok()).toBe(true);
  };
  const destination = `/app/workspaces/${workspace.id}/conversations/${conversation.id}`;
  return { workspace, ownerId, agentId, conversation, folder, assign, destination };
}

async function launch(page: Page, request: APIRequestContext, destination: string, actor = "owner") {
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}&actor=${actor}`)).json() as { launchUrl: string };
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Live updates live")).toBeVisible();
}

async function move(page: Page, name: string, folderId: string) {
  await page.getByRole("button", { name: `Conversation actions for ${name}`, exact: true }).click();
  await page.getByRole("button", { name: "Move", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Move #${name}`, exact: true });
  await dialog.getByRole("combobox", { name: "Folder", exact: true }).selectOption(folderId);
  return dialog;
}

const group = (page: Page, name: string) => page.getByRole("region", { name: `Folder ${name}`, exact: true });

test("folder create/rename/create-in-folder/move/unfile persist, retain failures and restore keyboard focus", async ({ page, request }, info) => {
  const f = await seed(request, "folder-flow-home");
  await launch(page, request, f.destination);
  const workspaceActions = page.getByRole("button", { name: `Workspace actions for ${f.workspace.name}`, exact: true });
  await workspaceActions.click();
  await page.getByRole("button", { name: "Create folder", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create folder", exact: true });
  await create.getByLabel("Folder name").fill("Folder flow");
  await create.getByRole("button", { name: "Create folder", exact: true }).click();
  await expect(create).toHaveCount(0);
  await expect(workspaceActions).toBeFocused();
  await expect(group(page, "Folder flow")).toBeVisible();
  const renameTrigger = page.getByRole("button", { name: "Folder actions for Folder flow", exact: true });
  await renameTrigger.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "Rename folder", exact: true });
  await rename.getByLabel("Folder name").fill("Folder delivery");
  await rename.getByRole("button", { name: "Save folder", exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Folder actions for Folder delivery", exact: true })).toBeFocused();

  await workspaceActions.click();
  await page.getByRole("button", { name: `Create Conversation in ${f.workspace.name}`, exact: true }).click();
  const conversation = page.getByRole("main", { name: "Create a Conversation", exact: true });
  await conversation.getByLabel("Conversation name").fill("folder-flow-created");
  await conversation.getByRole("combobox", { name: "Folder", exact: true }).selectOption({ label: "Folder delivery" });
  await conversation.getByRole("button", { name: "Create Conversation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "#folder-flow-created", exact: true })).toBeVisible();
  await expect(group(page, "Folder delivery").getByRole("link", { name: "folder-flow-created", exact: true })).toBeVisible();
  const url = page.url();
  const id = new URL(url).pathname.split("/").at(-1)!;
  const actions = page.getByRole("button", { name: "Conversation actions for folder-flow-created", exact: true });
  const failed = await move(page, "folder-flow-created", "");
  const pattern = `**/conversations/${id}/folder`;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(pattern, async route => { await gate; await route.fulfill({ status: 503, json: { error: "Fixture move rejected" } }); });
  await failed.getByRole("button", { name: "Move Conversation", exact: true }).click();
  try {
    await expect(failed.getByRole("button", { name: "Move Conversation", exact: true })).toBeDisabled();
    await expect(failed.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(failed.getByRole("alert")).toContainText("Fixture move rejected");
  expect((await (await request.get(`${api}/conversations/${id}`)).json()).conversation.folderId).not.toBeNull();
  expect(page.url()).toBe(url);
  await failed.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(actions).toBeFocused();
  await page.unroute(pattern);

  const unfile = await move(page, "folder-flow-created", "");
  await unfile.getByRole("button", { name: "Move Conversation", exact: true }).click();
  await expect(unfile).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Unfiled Conversations", exact: true }).getByRole("link", { name: "folder-flow-created", exact: true })).toBeVisible();
  await expect(actions).toBeFocused();
  expect(page.url()).toBe(url);
  const toggle = page.getByRole("button", { name: "Toggle folder Folder delivery", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const { folders } = await (await request.get(`${api}/workspaces/${f.workspace.id}/folders`)).json() as { folders: ConversationFolder[] };
  const target = folders.find(folder => folder.name === "Folder delivery")!;
  const filed = await move(page, "folder-flow-created", target.id);
  await filed.getByRole("button", { name: "Move Conversation", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(group(page, target.name).getByRole("link", { name: "folder-flow-created", exact: true })).toBeVisible();
  await expect(actions).toBeFocused();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const activeLink = group(page, target.name).getByRole("link", { name: "folder-flow-created", exact: true });
  await expect(activeLink).toBeVisible();
  await expect(activeLink).toHaveAttribute("aria-current", "page");
  await expect(activeLink).toHaveClass(/bg-\[var\(--selected\)\]/);
  await page.mouse.move(0, 0);
  await expect(toggle.locator("..")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const menuIcons = [workspaceActions, page.getByRole("button", { name: "Folder actions for Folder delivery", exact: true }), actions]
    .map(button => button.locator("svg"));
  const iconBoxes = await Promise.all(menuIcons.map(icon => icon.boundingBox()));
  expect(iconBoxes.every(box => box !== null)).toBe(true);
  const centers = iconBoxes.map(box => box!.x + box!.width / 2);
  expect(Math.max(...centers) - Math.min(...centers), "Workspace, folder and conversation menu icons share one column").toBeLessThanOrEqual(1);
  expect(page.url()).toBe(url);
  await page.screenshot({ path: info.outputPath("folders-desktop.png") });
});

test("active/background moves discover unknown folders, preserve unread activity and refresh another tab on focus", async ({ page, context, request }) => {
  const f = await seed(request, "folder-sync-active");
  const response = await request.post(`${api}/conversations`, { data: { workspaceId: f.workspace.id, actorIdentityId: f.ownerId, participantIds: [f.ownerId, f.agentId], name: "folder-sync-background" } });
  const { conversation: background } = await response.json() as { conversation: ConversationMetadata };
  await launch(page, request, f.destination);
  await expect.poll(async () => {
    const metrics = await (await request.get(`${fixture}/stream-metrics`)).json() as { topics: string[][] };
    return metrics.topics.some(ids => ids.includes(background.id));
  }).toBe(true);
  for (const [body, to] of [["Folder unread mention", [f.ownerId]], ["Folder unread message", []]] as const) {
    expect((await request.post(`${api}/conversations/${background.id}/messages`, { data: { participantId: f.agentId, body, to } })).ok()).toBe(true);
  }
  const backgroundLink = page.locator(`nav a[href$="/conversations/${background.id}"]`);
  await expect(backgroundLink.getByLabel(/2 unread messages/)).toBeVisible();
  const titleBefore = await page.title();
  const unknown = await f.folder("Sync unknown background");
  const openedBeforeMove = (await (await request.get(`${fixture}/stream-metrics`)).json()).opened as number;
  await f.assign(background.id, unknown.id);
  await expect(group(page, unknown.name).locator(`a[href$="/conversations/${background.id}"]`)).toBeVisible();
  expect((await (await request.get(`${fixture}/stream-metrics`)).json()).opened).toBe(openedBeforeMove);
  const backgroundToggle = page.getByRole("button", { name: `Toggle folder ${unknown.name}`, exact: true });
  await backgroundToggle.click();
  await expect(backgroundToggle.getByLabel(/2 unread messages, 1 direct mention/)).toBeVisible();
  expect(await page.title()).toBe(titleBefore);
  const activeFolder = await f.folder("Sync unknown active");
  await page.evaluate(({ ownerId, workspaceId, folderId }) => localStorage.setItem(`minu-channels:folder-collapsed:${ownerId}:${workspaceId}:${folderId}`, "true"), { ownerId: f.ownerId, workspaceId: f.workspace.id, folderId: activeFolder.id });
  await f.assign(f.conversation.id, activeFolder.id);
  await expect(group(page, activeFolder.name).locator(`a[href$="/conversations/${f.conversation.id}"]`)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(f.destination);
  const peer = await context.newPage();
  try {
    await peer.goto(f.destination, { waitUntil: "domcontentloaded" });
    await peer.getByRole("button", { name: `Folder actions for ${activeFolder.name}`, exact: true }).click();
    await peer.getByRole("button", { name: "Rename", exact: true }).click();
    const dialog = peer.getByRole("dialog", { name: "Rename folder", exact: true });
    await dialog.getByLabel("Folder name").fill("Sync renamed on peer");
    await dialog.getByRole("button", { name: "Save folder", exact: true }).click();
    await expect(group(peer, "Sync renamed on peer")).toBeVisible();
    await page.bringToFront();
    // Headless bringToFront does not emit an OS focus/visibility event. Exercise
    // that browser boundary explicitly, then observe the real refetch/render.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(group(page, "Sync renamed on peer")).toBeVisible();
    await expect(backgroundToggle.getByLabel(/2 unread messages, 1 direct mention/)).toBeVisible();
    expect(await page.title()).toBe(titleBefore);
  } finally { await peer.close(); }
});

test("delayed background metadata cannot revert a newer assignment or notification metadata", async ({ page, request }) => {
  const f = await seed(request, "folder-ordering-active");
  const response = await request.post(`${api}/conversations`, { data: {
    workspaceId: f.workspace.id, actorIdentityId: f.ownerId, participantIds: [f.ownerId, f.agentId], name: "folder-ordering-background",
  } });
  expect(response.ok()).toBe(true);
  const { conversation: background } = await response.json() as { conversation: ConversationMetadata };
  const first = await f.folder("Ordering first"), final = await f.folder("Ordering final");
  await launch(page, request, f.destination);
  await expect.poll(async () => (await (await request.get(`${fixture}/stream-metrics`)).json()).topics
    .some((ids: string[]) => ids.includes(background.id))).toBe(true);
  const notificationFolders: Array<string | null> = [];
  const notificationBody = "Notify from the latest folder";
  await page.exposeFunction("captureFolderNotification", (detail: { conversation: ConversationMetadata; message: { body: string } }) => {
    if (detail.conversation.id === background.id && detail.message.body === notificationBody) {
      notificationFolders.push(detail.conversation.folderId ?? null);
    }
  });
  await page.evaluate(() => {
    window.addEventListener("minu-live-message", event => {
      void (window as unknown as { captureFolderNotification(detail: unknown): Promise<void> })
        .captureFolderNotification((event as CustomEvent).detail);
    });
  });

  let releaseOld!: () => void;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  let held = false;
  const metadataPath = `/conversations/${background.id}`;
  await page.route(url => url.pathname === metadataPath, async route => {
    // Node-side route.fetch cannot resolve Chromium's *.localhost hostname.
    const gateway = new URL(route.request().url());
    gateway.hostname = "127.0.0.1";
    const response = await route.fetch({ url: gateway.href });
    const payload = await response.json() as { conversation: ConversationMetadata };
    if (!held && payload.conversation.folderId === first.id) {
      held = true;
      await oldGate;
    }
    await route.fulfill({ response, json: payload });
  });
  const link = `a[href$="/conversations/${background.id}"]`;
  const openedBefore = (await (await request.get(`${fixture}/stream-metrics`)).json()).opened;
  try {
    await f.assign(background.id, first.id);
    await expect.poll(() => held).toBe(true);
    await f.assign(background.id, final.id);
    await expect(group(page, final.name).locator(link)).toBeVisible();

    const olderResponse = page.waitForResponse(response => new URL(response.url()).pathname === metadataPath);
    releaseOld();
    await (await olderResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect((await (await request.get(`${api}${metadataPath}`)).json()).conversation.folderId).toBe(final.id);
    await expect(group(page, final.name).locator(link)).toBeVisible();
    await expect(group(page, first.name).locator(link)).toHaveCount(0);
    await expect.poll(() => page.evaluate(({ ownerId, id }) => {
      const remembered = JSON.parse(localStorage.getItem(`minu-channels:known-conversations:${ownerId}`) ?? "[]") as ConversationMetadata[];
      return remembered.find(conversation => conversation.id === id)?.folderId;
    }, { ownerId: f.ownerId, id: background.id })).toBe(final.id);

    expect((await request.post(`${api}${metadataPath}/messages`, { data: {
      participantId: f.agentId, body: notificationBody, to: [f.ownerId],
    } })).ok()).toBe(true);
    await expect.poll(() => notificationFolders).toEqual([final.id]);
    await expect(group(page, final.name).locator(link).getByLabel(/1 unread message/)).toBeVisible();
    expect((await (await request.get(`${fixture}/stream-metrics`)).json()).opened).toBe(openedBefore);
  } finally {
    releaseOld();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("compact folder row menus preselect filing and focus Workspace rename on mobile", async ({ page, request }) => {
  const f = await seed(request, "folder-menu-home");
  const folder = await f.folder("Tree menu folder");
  await page.setViewportSize({ width: 390, height: 844 });
  await launch(page, request, f.destination);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByLabel("Selected Workspace", { exact: true })).toHaveValue(f.workspace.id);
  await expect(page.getByRole("button", { name: `Create Conversation in ${f.workspace.name}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Rename folder / })).toHaveCount(0);
  const actions = page.getByRole("button", { name: `Folder actions for ${folder.name}`, exact: true });
  await expect(actions.locator("svg")).toHaveClass(/lucide-ellipsis-vertical/);
  await actions.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  await actions.press("Enter");
  await expect(page.getByRole("button", { name: `Toggle folder ${folder.name}`, exact: true })).toHaveCSS("font-size", "14px");
  await expect(page.getByRole("button", { name: "Create Conversation", exact: true })).toHaveCSS("font-size", "14px");
  await expect(page.getByRole("button", { name: "Rename", exact: true })).toHaveCSS("font-size", "14px");
  await page.getByRole("button", { name: "Create Conversation", exact: true }).click();
  const create = page.getByRole("main", { name: "Create a Conversation", exact: true });
  await expect(create.getByRole("combobox", { name: "Folder", exact: true })).toHaveValue(folder.id);
  await create.getByRole("link", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "#folder-menu-home", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await actions.click();
  await page.getByRole("button", { name: "Create Conversation", exact: true }).click();
  await create.getByLabel("Conversation name").fill("folder-menu-created");
  await create.getByRole("button", { name: "Create Conversation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "#folder-menu-created", exact: true })).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  expect((await (await request.get(`${api}/conversations/${id}`)).json()).conversation.folderId).toBe(folder.id);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const child = group(page, folder.name).getByRole("link", { name: "folder-menu-created", exact: true });
  await expect(child).toBeVisible();
  const toggle = page.getByRole("button", { name: `Toggle folder ${folder.name}`, exact: true });
  expect((await child.boundingBox())!.x).toBeGreaterThan((await toggle.boundingBox())!.x);
  const unfiled = page.getByRole("button", { name: "Folder actions for Unfiled", exact: true });
  await unfiled.click();
  await expect(page.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Create Conversation", exact: true }).click();
  await expect(create.getByRole("combobox", { name: "Folder", exact: true })).toHaveValue("");
  await create.getByRole("link", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "#folder-menu-created", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const workspaceActions = page.getByRole("button", { name: `Workspace actions for ${f.workspace.name}`, exact: true });
  await workspaceActions.click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  const settings = page.getByRole("main", { name: "Workspace settings", exact: true });
  await expect(settings.getByLabel("Name", { exact: true })).toBeFocused();
  await expect(settings.getByLabel("Name", { exact: true })).toHaveValue(f.workspace.name);
});

test("the mobile drawer shares folder moves, collapse preferences and focus recovery with desktop", async ({ page, request }, info) => {
  const f = await seed(request, "folder-mobile");
  const folder = await f.folder("Mobile folder");
  await page.setViewportSize({ width: 390, height: 844 });
  await launch(page, request, f.destination);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const dialog = await move(page, f.conversation.name, folder.id);
  await dialog.getByRole("button", { name: "Move Conversation", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(group(page, folder.name).locator(`a[href$="/conversations/${f.conversation.id}"]`)).toBeVisible();
  await expect(page.getByRole("button", { name: `Conversation actions for ${f.conversation.name}`, exact: true })).toBeFocused();
  await page.getByRole("button", { name: `Toggle folder ${folder.name}`, exact: true }).click();
  await expect(page.getByRole("button", { name: `Toggle folder ${folder.name}`, exact: true })).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ path: info.outputPath("folders-mobile.png") });
  await page.getByRole("button", { name: "Close navigation", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("button", { name: `Toggle folder ${folder.name}`, exact: true })).toHaveAttribute("aria-expanded", "false");
  expect(new URL(page.url()).pathname).toBe(f.destination);
});

test("filed lifecycle transitions and thread navigation retain their parent folder", async ({ page, request }) => {
  const f = await seed(request, "folder-lifecycle");
  const folder = await f.folder("Lifecycle folder");
  await f.assign(f.conversation.id, folder.id);
  const { message } = await (await request.post(`${api}/conversations/${f.conversation.id}/messages`, { data: { participantId: f.ownerId, body: "Filed thread root" } })).json();
  const { thread } = await (await request.post(`${api}/conversations/${f.conversation.id}/threads`, { data: { actorIdentityId: f.ownerId, rootMessageId: message.id } })).json();
  await request.post(`${api}/conversations/${thread.id}/messages`, { data: { participantId: f.ownerId, body: "Filed thread reply" } });
  await launch(page, request, f.destination);
  const actions = page.getByRole("button", { name: `Conversation actions for ${f.conversation.name}`, exact: true });
  await actions.click();
  await page.getByRole("button", { name: /^Snooze/ }).click();
  await page.getByRole("button", { name: "In 1 hour", exact: true }).click();
  await expect(group(page, folder.name).locator(`a[href$="/conversations/${f.conversation.id}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Snoozed", exact: true }).click();
  await actions.click();
  await page.getByRole("button", { name: "Reopen Conversation", exact: true }).click();
  await expect(group(page, folder.name).locator(`a[href$="/conversations/${f.conversation.id}"]`)).toBeVisible();
  await page.getByRole("button", { name: "Open thread for message 1: 1 replies", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Thread", exact: true });
  await expect(panel.getByText("Filed thread reply", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Close thread", exact: true }).click();
  await actions.click();
  await page.getByRole("button", { name: "Settled", exact: true }).click();
  await expect(group(page, folder.name).locator(`a[href$="/conversations/${f.conversation.id}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Settled", exact: true }).click();
  await actions.click();
  await expect(page.getByRole("button", { name: "Move", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Reopen Conversation", exact: true }).click();
  await expect(group(page, folder.name).locator(`a[href$="/conversations/${f.conversation.id}"]`)).toBeVisible();
});

test("representative related work remains findable after leaving and returning to its Workspace", async ({ page, request }, info) => {
  const f = await seed(request, "folder-validation-other-workspace");
  const createdWorkspace = await request.post(`${api}/workspaces`, { data: { slug: "folder-validation", name: "Folder intended use" } });
  expect(createdWorkspace.ok()).toBe(true);
  const { workspace } = await createdWorkspace.json() as { workspace: { id: string } };
  for (const [identityId, mentionHandle, accessRole] of [[f.ownerId, "owner", "owner"], [f.agentId, "agent", "member"]]) {
    const response = await request.post(`${api}/workspaces/${workspace.id}/members`, { data: { identityId, mentionHandle, accessRole } });
    expect(response.ok()).toBe(true);
  }
  const folders: ConversationFolder[] = [];
  for (const name of ["Delivery work", "Reference work"]) {
    const response = await request.post(`${api}/workspaces/${workspace.id}/folders`, { data: { actorIdentityId: f.ownerId, name } });
    expect(response.ok()).toBe(true);
    folders.push((await response.json()).folder);
  }
  const [delivery, reference] = folders;
  const conversations: ConversationMetadata[] = [];
  for (const [name, folderId] of [
    ["release-api", delivery.id], ["release-ui", delivery.id], ["general-work", null],
    ["gardening", null], ["release-later", delivery.id], ["past-research", reference.id],
  ]) {
    const response = await request.post(`${api}/conversations`, { data: {
      workspaceId: workspace.id, actorIdentityId: f.ownerId, participantIds: [f.ownerId, f.agentId], name, ...(folderId ? { folderId } : {}),
    } });
    expect(response.ok()).toBe(true);
    conversations.push((await response.json()).conversation);
  }
  const [apiWork, uiWork, , , deferred, archived] = conversations;
  for (const [id, state] of [[deferred.id, "snoozed"], [archived.id, "settled"]]) {
    const response = await request.patch(`${api}/conversations/${id}/lifecycle`, { data: {
      actorIdentityId: f.ownerId, state, ...(state === "snoozed" ? { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() } : {}),
    } });
    expect(response.ok()).toBe(true);
  }
  const { message } = await (await request.post(`${api}/conversations/${apiWork.id}/messages`, { data: { participantId: f.ownerId, body: "Release API decision" } })).json();
  const { thread } = await (await request.post(`${api}/conversations/${apiWork.id}/threads`, { data: { actorIdentityId: f.ownerId, rootMessageId: message.id } })).json();
  await request.post(`${api}/conversations/${thread.id}/messages`, { data: { participantId: f.ownerId, body: "API follow-up stays with this work" } });
  const destination = `/app/workspaces/${workspace.id}/conversations/${apiWork.id}`;
  await launch(page, request, destination);
  const related = group(page, delivery.name);
  await expect(related.getByRole("link")).toHaveCount(2);
  await expect(related.getByRole("link", { name: "release-api", exact: true })).toBeVisible();
  await expect(related.getByRole("link", { name: "release-ui", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Unfiled Conversations", exact: true }).getByRole("link")).toHaveCount(2);
  await expect(group(page, reference.name)).toBeVisible(); // Its only item is currently archived.
  await expect(group(page, reference.name).getByRole("link")).toHaveCount(0);

  await page.getByLabel("Selected Workspace", { exact: true }).selectOption(f.workspace.id);
  await expect(page.getByRole("heading", { name: f.workspace.name, exact: true })).toBeVisible();
  await page.getByLabel("Selected Workspace", { exact: true }).selectOption(workspace.id);
  await related.getByRole("link", { name: "release-api", exact: true }).click();
  await expect(page.getByRole("heading", { name: "#release-api", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open thread for message 1: 1 replies", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Thread", exact: true });
  await expect(panel.getByText("API follow-up stays with this work", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Close thread", exact: true }).click();
  const unfile = await move(page, "release-ui", "");
  await unfile.getByRole("button", { name: "Move Conversation", exact: true }).click();
  await expect(page.getByRole("region", { name: "Unfiled Conversations", exact: true }).getByRole("link", { name: "release-ui", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Snoozed", exact: true }).click();
  await page.getByRole("button", { name: "Conversation actions for release-later", exact: true }).click();
  await page.getByRole("button", { name: "Reopen Conversation", exact: true }).click();
  await expect(related.getByRole("link", { name: "release-later", exact: true })).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(related.getByRole("link", { name: "release-api", exact: true })).toBeVisible();
  await expect(related.getByRole("link", { name: "release-later", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Unfiled Conversations", exact: true }).getByRole("link", { name: "release-ui", exact: true })).toBeVisible();
  expect((await (await request.get(`${api}/conversations/${uiWork.id}`)).json()).conversation.folderId).toBeNull();
  await page.screenshot({ path: info.outputPath("folders-intended-use.png") });
});

test("ordinary members can group navigation but cannot create, rename or move folders", async ({ page, request }) => {
  const f = await seed(request, "folder-member");
  const folder = await f.folder("Member visible folder");
  await f.assign(f.conversation.id, folder.id);
  await launch(page, request, f.destination, "member");
  await expect(group(page, folder.name)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Rename folder / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Folder actions for / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Quick create Conversation in ${f.workspace.name}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Conversation actions for / })).toHaveCount(0);
  await page.getByRole("button", { name: `Workspace actions for ${f.workspace.name}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Create folder", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Create Conversation in ${f.workspace.name}`, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: `Toggle folder ${folder.name}`, exact: true }).click();
  await expect(page.getByRole("button", { name: `Toggle folder ${folder.name}`, exact: true })).toHaveAttribute("aria-expanded", "false");
});
