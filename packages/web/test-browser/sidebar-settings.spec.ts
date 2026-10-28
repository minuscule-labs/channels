import type { ConversationMetadata } from "@minu/channels-core/types";
import { expect, test } from "@playwright/test";

const conversationsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

test("notification sound remains editable without Workspace configuration access", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as { workspaces: Array<{ id: string; name: string }> };
  const workspace = workspaces.find(({ name }) => name === "Browser Test")!;
  await page.route(`**/local/workspaces/${workspace.id}/config`, route => route.fulfill({ status: 403, json: { error: "Workspace owner or admin required" } }));
  const destination = `/app/workspaces/${workspace.id}/agents`;
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}&actor=member`)).json() as { launchUrl: string };
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Notification sound")).toHaveCount(0);
  await page.getByRole("button", { name: `Workspace actions for ${workspace.name}`, exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `${workspace.name} configuration`, exact: true });
  await expect(dialog.getByRole("heading", { name: "Configuration unavailable" })).toBeVisible();
  const notifications = dialog.getByRole("region", { name: "Notifications", exact: true });
  await expect(notifications.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
  await notifications.getByLabel("Notification sound").selectOption("all");
  await expect(notifications.getByLabel("Notification sound")).toHaveValue("all");
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("minu-channels:sound:")).map(([, value]) => value))).toEqual(["all"]);
});

for (const mobile of [false, true]) {
  test(`sidebar Settings opens the existing modal on ${mobile ? "mobile" : "desktop"}`, async ({ page, request }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
      workspaces: Array<{ id: string; name: string }>;
    };
    const workspace = workspaces.find(({ name }) => name === "Browser Test")!;
    const workspaceId = workspace.id;
    const { members } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/members`)).json() as {
      members: Array<{ identityId: string; mentionHandle: string }>;
    };
    const ownerId = members.find(({ mentionHandle }) => mentionHandle === "david")!.identityId;
    const agentId = members.find(({ mentionHandle }) => mentionHandle === "builder")!.identityId;
    const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as {
      conversations: ConversationMetadata[];
    };
    const primary = conversations.find(({ name }) => name === "browser-collaboration")!;
    const name = `sidebar-settings-${mobile ? "mobile" : "desktop"}`;
    const created = await request.post(`${conversationsBase}/conversations`, {
      data: { workspaceId, name, actorIdentityId: ownerId, participantIds: [ownerId, agentId] },
    });
    expect(created.ok()).toBe(true);
    const destination = `/app/workspaces/${workspaceId}/conversations/${primary.id}`;
    const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}`)).json() as { launchUrl: string };
    await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: `#${primary.name}`, exact: true })).toBeVisible();
    await expect(page.getByLabel("Notification sound")).toHaveCount(0);
    if (mobile) await page.getByRole("button", { name: "Open navigation" }).click();
    const workspaceActions = page.getByRole("button", { name: `Workspace actions for ${workspace.name}`, exact: true });
    await expect(workspaceActions.locator("svg")).toHaveClass(/lucide-ellipsis-vertical/);
    await workspaceActions.click();
    const workspaceMenu = page.getByRole("dialog").filter({ has: page.getByRole("link", { name: "Agents", exact: true }) });
    await expect(workspaceMenu.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await expect(workspaceMenu.getByRole("link", { name: "Agents", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(workspaceActions).toBeFocused();
    const url = page.url();
    await expect(page.getByRole("button", { name: "Manage Conversation participants", exact: true })).toHaveCount(0);
    const actions = page.getByRole("button", { name: `Conversation actions for ${name}`, exact: true });
    await actions.click();
    const popup = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Settings", exact: true }) });
    await expect(popup.getByRole("button").last()).toHaveText("Settings");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Manage #${name}`, exact: true });
    await expect(dialog.getByLabel("Conversation name")).toHaveValue(name);
    await expect(dialog.getByRole("checkbox", { name: /Builder Agent/ })).toBeChecked();
    await expect(dialog.getByRole("region", { name: "Working folders" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
    expect(page.url()).toBe(url);
    await dialog.getByLabel("Conversation name").fill("discard-this-draft");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(actions).toBeFocused();
    await actions.click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(dialog.getByLabel("Conversation name")).toHaveValue(name);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    await workspaceActions.click();
    await workspaceMenu.getByRole("button", { name: "Settings", exact: true }).click();
    const workspaceSettings = page.getByRole("dialog", { name: `${workspace.name} configuration`, exact: true });
    const notifications = workspaceSettings.getByRole("region", { name: "Notifications", exact: true });
    await expect(notifications.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
    const sound = notifications.getByLabel("Notification sound");
    await expect(sound).toHaveValue("off");
    await sound.selectOption("mentions");
    await expect(sound).toHaveValue("mentions");
    await sound.selectOption("all");
    await workspaceSettings.getByRole("button", { name: "Close Workspace configuration" }).click();
    await expect(page.getByLabel("Notification sound")).toHaveCount(0);
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), `minu-channels:sound:${ownerId}`)).toBe("all");

    await page.reload({ waitUntil: "domcontentloaded" });
    if (mobile) await page.getByRole("button", { name: "Open navigation" }).click();
    await workspaceActions.click();
    await workspaceMenu.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(sound).toHaveValue("all");
    await sound.selectOption("off");
    await workspaceSettings.getByRole("button", { name: "Close Workspace configuration" }).click();
    await expect(page.getByLabel("Notification sound")).toHaveCount(0);
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), `minu-channels:sound:${ownerId}`)).toBe("off");
    if (mobile) await page.getByRole("button", { name: "Close navigation" }).click();
    await expect(page.getByRole("button", { name: "Manage Conversation participants", exact: true })).toHaveCount(0);
  });
}
