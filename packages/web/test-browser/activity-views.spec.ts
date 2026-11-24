import { expect, test } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

test("Activity tabs group replies without changing notification counts, read scopes or workspace isolation", async ({ page, request }) => {
  const { identities } = await (await request.get(`${api}/identities`)).json();
  const human = identities.find((person: { displayName: string }) => person.displayName === "Workspace Member");
  const other = identities.find((person: { displayName: string }) => person.displayName === "David Kennedy");
  const longName = `Participant_${"B".repeat(72)}`;
  const { identity: bob } = await (await request.post(`${api}/identities`, { data: { type: "human", displayName: longName } })).json();
  const workspaces = [];
  const parents = [];
  try {
    for (const suffix of ["A", "B"]) {
      const { workspace } = await (await request.post(`${api}/workspaces`, { data: { name: `Activity views ${suffix}`, slug: `activity-views-${suffix.toLowerCase()}` } })).json();
      workspaces.push(workspace);
      for (const [index, person] of [human, other, bob].entries()) expect((await request.post(`${api}/workspaces/${workspace.id}/members`, { data: {
        identityId: person.id, mentionHandle: `person${index}`, accessRole: "owner",
      } })).ok()).toBe(true);
      const { conversation } = await (await request.post(`${api}/conversations`, { data: {
        workspaceId: workspace.id, name: `Activity views ${suffix}`, participantIds: [human.id, other.id, bob.id],
      } })).json();
      parents.push(conversation);
    }
    const [workspace, foreign] = workspaces;
    const [parent, foreignParent] = parents;
    const post = async (id: string, body: string, author = other.id, to: string[] = []) => {
      const response = await request.post(`${api}/conversations/${id}/messages`, { data: { participantId: author, body, to } });
      expect(response.ok()).toBe(true);
      return (await response.json()).message;
    };
    const root = await post(parent.id, "GROUPED_THREAD_ROOT", human.id);
    const { thread } = await (await request.post(`${api}/conversations/${parent.id}/threads`, { data: { actorIdentityId: human.id, rootMessageId: root.id } })).json();
    const read = await post(thread.id, "Previously read");
    expect((await request.post(`${api}/conversations/${thread.id}/read`, { headers: { "x-minu-actor-id": human.id }, data: { sequence: read.sequence } })).ok()).toBe(true);
    const mention = await post(thread.id, "GROUPED_THREAD_MENTION", bob.id, [human.id]);
    await post(thread.id, "GROUPED_THREAD_LATEST");
    await post(thread.id, "Own reply is excluded", human.id);
    const secondRoot = await post(parent.id, "SEPARATE_THREAD_ROOT", human.id);
    const { thread: second } = await (await request.post(`${api}/conversations/${parent.id}/threads`, { data: { actorIdentityId: human.id, rootMessageId: secondRoot.id } })).json();
    await post(second.id, "Separate thread reply");
    const parentMention = await post(parent.id, "GROUPED_PARENT_MENTION", other.id, [human.id]);
    await post(parent.id, "GROUPED_BROADCAST", bob.id, ["@conversation"]);
    await post(parent.id, "Ordinary unread is not Activity");
    await post(foreignParent.id, "Foreign mention", other.id, [human.id]);
    const path = `/app/workspaces/${workspace.id}/activity`;
    const { launchUrl } = await (await request.get(`${fixture}/control-launch?actor=member&destination=${encodeURIComponent(path)}`)).json();
    const parentReads: string[] = [];
    page.on("request", req => { if (req.method() === "POST" && new URL(req.url()).pathname === `/conversations/${parent.id}/read`) parentReads.push(req.url()); });
    const inbox = async () => (await (await request.get(`${api}/identities/me/inbox`, { headers: { "x-minu-actor-id": human.id } })).json()).summaries;
    const before = await inbox();
    const summary = async (id: string) => (await inbox()).find((item: { conversationId: string }) => item.conversationId === id);
    await page.goto(launchUrl);
    const rows = page.locator("[data-activity-id]");
    const tab = (name: string) => page.getByRole("tab", { name, exact: true });
    const grouped = page.locator(`[data-activity-conversation="${thread.id}"]`);
    const badge = () => page.getByRole("navigation", { name: "Workspaces and Conversations" }).getByLabel(/unread Activity notification/);
    await expect(tab("All")).toHaveAttribute("aria-selected", "true");
    await expect(rows).toHaveCount(4);
    await expect(grouped).toHaveCount(1);
    await expect(grouped).toContainText("GROUPED_THREAD_LATEST");
    await expect(grouped).toContainText("David Kennedy +1");
    await expect(grouped.getByLabel("2 unread notifications", { exact: true })).toBeVisible();
    await expect(badge()).toHaveText("5");
    await tab("All").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tab("Mentions")).toHaveAttribute("aria-selected", "true");
    await expect(rows).toHaveCount(3);
    await expect(grouped).toContainText("GROUPED_THREAD_MENTION");
    await expect(grouped.getByLabel("1 unread notification", { exact: true })).toBeVisible();
    await expect(page.locator(`[data-activity-conversation="${second.id}"]`)).toHaveCount(0);
    await expect(badge()).toHaveText("5");
    expect(await inbox()).toEqual(before);
    expect(parentReads).toEqual([]);
    const fresh = await post(thread.id, "GROUPED_LIVE_REPLY");
    await expect(badge()).toHaveText("6");
    await expect(grouped).toHaveAttribute("data-activity-id", mention.id); // non-mention does not replace the filtered representative
    await expect(grouped.getByLabel("1 unread notification", { exact: true })).toBeVisible();
    await tab("Mentions").focus();
    await page.keyboard.press("End");
    await expect(tab("Threads")).toHaveAttribute("aria-selected", "true");
    await expect(rows).toHaveCount(2);
    await expect(grouped).toHaveAttribute("data-activity-id", fresh.id);
    await expect(grouped.getByLabel("3 unread notifications", { exact: true })).toBeVisible();
    await grouped.getByRole("link").click();
    const panel = page.getByRole("dialog", { name: "Thread", exact: true });
    await expect(panel.getByRole("log").locator(`[data-message-sequence="${mention.sequence}"]`)).toBeFocused();
    await expect.poll(async () => (await summary(thread.id))?.count).toBe(0);
    await expect(badge()).toHaveText("3");
    expect((await summary(parent.id))?.readSequence).toBeUndefined();
    expect(parentReads).toEqual([]);
    await page.goBack();
    await expect(tab("Threads")).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(new RegExp(`${path}\\?view=threads$`));
    await expect(rows).toHaveCount(2);
    await expect(grouped.getByLabel("Unread", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(tab("Threads")).toHaveAttribute("aria-selected", "true");
    await page.getByLabel("Selected Workspace", { exact: true }).selectOption(foreign.id);
    await expect(page).toHaveURL(new RegExp(`/workspaces/${foreign.id}/activity\\?view=threads$`));
    await expect(tab("Threads")).toHaveAttribute("aria-selected", "true");
    await expect(rows).toHaveCount(0);
    await expect(badge()).toHaveText("1"); // complete All count, not filtered row count
    await page.getByLabel("Selected Workspace", { exact: true }).selectOption(workspace.id);
    await tab("Mentions").click();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const name of ["All", "Mentions", "Threads"]) await expect(tab(name)).toBeVisible();
    await expect(grouped).toContainText(longName);
    expect(await page.getByRole("region", { name: "Activity", exact: true }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator(`[data-activity-id="${parentMention.id}"]`).getByRole("link").click();
    await expect(panel).toHaveCount(0);
    await expect.poll(async () => (await summary(parent.id))?.count).toBe(0);
    expect((await summary(second.id))?.count).toBe(1);
    await expect(badge()).toHaveText("1");
  } finally {
    // The fixture is shared with later files. Clear only this test's scopes for all of its humans.
    const owned = new Set(workspaces.map(workspace => workspace.id));
    for (const person of [human, other, bob]) {
      const response = await request.get(`${api}/identities/me/inbox`, { headers: { "x-minu-actor-id": person.id } });
      expect(response.ok()).toBe(true);
      const { summaries } = await response.json();
      for (const summary of summaries.filter((item: { workspaceId: string; latestSequence: number }) => owned.has(item.workspaceId) && item.latestSequence > 0)) {
        expect((await request.post(`${api}/conversations/${summary.conversationId}/read`, {
          headers: { "x-minu-actor-id": person.id }, data: { sequence: summary.latestSequence },
        })).ok()).toBe(true);
      }
    }
  }
});
