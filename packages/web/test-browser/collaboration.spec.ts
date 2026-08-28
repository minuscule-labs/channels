import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function launchAuthenticated(
  page: Page,
  request: APIRequestContext,
  destination: string,
): Promise<void> {
  const response = await request.get(
    `http://127.0.0.1:4312/control-launch?destination=${encodeURIComponent(destination)}`,
  );
  expect(response.ok()).toBe(true);
  const { launchUrl } = await response.json() as { launchUrl: string };
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
}

test("sends idempotently, refreshes rosters, and catches up after reconnect", async ({ page, request }) => {
  const workspacesResponse = await request.get("http://127.0.0.1:4310/workspaces");
  const { workspaces } = await workspacesResponse.json() as { workspaces: Array<{ id: string }> };
  const workspaceId = workspaces[0]!.id;
  const channelsResponse = await request.get(`http://127.0.0.1:4310/workspaces/${workspaceId}/channels`);
  const { channels } = await channelsResponse.json() as { channels: Array<{ id: string; rosterRevision: number }> };
  const channelId = channels[0]!.id;
  const initialRosterRevision = channels[0]!.rosterRevision;
  const membersResponse = await request.get(`http://127.0.0.1:4310/workspaces/${workspaceId}/members`);
  const { members } = await membersResponse.json() as {
    members: Array<{ identityId: string; mentionHandle: string }>;
  };
  const human = members.find(({ mentionHandle }) => mentionHandle === "david")!;
  const agent = members.find(({ mentionHandle }) => mentionHandle === "builder")!;

  const idempotencyKeys: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.method() === "POST" && outgoing.url().endsWith(`/channels/${channelId}/messages`)) {
      const key = outgoing.headers()["idempotency-key"];
      if (key) idempotencyKeys.push(key);
    }
  });

  await launchAuthenticated(
    page,
    request,
    `/app/workspaces/${workspaceId}/channels/${channelId}`,
  );
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  await expect(page.getByText("Verify the browser collaboration flow.", { exact: false })).toBeVisible();
  await expect(page.getByTitle("Local Runtime: idle")).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Channel message" });
  await composer.fill("@b");
  await expect(page.getByRole("option", { name: /@builder/ })).toBeVisible();
  await composer.press("Enter");
  await composer.pressSequentially("Browser reply.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log").getByText("@builder Browser reply.", { exact: true })).toBeVisible();
  expect(idempotencyKeys[0]).toBeTruthy();
  await expect(composer).toHaveValue("");

  const update = await request.patch(
    `http://127.0.0.1:4310/workspaces/${workspaceId}/members/${agent.identityId}`,
    { data: { actorIdentityId: human.identityId, roleLabel: "principal builder" } },
  );
  expect(update.ok()).toBe(true);
  await expect(page.getByText("principal builder — Implements features and verifies changes.")).toBeVisible();
  await expect(page.getByText(new RegExp(`roster ${initialRosterRevision + 1}$`))).toBeVisible();

  const disconnect = await request.post("http://127.0.0.1:4312/disconnect");
  expect(disconnect.ok()).toBe(true);
  await expect(page.getByLabel("Live updates disconnected")).toBeVisible({ timeout: 10_000 });

  await composer.fill("@builder Preserve and retry this draft.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your draft was preserved");
  await expect(composer).toHaveValue("@builder Preserve and retry this draft.");
  const failedKey = idempotencyKeys.at(-1);

  await expect(page.getByLabel("Live updates live")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Retry same message" }).click();
  await expect(page.getByRole("log").getByText("@builder Preserve and retry this draft.", { exact: true })).toBeVisible();
  expect(idempotencyKeys.at(-1)).toBe(failedKey);
  await expect(composer).toHaveValue("");
  await expect(page.getByText("Message created while the browser was offline.", { exact: true })).toBeVisible();
});

test("uses accessible mobile navigation and participant drawers", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { workspaces } = await (await request.get("http://127.0.0.1:4310/workspaces")).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { channels } = await (await request.get(
    `http://127.0.0.1:4310/workspaces/${workspaceId}/channels`,
  )).json() as { channels: Array<{ id: string }> };
  const channelId = channels[0]!.id;

  await launchAuthenticated(page, request, "/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("link", { name: new RegExp(channelId.slice(0, 8)) }).click();
  await expect(navigation).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/app/workspaces/${workspaceId}/channels/${channelId}$`));

  await page.getByRole("button", { name: "Show participants" }).click();
  const participants = page.getByRole("dialog", { name: "Participants" });
  await expect(participants).toContainText("Builder Agent");
  await participants.getByRole("button", { name: "Close participants" }).click();
  await expect(participants).toBeHidden();
  await expect(page.getByRole("button", { name: "Show participants" })).toBeFocused();
});

test("keeps public messaging available when local Runtime status is unavailable", async ({ page, request }) => {
  const { workspaces } = await (await request.get("http://127.0.0.1:4310/workspaces")).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { channels } = await (await request.get(
    `http://127.0.0.1:4310/workspaces/${workspaceId}/channels`,
  )).json() as { channels: Array<{ id: string }> };
  const channelId = channels[0]!.id;
  await page.route("**/local/**", (route) => route.abort("connectionfailed"));

  await page.goto(`/app/workspaces/${workspaceId}/channels/${channelId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  await expect(page.getByText("Local Runtime status unavailable")).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Channel message" });
  await composer.fill("Public messaging remains available without local control.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log").getByText(
    "Public messaging remains available without local control.",
    { exact: true },
  )).toBeVisible();
});
