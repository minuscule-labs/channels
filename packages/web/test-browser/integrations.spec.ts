import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;
const headers = { authorization: "Bearer browser-fixture-service-token" };

// Credential administration deliberately rejects any Authorization header, so the page must not inherit
// the fixture's service token; fixture API calls pass it explicitly instead.
test.use({ extraHTTPHeaders: {} });

/** An isolated Workspace with one parent Conversation and one thread, so other specs' data is untouched. */
async function integrationsWorkspace(request: APIRequestContext, slug: string) {
  const { workspaces } = await (await request.get(`${api}/workspaces`, { headers })).json();
  const browser = workspaces.find(({ name }: { name: string }) => name === "Browser Test")!;
  const { members } = await (await request.get(`${api}/workspaces/${browser.id}/members`, { headers })).json();
  const owner = members.find(({ mentionHandle }: { mentionHandle: string }) => mentionHandle === "david")!;
  const { workspace } = await (await request.post(`${api}/workspaces`, { headers, data: { slug, name: `Keys ${slug}` } })).json();
  expect((await request.post(`${api}/workspaces/${workspace.id}/members`, { headers, data: { identityId: owner.identityId, mentionHandle: "david", accessRole: "owner" } })).ok()).toBe(true);
  const { conversation } = await (await request.post(`${api}/conversations`, { headers, data: { workspaceId: workspace.id, name: "keys-parent", participantIds: [owner.identityId] } })).json();
  const { message } = await (await request.post(`${api}/conversations/${conversation.id}/messages`, { headers, data: { participantId: owner.identityId, body: "Thread root", to: [] } })).json();
  const { thread } = await (await request.post(`${api}/conversations/${conversation.id}/threads`, { headers, data: { actorIdentityId: owner.identityId, rootMessageId: message.id } })).json();
  return { workspace, conversation, thread };
}

