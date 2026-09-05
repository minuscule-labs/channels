import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const channelsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 4310}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 4312}`;

async function launchAuthenticated(
  page: Page,
  request: APIRequestContext,
  destination: string,
): Promise<void> {
  const response = await request.get(
    `${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}`,
  );
  expect(response.ok()).toBe(true);
  const { launchUrl } = await response.json() as { launchUrl: string };
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
}

test("sends idempotently, refreshes rosters, and catches up after reconnect", async ({ page, request }) => {
  const workspacesResponse = await request.get(`${channelsBase}/workspaces`);
  const { workspaces } = await workspacesResponse.json() as { workspaces: Array<{ id: string }> };
  const workspaceId = workspaces[0]!.id;
  const channelsResponse = await request.get(`${channelsBase}/workspaces/${workspaceId}/channels`);
  const { channels } = await channelsResponse.json() as { channels: Array<{ id: string; rosterRevision: number }> };
  const channelId = channels[0]!.id;
  const initialRosterRevision = channels[0]!.rosterRevision;
  const membersResponse = await request.get(`${channelsBase}/workspaces/${workspaceId}/members`);
  const { members } = await membersResponse.json() as {
    members: Array<{ identityId: string; mentionHandle: string }>;
  };
  const human = members.find(({ mentionHandle }) => mentionHandle === "david")!;
  const agent = members.find(({ mentionHandle }) => mentionHandle === "builder")!;

  const idempotencyKeys: string[] = [];
  const messageAuthors: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.method() === "POST" && outgoing.url().endsWith(`/channels/${channelId}/messages`)) {
      const key = outgoing.headers()["idempotency-key"];
      if (key) idempotencyKeys.push(key);
      const body = outgoing.postDataJSON() as { participantId?: string };
      if (body.participantId) messageAuthors.push(body.participantId);
    }
  });

  await launchAuthenticated(
    page,
    request,
    `/app/workspaces/${workspaceId}/channels/${channelId}`,
  );
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  await expect(page.getByRole("heading", { name: "#browser-collaboration" })).toBeVisible();
  await expect(page.getByText("Workspace: Browser Test", { exact: false })).toBeVisible();
  await expect(page.getByText("Verify the browser collaboration flow.", { exact: false })).toBeVisible();
  await expect(page.getByTitle("Runtime: idle")).toBeVisible();
  await expect(page.getByText("@mention wakes an agent", { exact: false })).toBeVisible();
  await expect(page.getByText("Sending as @david", { exact: true })).toBeVisible();
  await expect(page.getByText("Send as", { exact: true })).toHaveCount(0);

  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: `minu.channels.author.${workspaceId}`,
    value: agent.identityId,
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Sending as @david", { exact: true })).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Channel message" });
  await composer.fill("@b");
  await expect(page.getByRole("option", { name: /@builder/ })).toBeVisible();
  await composer.press("Enter");
  await composer.pressSequentially("Browser reply.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log").getByText("@builder Browser reply.", { exact: true })).toBeVisible();
  expect(idempotencyKeys[0]).toBeTruthy();
  await expect(composer).toHaveValue("");

  await composer.fill("First line");
  await composer.press("Control+Enter");
  await expect(composer).toHaveValue("First line\n");
  await composer.pressSequentially("Second line");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("log").getByText(/First line\s+Second line/)).toBeVisible();

  const update = await request.patch(
    `${channelsBase}/workspaces/${workspaceId}/members/${agent.identityId}`,
    { data: { actorIdentityId: human.identityId, roleLabel: "principal builder" } },
  );
  expect(update.ok()).toBe(true);
  await expect(page.getByText("principal builder — Implements features and verifies changes.")).toBeVisible();
  await expect(page.getByText(new RegExp(`roster ${initialRosterRevision + 1}$`))).toBeVisible();

  const disconnect = await request.post(`${fixtureBase}/disconnect`);
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
  expect(messageAuthors.length).toBeGreaterThan(0);
  expect(new Set(messageAuthors)).toEqual(new Set([human.identityId]));
});

test("configures Workspace agent startup without reflecting saved values", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const workspace = workspaces[0]!;
  await launchAuthenticated(page, request, "/");

  await page.getByRole("button", { name: `Configure Workspace ${workspace.name}` }).click();
  const dialog = page.getByRole("dialog", { name: `${workspace.name} configuration` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Signed in as @david · owner");

  const rootValue = "file:///secret/browser-review-root";
  await dialog.getByLabel("Source location", { exact: true }).fill(rootValue);
  const rootResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url().endsWith(`/local/workspaces/${workspace.id}/config`));
  await dialog.getByRole("button", { name: "Save source" }).click();
  const rootResponse = await rootResponsePromise;
  expect(rootResponse.ok()).toBe(true);
  expect(await rootResponse.text()).not.toContain(rootValue);
  await expect(dialog.getByText("Source: configured", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Replace source location", { exact: true })).toHaveValue("");

  await dialog.getByRole("button", { name: "Close Workspace configuration" }).click();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("heading", { name: `${workspace.name} agents` })).toBeVisible();
  await page.getByRole("link", { name: /Builder Agent/ }).click();
  await expect(page.getByRole("heading", { name: "Builder Agent", exact: true, level: 1 })).toBeVisible();
  const agentCard = page.locator("article").filter({ hasText: "Builder Agent" });
  const identityForm = agentCard.locator("form").filter({ hasText: "The name identifies the agent" });
  await expect(identityForm.getByLabel("Mention handle")).toHaveValue("builder");

  const agentForm = agentCard.locator("form").filter({ hasText: "Private launch profile" });
  const runtimeValue = "pi-private-browser";
  const personaValue = "SECRET BROWSER PERSONA";
  await agentForm.getByLabel("Harness", { exact: true }).fill(runtimeValue);
  await agentForm.getByLabel("Agent instructions", { exact: true }).fill(personaValue);
  const agentResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url().includes(`/local/workspaces/${workspace.id}/agents/`));
  await agentForm.getByRole("button", { name: "Save launch profile" }).click();
  const agentResponse = await agentResponsePromise;
  expect(agentResponse.ok()).toBe(true);
  const agentResponseBody = await agentResponse.text();
  expect(agentResponseBody).not.toContain(runtimeValue);
  expect(agentResponseBody).not.toContain(personaValue);
  await expect(agentForm.getByText("Harness: configured", { exact: true })).toBeVisible();
  await expect(agentForm.getByText("Agent instructions: configured", { exact: true })).toBeVisible();
  await expect(agentForm.getByLabel("Replace harness", { exact: true })).toHaveValue("");
  await expect(agentForm.getByLabel("Replace agent instructions", { exact: true })).toHaveValue("");
  await expect(page.getByText(personaValue, { exact: true })).toHaveCount(0);

  const providerSelect = agentCard.getByRole("combobox", { name: "Provider", exact: true });
  const modelSelect = agentCard.getByRole("combobox", { name: "Model", exact: true });
  const reasoningSelect = agentCard.getByRole("combobox", { name: "Reasoning", exact: true });
  await expect(providerSelect).toBeEnabled({ timeout: 10_000 });
  await agentForm.getByText("Manage available provider models", { exact: true }).click();
  await agentForm.getByLabel("Enable Browser Fast").uncheck();
  const modelPolicyResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PUT"
    && response.url().includes(`/local/workspaces/${workspace.id}/agents/`));
  await agentForm.getByRole("button", { name: "Save available models" }).click();
  expect((await modelPolicyResponsePromise).ok()).toBe(true);
  await providerSelect.selectOption("openai");
  await expect(modelSelect.getByRole("option", { name: "Browser Fast" })).toHaveCount(0);
  await modelSelect.selectOption({ label: "Browser Deep" });
  await reasoningSelect.selectOption("high");
  const launchProfileResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url().includes(`/local/workspaces/${workspace.id}/agents/`));
  await agentForm.getByRole("button", { name: "Save launch profile" }).click();
  const launchProfileResponse = await launchProfileResponsePromise;
  expect(launchProfileResponse.ok()).toBe(true);
  const launchProfileBody = await launchProfileResponse.text();
  expect(launchProfileBody).not.toContain("gpt-browser-deep");
  expect(launchProfileBody).not.toContain("high");
  await expect(agentForm.getByText("Model: configured", { exact: true })).toBeVisible();
  await expect(agentForm.getByText("Reasoning: configured", { exact: true })).toBeVisible();
});

test("lists agents, opens a detail page, and adds an agent", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const workspace = workspaces[0]!;
  await launchAuthenticated(page, request, `/app/workspaces/${workspace.id}/agents`);

  await expect(page.getByRole("link", { name: /Builder Agent/ })).toBeVisible();
  await page.getByRole("button", { name: "Add agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Workspace agent" });
  await expect(dialog.getByLabel("Mention handle")).toHaveCount(0);
  await dialog.getByLabel("Display name").fill("Browser Review Agent");
  await dialog.getByRole("combobox", { name: "Provider", exact: true }).selectOption("openai");
  await dialog.getByRole("combobox", { name: "Model", exact: true }).selectOption({ label: "Browser Deep" });
  await dialog.getByRole("combobox", { name: "Reasoning", exact: true }).selectOption("high");
  await dialog.getByLabel("Agent instructions").fill("Review proposed plans carefully.");
  await dialog.getByRole("button", { name: "Create agent" }).click();

  await expect(page.getByRole("heading", { name: "Browser Review Agent", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Model: configured", { exact: true })).toBeVisible();
  await expect(page.getByText("Reasoning: configured", { exact: true })).toBeVisible();
  await expect(page.getByText("Agent instructions: configured", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "All agents" }).click();
  await expect(page.getByRole("link", { name: /Browser Review Agent/ })).toBeVisible();
});

test("creates named Channels and revisioned participant rosters", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const workspace = workspaces[0]!;
  const { members } = await (await request.get(
    `${channelsBase}/workspaces/${workspace.id}/members`,
  )).json() as { members: Array<{ identityId: string; mentionHandle: string }> };
  const builder = members.find(({ mentionHandle }) => mentionHandle === "builder")!;
  await launchAuthenticated(page, request, "/");

  await page.getByRole("button", { name: `Create Channel in ${workspace.name}` }).click();
  const createDialog = page.getByRole("dialog", { name: `Create a Channel in ${workspace.name}` });
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel("Channel name").fill("roster-administration");
  await expect(createDialog.getByRole("checkbox", { name: /David Kennedy/ })).toBeChecked();
  await createDialog.getByRole("checkbox", { name: /Builder Agent/ }).check();
  const createResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/channels"));
  await createDialog.getByRole("button", { name: "Create Channel" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const { channel } = await createResponse.json() as { channel: { id: string } };
  await expect(page).toHaveURL(new RegExp(`/channels/${channel.id}$`));
  await expect(page.getByRole("heading", { name: "#roster-administration" })).toBeVisible();
  const startResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/local/channels/${channel.id}/agents/${builder.identityId}/start`));
  await page.getByRole("button", { name: "Start Builder Agent" }).click();
  expect((await startResponsePromise).ok()).toBe(true);
  await expect(page.getByTitle("Runtime: idle")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  const replaceResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/local/channels/${channel.id}/agents/${builder.identityId}/replace`));
  await page.getByRole("button", { name: "Start fresh with Builder Agent" }).click();
  expect((await replaceResponsePromise).ok()).toBe(true);
  await expect(page.getByTitle("Runtime: idle")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  const stopResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/local/channels/${channel.id}/agents/${builder.identityId}/stop`));
  await page.getByRole("button", { name: "Stop Builder Agent" }).click();
  expect((await stopResponsePromise).ok()).toBe(true);
  await expect(page.getByTitle("Runtime: disabled")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start fresh with Builder Agent" }).click();
  await expect(page.getByTitle("Runtime: idle")).toBeVisible();

  const historical = await request.post(`${channelsBase}/channels/${channel.id}/messages`, {
    data: { participantId: builder.identityId, body: "Builder attribution survives roster removal." },
  });
  expect(historical.ok()).toBe(true);
  await expect(page.getByRole("log").getByText("Builder attribution survives roster removal.")).toBeVisible();

  await page.getByRole("button", { name: "Manage Channel participants" }).click();
  let rosterDialog = page.getByRole("dialog", { name: "Manage #roster-administration" });
  await expect(rosterDialog.getByRole("checkbox", { name: /Builder Agent/ })).toBeChecked();
  await rosterDialog.getByLabel("Channel name").fill("delivery-room");
  const renameResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().endsWith(`/channels/${channel.id}`));
  await rosterDialog.getByRole("button", { name: "Save name" }).click();
  expect((await renameResponsePromise).ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "#delivery-room" })).toBeVisible();
  rosterDialog = page.getByRole("dialog", { name: "Manage #delivery-room" });
  const participantForm = rosterDialog.locator("form").filter({ hasText: "Create a participant" });
  await participantForm.getByLabel("Participant type").selectOption("agent");
  await participantForm.getByLabel("Display name").fill("Reviewer Agent");
  await expect(participantForm.getByLabel("Mention handle")).toHaveValue("reviewer-agent");
  await participantForm.getByLabel("Mention handle").fill("@reviewer");
  await expect(participantForm.getByLabel("Mention handle")).toHaveValue("reviewer");
  await participantForm.getByLabel("Public role (optional)").fill("reviewer");
  await participantForm.getByLabel("Agent instructions (optional)").fill("Review work for correctness and report concrete findings.");
  const identityResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/identities"));
  const memberResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith(`/workspaces/${workspace.id}/members`));
  const configurationResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().includes(`/local/workspaces/${workspace.id}/agents/`));
  await participantForm.getByRole("button", { name: "Create participant" }).click();
  expect((await identityResponsePromise).ok()).toBe(true);
  expect((await memberResponsePromise).ok()).toBe(true);
  expect((await configurationResponsePromise).ok()).toBe(true);
  await expect(participantForm.getByText("Participant created and selected", { exact: true })).toBeVisible();
  await expect(rosterDialog.getByRole("checkbox", { name: /Reviewer Agent/ })).toBeChecked();
  await rosterDialog.getByRole("checkbox", { name: /Builder Agent/ }).uncheck();
  await rosterDialog.getByRole("button", { name: "Save participants" }).click();
  await expect(rosterDialog).toBeHidden();
  await expect(page.getByText(/roster 2$/)).toBeVisible();
  await expect(page.getByRole("log").getByText("Builder Agent", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Manage Channel participants" }).click();
  rosterDialog = page.getByRole("dialog", { name: "Manage #delivery-room" });
  await rosterDialog.getByRole("checkbox", { name: /Builder Agent/ }).check();
  await rosterDialog.getByRole("button", { name: "Save participants" }).click();
  await expect(rosterDialog).toBeHidden();
  await expect(page.getByText(/roster 3$/)).toBeVisible();
});

