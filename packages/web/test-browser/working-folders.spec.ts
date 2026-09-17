import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const channelsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

async function launchAuthenticated(page: Page, request: APIRequestContext, destination: string) {
  const response = await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}`);
  const { launchUrl } = await response.json() as { launchUrl: string };
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
}

test("working folders recover from an initial load failure and save previewed, de-duplicated selections", async ({ page, request }) => {
  const workspaces = (await (await request.get(`${channelsBase}/workspaces`)).json() as { workspaces: Array<{ id: string }> }).workspaces;
  const workspaceId = workspaces[0]!.id;
  const channelId = ((await (await request.get(`${channelsBase}/workspaces/${workspaceId}/conversations`)).json() as { channels: Array<{ id: string }> }).channels[0]!).id;
  let folderLoads = 0;
  const puts: unknown[] = [];
  let pickerCalls = 0;
  await page.route(`**/local/conversations/${channelId}/working-folders`, async (route) => {
    if (route.request().method() === "GET") {
      folderLoads += 1;
      if (folderLoads === 1) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ protocolVersion: 17, workspaceId, channelId, inheritedFromWorkspace: true, folders: [], changesApplyToNewSessions: true, enforcement: "advisory" }) });
    }
    puts.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ protocolVersion: 17, workspaceId, channelId, inheritedFromWorkspace: false, folders: [{ relativePath: "apps/web", position: 0, primary: true }], changesApplyToNewSessions: true, enforcement: "advisory" }) });
  });
  await page.route(`**/local/conversations/${channelId}/working-folders/preview`, (route) => {
    const { path } = route.request().postDataJSON() as { path: string };
    const relativePath = path.endsWith("/2") ? "packages/shared" : "apps/web";
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ relativePath }) });
  });
  await page.route("**/local/folders/select", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ path: `/private/root/${++pickerCalls}` }) }));
  await launchAuthenticated(page, request, `/app/workspaces/${workspaceId}/conversations/${channelId}`);
  await page.getByRole("button", { name: "Manage Conversation participants" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Could not load working folders.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByText("Inherited from Workspace", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Add folder" }).click();
  await expect(dialog.getByText("apps/web", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Add folder" }).click();
  await expect(dialog.getByText("packages/shared", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Add folder" }).click();
  await expect(dialog.getByText("apps/web", { exact: true })).toHaveCount(1);
  const shared = dialog.getByText("packages/shared", { exact: true }).locator("..");
  await shared.getByRole("button", { name: "Make primary" }).click();
  await shared.getByRole("button", { name: "Up" }).click();
  await expect(dialog.locator('section[aria-label="Working folders"] .font-mono')).toHaveText([
    "packages/shared",
    "apps/web",
  ]);
  const web = dialog.getByText("apps/web", { exact: true }).locator("..");
  await web.getByRole("button", { name: "Remove" }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ folders: [{ path: "/private/root/2", primary: true }] });
});