async function launch(page: Page, request: APIRequestContext, workspaceId: string) {
  const destination = `/app/workspaces/${workspaceId}/settings/integrations`;
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}`)).json();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  return page.getByRole("main", { name: "Workspace Settings" });
}

const secretText = (page: Page) => page.getByRole("dialog").getByLabel("API key secret").textContent();

test("API keys: create, copy, edit with a stale revision, rotate and revoke through the real admin routes", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { workspace, conversation, thread } = await integrationsWorkspace(request, "keys-lifecycle");
  const threadReads: string[] = [];
  page.on("request", request => { if (request.method() === "GET" && /\/conversations\/[^/]+\/threads$/.test(new URL(request.url()).pathname)) threadReads.push(request.url()); });
  const settings = await launch(page, request, workspace.id);
  await expect(page.getByRole("navigation", { name: "Workspace settings" }).getByRole("link", { name: "Integrations" })).toHaveAttribute("aria-current", "page");
  await expect(settings.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(settings.getByText("No API keys yet.")).toBeVisible();
  // The control server advertises its bound listener, not this page's origin.
  const controlPort = process.env.MINU_TEST_CONTROL_PORT ?? 58411;
  await expect(settings.getByLabel("HTTP request example")).toContainText(`POST http://127.0.0.1:${controlPort}/api/agent/v1/conversation/inspect`);
  await expect(settings.getByText("Use the loopback control origin")).toHaveCount(0);
  // Thread choices are read only once an access dialog opens.
  expect(threadReads).toEqual([]);

  const createButton = settings.getByRole("button", { name: "Create key" });
  await createButton.click();
  const dialog = page.getByRole("dialog", { name: "Create API key" });
  await dialog.getByLabel("Key name").fill("Foreman");
  await expect(dialog.getByLabel("Inspect status")).toBeChecked();
  await expect(dialog.getByLabel("Expiry")).toHaveValue("30");
  await dialog.getByLabel("Search Conversations and threads").fill("keys-parent");
  await expect(dialog.getByRole("button", { name: `Add ${thread.name} in #keys-parent` })).toBeVisible();
  await dialog.getByRole("button", { name: "Add #keys-parent" }).click();
  await dialog.getByLabel("Search Conversations and threads").fill("keys-parent");
  await dialog.getByRole("button", { name: `Add ${thread.name} in #keys-parent` }).click();
  const targets = dialog.getByTestId("api-key-target");
  await expect(targets).toHaveCount(2);
  expect(threadReads).toHaveLength(1);
  await expect(targets.nth(0).getByLabel("Include existing and future threads")).not.toBeChecked();
  await expect(targets.nth(1).getByLabel("Include existing and future threads")).toHaveCount(0);
  await targets.nth(0).getByLabel("Include existing and future threads").check();
  const created = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith(`/workspaces/${workspace.id}/agent-credentials`));
  await dialog.getByRole("button", { name: "Create key" }).click();
  const body = (await created).postDataJSON();
  expect(body).toMatchObject({ name: "Foreman", capabilities: ["conversation.inspect"], scope: { mode: "generic", grants: [
    { conversationId: expect.any(String), includeThreads: true }, { conversationId: thread.id, includeThreads: false },
  ] } });
  expect(body.requestId).toMatch(/^ui_[a-f0-9]{32}$/);
  expect(body).not.toHaveProperty("expiresAt");

  const createdDialog = page.getByRole("dialog", { name: "API key created" });
  await expect(createdDialog.getByText("Copy this key now. It will not be shown again.")).toBeVisible();
  const firstSecret = await secretText(page);
  expect(firstSecret).toMatch(/^chak_[a-f0-9]{32}_/);
  await createdDialog.getByRole("button", { name: "Copy API key" }).click();
  await expect(createdDialog.getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(firstSecret);
  await createdDialog.getByRole("button", { name: "Done" }).click();
  await expect(createButton).toBeFocused();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }) + location.href)).not.toContain(firstSecret!);
  const row = settings.getByRole("row").filter({ hasText: "Foreman" });
  await expect(row).toContainText("Inspect status · 2 targets (1 with threads)");

  // Another tab renames the key and removes the parent grant; only this tab's own edit may survive review.
  const actions = row.getByRole("button", { name: "Actions for API key Foreman" });
  await actions.click();
  await page.getByRole("menuitem", { name: "Edit access" }).click();
  const edit = page.getByRole("dialog", { name: "Edit API key" });
  await expect(edit.getByLabel("Expiry")).toHaveValue("keep");
  await edit.getByLabel("Inspect status").uncheck();
  const credentialId = firstSecret!.split("_")[1]!;
  expect(await page.evaluate(async ([workspaceId, id, threadId]) => (await fetch(`/local/workspaces/${workspaceId}/agent-credentials/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1, name: "Foreman (other tab)", scope: { mode: "generic", grants: [{ conversationId: threadId, includeThreads: false }] } }),
  })).status, [workspace.id, credentialId, thread.id])).toBe(200);
  await edit.getByRole("button", { name: "Save changes" }).click();
  const review = edit.getByRole("region", { name: "Review current key" });
  await expect(review).toContainText("This key changed since you opened it");
  const facts = review.getByLabel("Current key metadata");
  await expect(facts).toContainText("Foreman (other tab)");
  await expect(facts).toContainText("2 (was 1)");
  await expect(review.getByLabel("Current targets").getByRole("listitem")).toHaveText([`${thread.name} in #keys-parent`]);
  await review.getByRole("button", { name: "Keep my changes" }).click();
  await expect(edit.getByText("Your edits now apply to revision 2.")).toBeVisible();
  await expect(edit.getByLabel("Key name")).toHaveValue("Foreman (other tab)");
  await expect(edit.getByLabel("Inspect status")).not.toBeChecked();
  await expect(edit.getByTestId("api-key-target")).toHaveCount(1);
  await expect(edit.getByRole("button", { name: `Remove #${conversation.name}` })).toHaveCount(0);
  const patched = page.waitForRequest(request => request.method() === "PATCH");
  await edit.getByRole("button", { name: "Save changes" }).click();
  expect((await patched).postDataJSON()).toEqual({ expectedRevision: 2, capabilities: [] });
  await expect(edit).toHaveCount(0);
  await expect(actions).toBeFocused();
  await expect(row).toContainText("Foreman (other tab)");
  await expect(row).toContainText("Inspection off · 1 target");

  await actions.click();
  await page.getByRole("menuitem", { name: "Rotate key" }).click();
  const rotate = page.getByRole("dialog", { name: "Rotate API key?" });
  await expect(rotate).toContainText("current secret stops working immediately");
  await page.keyboard.press("Escape");
  await expect(rotate).toHaveCount(0);
  await expect(actions).toBeFocused();
  await actions.click();
  await page.getByRole("menuitem", { name: "Rotate key" }).click();
  await page.getByRole("dialog", { name: "Rotate API key?" }).getByRole("button", { name: "Rotate key" }).click();
  const rotated = page.getByRole("dialog", { name: "API key rotated" });
  const secondSecret = await secretText(page);
  expect(secondSecret).toMatch(/^chak_/);
  expect(secondSecret).not.toBe(firstSecret);
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error("blocked")); });
  await rotated.getByRole("button", { name: "Copy API key" }).click();
  await expect(rotated.getByRole("alert")).toHaveText("Copy failed. Select the key and copy it manually.");
  await rotated.getByRole("button", { name: "Done" }).click();
  await expect(actions).toBeFocused();

  await actions.click();
  await page.getByRole("menuitem", { name: "Revoke key" }).click();
  await page.getByRole("dialog", { name: "Revoke API key?" }).getByRole("button", { name: "Revoke key" }).click();
  await expect(row.getByText("Revoked", { exact: true })).toBeVisible();
  await actions.click();
  for (const name of ["Edit access", "Rotate key", "Revoke key"]) await expect(page.getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
});

