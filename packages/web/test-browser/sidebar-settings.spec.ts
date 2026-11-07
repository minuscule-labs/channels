import type { ConversationMetadata } from "@minu/channels-core/types";
import { expect, test } from "@playwright/test";

const conversationsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

test("notification sound remains editable without Workspace configuration access", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json();
  const workspace = workspaces.find(({ name }: { name: string }) => name === "Browser Test")!;
  const destination = `/app/workspaces/${workspace.id}/agents`;
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}&actor=member`)).json();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: `Workspace actions for ${workspace.name}`, exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("main", { name: "Workspace settings" });
  await expect(settings.getByText(/An active Workspace owner or admin is required/)).toBeVisible();
  const notifications = settings.getByRole("region", { name: "Notifications", exact: true });
  await notifications.getByLabel("Notification sound").selectOption("all");
  await expect(notifications.getByLabel("Notification sound")).toHaveValue("all");
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("minu-channels:sound:")).map(([, value]) => value))).toEqual(["all"]);
});

for (const mobile of [false, true]) {
  test(`unchanged sidebar Settings actions open content pages on ${mobile ? "mobile" : "desktop"}`, async ({ page, request }) => {
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
    await actions.click(); await page.getByRole("button", { name: "Settings", exact: true }).click();
    const workspaceSettings = page.getByRole("main", { name: "Workspace settings" });
    const sound = workspaceSettings.getByLabel("Notification sound");
    await sound.selectOption("all");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(sound).toHaveValue("all");
    await workspaceSettings.getByRole("navigation", { name: "Workspace settings" }).getByRole("link", { name: "Defaults & timeouts", exact: true }).click();
    await expect(workspaceSettings.getByLabel("Turn timeout", { exact: true })).toBeVisible();
    if (mobile) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("link", { name: primary.name, exact: true }).first().click();
    if (mobile) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: `Conversation actions for ${primary.name}`, exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settings.getByLabel("Conversation name", { exact: true })).toHaveValue(primary.name);
  });
}

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
  const settings = page.getByRole("main", { name: "Workspace settings" });
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
