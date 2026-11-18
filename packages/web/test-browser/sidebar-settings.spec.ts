import type { ConversationMetadata } from "@minu/channels-core/types";
import { expect, test } from "@playwright/test";

const conversationsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

test("notification sound remains editable without Workspace configuration access", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json();
  const workspace = workspaces.find(({ name }: { name: string }) => name === "Browser Test")!;
  const destination = `/app/workspaces/${workspace.id}/settings`;
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}&actor=member`)).json();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  const settings = page.getByRole("main", { name: "Workspace Settings" });
  await expect(settings.getByText(/An active Workspace owner or admin is required/)).toBeVisible();
  const notifications = settings.getByRole("region", { name: "Notifications", exact: true });
  await notifications.getByLabel("Notification sound").selectOption("all");
  await expect(notifications.getByLabel("Notification sound")).toHaveValue("all");
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("minu-channels:sound:")).map(([, value]) => value))).toEqual(["all"]);
});

for (const mobile of [false, true]) {
  test(`sidebar Settings actions switch to workspace navigation and back on ${mobile ? "mobile" : "desktop"}`, async ({ page, request }, info) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json();
    const workspace = workspaces.find(({ name }: { name: string }) => name === "Browser Test")!;
    const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspace.id}/conversations`)).json() as { conversations: ConversationMetadata[] };
    const primary = conversations.find(({ name }) => name === "browser-collaboration")!;
    const destination = `/app/workspaces/${workspace.id}/conversations/${primary.id}`;
    const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}`)).json();
    await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
    if (!mobile) {
      await page.getByRole("button", { name: `Quick create Conversation in ${workspace.name}` }).click();
      const creation = page.getByRole("main", { name: "Create a Conversation" });
      await creation.getByLabel("Conversation name", { exact: true }).fill("discard-creation-draft");
      await creation.getByRole("link", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("heading", { name: `#${primary.name}`, exact: true })).toBeVisible();
    }
    if (mobile) await page.getByRole("button", { name: "Open navigation" }).click();
    const actions = page.getByRole("button", { name: `Workspace actions for ${workspace.name}`, exact: true });
    await expect(actions.locator("svg")).toHaveClass(/lucide-ellipsis-vertical/);
    const quickCreate = page.getByRole("button", { name: `Quick create Conversation in ${workspace.name}`, exact: true });
    const folderActions = page.getByRole("button", { name: "Folder actions for Unfiled", exact: true });
    const conversationActions = page.getByRole("button", { name: `Conversation actions for ${primary.name}`, exact: true });
    await page.mouse.move(0, 0);
    for (const action of [actions, quickCreate, folderActions, conversationActions, page.getByRole("button", { name: "Add Workspace", exact: true })]) {
      await expect(action).toHaveCSS("width", "36px");
      await expect(action).toHaveCSS("height", "36px");
      await expect(action).toHaveCSS("border-top-width", "0px");
      await expect(action).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    const workspaceBox = (await actions.boundingBox())!;
    for (const action of [folderActions, conversationActions]) {
      const box = (await action.boundingBox())!;
      expect(box.x + box.width).toBeCloseTo(workspaceBox.x + workspaceBox.width, 0);
    }
    const headingBox = (await page.getByRole("heading", { name: workspace.name, exact: true }).boundingBox())!;
    expect(headingBox.y + headingBox.height / 2).toBeCloseTo(workspaceBox.y + workspaceBox.height / 2, 0);
    const quickBox = (await quickCreate.boundingBox())!;
    expect(workspaceBox.x - quickBox.x - quickBox.width).toBeCloseTo(4, 0);
    await expect(page.getByLabel("Selected Workspace").locator("..").locator("svg")).toHaveCount(0);
    await actions.click();
    const workspaceMenu = page.getByRole("dialog").filter({ has: page.getByRole("link", { name: "Agents", exact: true }) });
    await expect(workspaceMenu.getByRole("link", { name: "Agents", exact: true })).toHaveCSS("font-size", "14px");
    for (const action of await workspaceMenu.getByRole("button").all()) await expect(action).toHaveCSS("font-size", "14px");
    await page.keyboard.press("Escape"); await expect(actions).toBeFocused();
    await page.getByRole("button", { name: `Conversation actions for ${primary.name}`, exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("main", { name: "Conversation settings" });
    await expect(settings.getByLabel("Conversation name", { exact: true })).toHaveValue(primary.name);
    await expect(settings.getByRole("region", { name: "Working folders" })).toBeVisible();
    await settings.getByLabel("Conversation name", { exact: true }).fill("discard-this-draft");
    await settings.getByRole("link", { name: "Back to Conversation", exact: true }).click();
    if (mobile) await page.getByRole("button", { name: "Open navigation" }).click();
    const presetReads: string[] = [];
    page.on("request", request => { if (request.method() === "GET" && request.url().includes("/conversation-presets")) presetReads.push(request.url()); });
    await actions.click(); await page.getByRole("button", { name: "Settings", exact: true }).click();
    const workspaceSettings = page.getByRole("main", { name: "Workspace Settings" });
    const sound = workspaceSettings.getByLabel("Notification sound");
    await sound.selectOption("all");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(sound).toHaveValue("all");
    await expect(workspaceSettings.getByRole("heading", { name: "Workspace Settings", exact: true })).toBeVisible();
    await expect(workspaceSettings.locator(":scope > div > header > div > p")).toHaveText("General");
    await expect(workspaceSettings.getByRole("navigation")).toHaveCount(0);
    if (mobile) await page.getByRole("button", { name: "Open navigation" }).click();
    const navigation = page.getByRole("navigation", { name: "Workspace settings", exact: true });
    await expect(navigation.getByRole("link")).toHaveText(["General", "Agents", "Conversation presets", "Defaults & timeouts", "Instructions", "Skills"]);
    expect(presetReads).toEqual([]);
    const settingsSidebar = navigation.locator("..");
    await expect(settingsSidebar.getByRole("heading")).toHaveCount(0);
    await expect(settingsSidebar.getByText(workspace.name, { exact: true })).toHaveCount(0);
    await expect(settingsSidebar.getByRole("button", { name: "Back to workspace", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Workspaces and Conversations", exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`workspace-settings-${mobile ? "mobile" : "desktop"}.png`) });
    if (mobile) {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("button", { name: "Close navigation", exact: true }).click();
      await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
      await page.getByRole("button", { name: "Open navigation" }).click();
    }
    await navigation.getByRole("link", { name: "Defaults & timeouts", exact: true }).click();
    await expect(workspaceSettings.getByLabel("Turn timeout", { exact: true })).toBeVisible();
    if (mobile) {
      await expect(page.getByRole("dialog", { name: "Navigation", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
      const menuBounds = (await page.getByRole("button", { name: "Open navigation" }).boundingBox())!;
      const titleBounds = (await workspaceSettings.getByRole("heading", { name: "Workspace Settings", exact: true }).boundingBox())!;
      expect(titleBounds.y).toBeGreaterThanOrEqual(menuBounds.y + menuBounds.height);
      await page.screenshot({ path: info.outputPath("workspace-settings-mobile-content.png") });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole("button", { name: "Open navigation" }).click();
    }
    await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${destination}$`));
    await expect(page.getByRole("heading", { name: `#${primary.name}`, exact: true })).toBeVisible();
    if (mobile) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: `Conversation actions for ${primary.name}`, exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settings.getByLabel("Conversation name", { exact: true })).toHaveValue(primary.name);
  });
}

test("workspace navigation supports all sections, deep links and browser history", async ({ page, request }, info) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json();
  const workspace = workspaces.find(({ name }: { name: string }) => name === "Browser Test")!;
  const root = `/app/workspaces/${workspace.id}/settings`;
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(`${root}/skills`)}`)).json();
  await page.goto(launchUrl);
  const navigation = page.getByRole("navigation", { name: "Workspace settings", exact: true });
  await expect(navigation.getByRole("link", { name: "Skills", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("link", { name: "People & permissions", exact: true })).toHaveCount(0);
  for (const [label, target] of [["General", root], ["Agents", `/app/workspaces/${workspace.id}/agents`], ["Conversation presets", `${root}/presets`], ["Defaults & timeouts", `${root}/defaults`], ["Instructions", `${root}/instructions`], ["Skills", `${root}/skills`]]) {
    const link = navigation.getByRole("link", { name: label === "Conversation presets" ? /Conversation presets/ : label, exact: true });
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${target}$`));
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("main", { name: "Workspace Settings", exact: true }).locator(":scope > div > header > div > p")).toHaveText(label);
    await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(page.getByRole("main", { name: "Workspace Settings", exact: true }).getByRole("navigation")).toHaveCount(0);
  }
  await page.reload();
  await expect(navigation.getByRole("link", { name: "Skills", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(navigation.getByRole("link", { name: "Instructions", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(navigation.getByRole("link", { name: "Skills", exact: true })).toHaveAttribute("aria-current", "page");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("region", { name: "Authored skills", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace settings", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(navigation.getByRole("link", { name: "Skills", exact: true })).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: info.outputPath("workspace-settings-mobile-skills.png") });
});

test("Back to workspace uses valid conversation fallbacks and retains settings on a failed lookup", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json();
  const workspace = workspaces.find(({ name }: { name: string }) => name === "Browser Test")!;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspace.id}/conversations`)).json() as { conversations: ConversationMetadata[] };
  const destination = `/app/workspaces/${workspace.id}/settings`;
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}`)).json();
  await page.goto(launchUrl);
  await expect(page.getByRole("button", { name: "Back to workspace", exact: true })).toBeEnabled();
  await page.evaluate((workspaceId) => localStorage.setItem(`minu-channels:last-conversation:${workspaceId}`, "conversation_missing"), workspace.id);
  const lookup = `**/workspaces/${workspace.id}/conversations`;
  await page.route(lookup, route => route.fulfill({ status: 503, json: { error: "Conversation lookup unavailable" } }));
  await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Conversation lookup unavailable");
  await expect(page).toHaveURL(new RegExp(`${destination}$`));
  await page.unroute(lookup);
  await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversations[0]!.id}$`));
  await expect(page.getByRole("navigation", { name: "Workspace settings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Workspaces and Conversations", exact: true })).toBeVisible();

  const { members } = await (await request.get(`${conversationsBase}/workspaces/${workspace.id}/members`)).json();
  const owner = members.find(({ mentionHandle }: { mentionHandle: string }) => mentionHandle === "david")!;
  const response = await request.post(`${conversationsBase}/workspaces`, { data: { slug: "sidebar-empty", name: "Empty sidebar workspace" } });
  expect(response.ok()).toBe(true);
  const { workspace: empty } = await response.json();
  expect((await request.post(`${conversationsBase}/workspaces/${empty.id}/members`, { data: { identityId: owner.identityId, mentionHandle: "owner", accessRole: "owner" } })).ok()).toBe(true);
  await page.goto(`/app/workspaces/${empty.id}/settings`);
  await expect(page.getByRole("navigation", { name: "Workspace settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Choose a Conversation", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspaces and Conversations", exact: true })).toBeVisible();
});

test("Workspace access-role controls are limited to owners editing humans", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json();
  const workspace = workspaces.find(({ name }: { name: string }) => name === "Browser Test")!;
  const { members } = await (await request.get(`${conversationsBase}/workspaces/${workspace.id}/members`)).json();
  const owner = members.find(({ mentionHandle }: { mentionHandle: string }) => mentionHandle === "david")!;
  const member = members.find(({ mentionHandle }: { mentionHandle: string }) => mentionHandle === "member")!;
  const destination = `/app/workspaces/${workspace.id}/settings/people`;
  const launch = async (actor: "owner" | "member") => {
    const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}&actor=${actor}`)).json();
    await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  };
  await launch("owner");
  const settings = page.getByRole("main", { name: "Workspace Settings" });
  await expect(settings.getByLabel("Access role for Builder Agent", { exact: true })).toHaveCount(0);
  const accessRole = settings.getByLabel("Access role for Workspace Member", { exact: true });
  await accessRole.selectOption("admin");
  try {
    const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/workspaces/${workspace.id}/members/${member.identityId}`));
    await settings.locator("form").filter({ has: page.getByLabel("Access role for Workspace Member", { exact: true }) }).getByRole("button", { name: "Save role", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await launch("member");
    await expect(settings.getByRole("heading", { name: "People & permissions", exact: true })).toBeVisible();
    await expect(settings.getByRole("combobox", { name: /^Access role for/ })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "Save role", exact: true })).toHaveCount(0);
  } finally {
    expect((await request.patch(`${conversationsBase}/workspaces/${workspace.id}/members/${member.identityId}`, { data: { actorIdentityId: owner.identityId, accessRole: "member" } })).ok()).toBe(true);
  }
});