test("uses accessible mobile navigation and participant drawers", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { channels } = await (await request.get(
    `${channelsBase}/workspaces/${workspaceId}/channels`,
  )).json() as { channels: Array<{ id: string }> };
  const channelId = channels[0]!.id;

  await launchAuthenticated(page, request, "/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("link", { name: /browser-collaboration/ }).click();
  await expect(navigation).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/app/workspaces/${workspaceId}/channels/${channelId}$`));

  await page.getByRole("button", { name: "Show participants" }).click();
  const participants = page.getByRole("dialog", { name: "Participants" });
  await expect(participants).toContainText("Builder Agent");
  await participants.getByRole("button", { name: "Close participants" }).click();
  await expect(participants).toBeHidden();
  await expect(page.getByRole("button", { name: "Show participants" })).toBeFocused();
});

test("keeps messaging available when Runtime status is unavailable", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${channelsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { channels } = await (await request.get(
    `${channelsBase}/workspaces/${workspaceId}/channels`,
  )).json() as { channels: Array<{ id: string }> };
  const channelId = channels[0]!.id;
  await page.route(`**/local/channels/${channelId}/agents`, (route) => route.abort("connectionfailed"));

  await launchAuthenticated(
    page,
    request,
    `/app/workspaces/${workspaceId}/channels/${channelId}`,
  );
  await expect(page.getByLabel("Live updates live")).toBeVisible();
  await expect(page.getByText("Runtime status unavailable")).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Channel message" });
  await composer.fill("Public messaging remains available without local control.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log").getByText(
    "Public messaging remains available without local control.",
    { exact: true },
  )).toBeVisible();
});
