import { expect, test } from "@playwright/test";

const conversationsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

test("agent-first roster editing preserves existing human and service participants", async ({ page, request }) => {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as {
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = workspaces[0]!.id;
  const { members } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/members`)).json() as {
    members: Array<{ identityId: string; mentionHandle: string }>;
  };
  const ownerId = members.find(({ mentionHandle }) => mentionHandle === "david")!.identityId;
  const agentId = members.find(({ mentionHandle }) => mentionHandle === "builder")!.identityId;
  const existingIds: string[] = [];
  for (const type of ["human", "service"] as const) {
    const created = await request.post(`${conversationsBase}/identities`, {
      data: { type, displayName: `Existing ${type} participant` },
    });
    expect(created.ok()).toBe(true);
    const { identity } = await created.json() as { identity: { id: string } };
    existingIds.push(identity.id);
    expect((await request.post(`${conversationsBase}/workspaces/${workspaceId}/members`, {
      data: { identityId: identity.id, mentionHandle: `existing-${type}-participant` },
    })).ok()).toBe(true);
  }
  const created = await request.post(`${conversationsBase}/conversations`, {
    data: { workspaceId, name: "existing-participant-regression", participantIds: [ownerId, agentId, ...existingIds], actorIdentityId: ownerId },
  });
  expect(created.ok()).toBe(true);
  const { conversation } = await created.json() as { conversation: { id: string } };
  const destination = `/app/workspaces/${workspaceId}/conversations/${conversation.id}`;
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}`)).json() as { launchUrl: string };
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  const openSettings = async () => {
    await page.getByRole("button", { name: "Conversation actions for existing-participant-regression", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  };
  await openSettings();
  const dialog = page.getByRole("dialog", { name: "Manage #existing-participant-regression" });
  await expect(dialog.getByText("You are included automatically.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /Workspace Member/ })).toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: /Existing human participant/ })).toBeChecked();
  const serviceChoice = dialog.getByRole("checkbox", { name: /Existing service participant/ });
  await expect(serviceChoice).toBeChecked();
  await expect(dialog.getByLabel("Participant type")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Create participant|Create agent/ })).toHaveCount(0);

  const savedIds: string[][] = [];
  page.on("request", (outgoing) => {
    if (outgoing.method() === "PATCH" && outgoing.url().endsWith(`/conversations/${conversation.id}/participants`)) {
      savedIds.push((outgoing.postDataJSON() as { participantIds: string[] }).participantIds);
    }
  });
  await dialog.getByRole("button", { name: "Save participants" }).click();
  await expect(dialog).toBeHidden();
  expect(new Set(savedIds[0])).toEqual(new Set([ownerId, agentId, ...existingIds]));

  await openSettings();
  await serviceChoice.uncheck();
  // A choice must not disappear just because its checkbox was toggled off.
  await serviceChoice.check();
  await expect(serviceChoice).toBeChecked();
  await serviceChoice.uncheck();
  await dialog.getByRole("button", { name: "Save participants" }).click();
  await expect(dialog).toBeHidden();
  expect(new Set(savedIds[1])).toEqual(new Set([ownerId, agentId, existingIds[0]]));

  await openSettings();
  await expect(serviceChoice).toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: /Existing human participant/ })).toBeChecked();
});