for (const [status, error] of [[503, "credential_admin_unavailable"], [403, "forbidden"]] as const) {
  test(`API keys: a creation answered ${status} after it committed is checked by request ID and never issues a second key`, async ({ page, request }) => {
    const { workspace } = await integrationsWorkspace(request, `keys-unknown-${status}`);
    const settings = await launch(page, request, workspace.id);
    let creates = 0;
    // The write reaches the backend, but the response is lost or replaced by a post-persistence denial.
    await page.route(`**/local/workspaces/${workspace.id}/agent-credentials`, async route => {
      if (route.request().method() !== "POST") return route.fallback();
      creates += 1;
      // Node cannot resolve the browser-only *.localhost host; send the same request to loopback.
      await route.fetch({ url: route.request().url().replace("minu-channels.localhost", "127.0.0.1") });
      await route.fulfill({ status, json: { error } });
    });
    await settings.getByRole("button", { name: "Create key" }).click();
    const dialog = page.getByRole("dialog", { name: "Create API key" });
    await dialog.getByLabel("Key name").fill("Lost response");
    await dialog.getByLabel("Search Conversations and threads").fill("keys-parent");
    await dialog.getByRole("button", { name: "Add #keys-parent" }).click();
    await dialog.getByRole("button", { name: "Create key" }).click();
    await expect(dialog.getByRole("region", { name: "Unresolved key creation" })).toContainText(status === 403
      ? "Access was denied after “Lost response” was sent, so it may already have been created"
      : "didn’t confirm whether “Lost response” was created");
    await page.keyboard.press("Escape");
    await settings.getByRole("button", { name: "Create key" }).click();
    const unresolved = page.getByRole("dialog", { name: "Create API key" }).getByRole("region", { name: "Unresolved key creation" });
    await expect(unresolved).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Create API key" }).getByLabel("Key name")).toHaveCount(0);
    await unresolved.getByRole("button", { name: "Check outcome" }).click();
    await expect(unresolved).toContainText("was created");
    await expect(unresolved).toContainText("can’t be shown again");
    await unresolved.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog", { name: "Create API key" }).getByLabel("Key name")).toHaveValue("");
    await page.keyboard.press("Escape");
    expect(creates).toBe(1);
    await expect(settings.getByRole("row").filter({ hasText: "Lost response" })).toHaveCount(1);
  });
}

test("API keys: a rotation denied after it committed stays unresolved until current metadata is reviewed", async ({ page, request }) => {
  const { workspace, conversation } = await integrationsWorkspace(request, "keys-rotate-denied");
  const settings = await launch(page, request, workspace.id);
  expect(await page.evaluate(async ([workspaceId, conversationId]) => (await fetch(`/local/workspaces/${workspaceId}/agent-credentials`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "ui_browser_rotate_denied_0001", name: "Rotated", capabilities: ["conversation.inspect"], scope: { mode: "locked", conversationId, includeThreads: false } }),
  })).status, [workspace.id, conversation.id])).toBe(201);
  await page.reload({ waitUntil: "domcontentloaded" });
  const row = settings.getByRole("row").filter({ hasText: "Rotated" });
  const actions = row.getByRole("button", { name: "Actions for API key Rotated" });
  let rotations = 0;
  await page.route("**/agent-credentials/*/rotate", async route => {
    rotations += 1;
    await route.fetch({ url: route.request().url().replace("minu-channels.localhost", "127.0.0.1") });
    await route.fulfill({ status: 401, json: { error: "unauthenticated" } });
  });
  // Access is still unavailable for the first metadata read.
  let deniedReads = 1;
  await page.route(/\/agent-credentials\/[a-f0-9]{32}$/, route => deniedReads-- > 0 && route.request().method() === "GET"
    ? route.fulfill({ status: 403, json: { error: "forbidden" } }) : route.fallback());
  await actions.click();
  await page.getByRole("menuitem", { name: "Rotate key" }).click();
  await page.getByRole("dialog", { name: "Rotate API key?" }).getByRole("button", { name: "Rotate key" }).click();
  const review = page.getByRole("dialog", { name: "Review rotation" });
  await expect(review).toContainText("Access was denied after the rotation was sent");
  await expect(review.getByRole("alert")).toHaveText("The current key couldn’t be loaded.");
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await expect(row.getByText("Needs review")).toBeVisible();
  await actions.click();
  for (const name of ["Edit access", "Rotate key", "Revoke key"]) await expect(page.getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("menuitem", { name: "Review unresolved change" }).click();
  await expect(review.getByLabel("Current key metadata")).toContainText("2 (was 1)");
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await expect(row.getByText("Needs review")).toHaveCount(0);
  await expect(actions).toBeFocused();
  expect(rotations).toBe(1);
});
