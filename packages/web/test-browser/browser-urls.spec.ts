import { canonicalBrowserPath, conversationBrowserPath } from "@minu/channels-core/browser-urls";
import { expect, test } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

for (const version of ["v7", "v4", "v4-legacy-channel"] as const) {
  test(`${version}: compact URLs retain identity through bootstrap, navigation, refresh and history`, async ({ page, request }) => {
    const { workspaces } = await (await request.get(`${api}/workspaces`)).json();
    let workspace = workspaces.find(({ name }: { name: string }) => name === "Browser Test");
    let { conversations } = await (await request.get(`${api}/workspaces/${workspace.id}/conversations`)).json();
    let conversation = conversations.find(({ name }: { name: string }) => name === "browser-collaboration");
    const human = conversation.participants.find(({ type }: { type: string }) => type === "human");
    if (version !== "v7") {
      const response = await request.post(`${api}/workspaces`, { data: {
        id: version === "v4" ? "workspace_550e8400e29b41d4a716446655440002" : "workspace_550e8400e29b41d4a716446655440000", slug: `url-${version}`, name: `URL ${version} Workspace`,
      } });
      expect(response.ok()).toBe(true);
      workspace = (await response.json()).workspace;
      expect((await request.post(`${api}/workspaces/${workspace.id}/members`, { data: {
        identityId: human.id, mentionHandle: "url-owner", accessRole: "owner",
      } })).ok()).toBe(true);
      const created = await request.post(`${api}/conversations`, { data: {
        id: `${version === "v4" ? "conversation" : "channel"}_550e8400e29b41d4a716446655440001`, workspaceId: workspace.id,
        participantIds: [human.id], name: "url-v4-conversation",
      } });
      expect(created.ok()).toBe(true);
      conversation = (await created.json()).conversation;
      expect((await request.post(`${api}/conversations/${conversation.id}/messages`, { data: {
        participantId: human.id, body: "Legacy URL message anchor",
      } })).ok()).toBe(true);
    }
    const publicPath = conversationBrowserPath(workspace.id, conversation.id);
    const apiReads: string[] = [];
    page.on("request", incoming => {
      if (incoming.resourceType() !== "document" && incoming.method() === "GET") apiReads.push(new URL(incoming.url()).pathname);
    });
    const oldPath = `/app/workspaces/${workspace.id}/channels/${conversation.id}`;
    const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(`${oldPath}?retained=hello%20world#message-1`)}`)).json();
    await page.goto(launchUrl);
    await expect(page.getByRole("heading", { name: `#${conversation.name}`, exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(publicPath);
    expect(new URL(page.url()).searchParams.get("retained")).toBe("hello world");
    expect(new URL(page.url()).hash).toBe("#message-1");
    await expect(page.locator('[data-message-sequence="1"]')).toBeVisible();
    // Initial query and existing SSE reconciliation both read metadata. The adapter
    // itself is synchronous: every observed request must use the same exact ID.
    await expect(page.getByLabel("Live updates live")).toBeVisible();
    expect(apiReads).toContain(`/conversations/${conversation.id}`);
    expect(apiReads).toContain(`/workspaces/${workspace.id}/conversations`);
    expect(apiReads.some(path => /^\/(?:workspaces|conversations)\/[0-9a-f]{32}(?:\/|$)/.test(path))).toBe(false);
    expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith("minu-channels:last-"))))).toMatchObject({
      "minu-channels:last-workspace": workspace.id,
      [`minu-channels:last-conversation:${workspace.id}`]: conversation.id,
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: `#${conversation.name}`, exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(publicPath);
    await expect(page.locator(`nav a[href="${publicPath}"]`).first()).toBeVisible();

    await page.goto(`/app/workspaces/${workspace.id}/conversations/${conversation.id}/settings?retained=settings#message-1`);
    await expect(page.getByRole("main", { name: "Conversation settings" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`${publicPath}/settings`);
    expect(new URL(page.url()).search).toBe("?retained=settings");
    expect(new URL(page.url()).hash).toBe("#message-1");
    await page.getByRole("link", { name: "Back to Conversation", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${publicPath}$`));
    await page.goBack();
    await expect(page.getByRole("main", { name: "Conversation settings" })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("heading", { name: `#${conversation.name}`, exact: true })).toBeVisible();
    const settings = canonicalBrowserPath(`/app/workspaces/${workspace.id}/settings`);
    await page.goto(settings);
    const navigation = page.getByRole("navigation", { name: "Workspace settings", exact: true });
    await expect(navigation.getByRole("link", { name: "General", exact: true })).toHaveAttribute("aria-current", "page");
    await navigation.getByRole("link", { name: "Agents", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${canonicalBrowserPath(`/app/workspaces/${workspace.id}/agents`)}$`));
    await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${publicPath}$`));
    const secondary = workspaces.find(({ name }: { name: string }) => name === "Browser Secondary");
    await page.getByLabel("Selected Workspace", { exact: true }).selectOption(secondary.id);
    await expect(page.getByRole("heading", { name: "#secondary-collaboration", exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toMatch(/^\/workspaces\/[a-f0-9]{32}\/conversations\/[a-f0-9]{32}$/);
    await page.getByLabel("Selected Workspace", { exact: true }).selectOption(workspace.id);
    await expect(page).toHaveURL(new RegExp(`${publicPath}$`));
    // Same-origin API requests stay JSON and use full canonical IDs, not URL payloads.
    const result = await page.evaluate(async ({ workspaceId, conversationId }) => {
      const response = await fetch(`/conversations/${conversationId}`);
      const metadata = await response.json();
      const listing = await fetch(`/workspaces/${workspaceId}/conversations`);
      return { type: response.headers.get("content-type"), id: metadata.conversation.id, listingType: listing.headers.get("content-type") };
    }, { workspaceId: workspace.id, conversationId: conversation.id });
    expect(result).toEqual({ type: "application/json; charset=utf-8", id: conversation.id, listingType: "application/json; charset=utf-8" });
  });
}
