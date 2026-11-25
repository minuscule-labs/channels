import { expect, test } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

test("split-view read ownership follows parent/thread interaction without acknowledging the other pane", async ({ page, request }) => {
  const { identities } = await (await request.get(`${api}/identities`)).json();
  const human = identities.find((person: { displayName: string }) => person.displayName === "Workspace Member");
  const other = identities.find((person: { displayName: string }) => person.displayName === "David Kennedy");
  const { workspace } = await (await request.post(`${api}/workspaces`, { data: { name: "Pane read state", slug: "pane-read-state" } })).json();
  try {
    for (const [index, person] of [human, other].entries()) expect((await request.post(`${api}/workspaces/${workspace.id}/members`, { data: {
      identityId: person.id, mentionHandle: `person${index}`, accessRole: "owner",
    } })).ok()).toBe(true);
    const { conversation: parent } = await (await request.post(`${api}/conversations`, { data: {
      workspaceId: workspace.id, name: "Pane read state", participantIds: [human.id, other.id],
    } })).json();
    const post = async (id: string, body: string, participantId = other.id) => {
      const response = await request.post(`${api}/conversations/${id}/messages`, { data: { participantId, body, to: [] } });
      expect(response.ok()).toBe(true);
      return (await response.json()).message as { id: string; sequence: number };
    };
    const root = await post(parent.id, "PANE_PARENT_ROOT", human.id);
    const secondRoot = await post(parent.id, "PANE_SECOND_ROOT", human.id);
    const threads = [];
    for (const message of [root, secondRoot]) {
      const { thread } = await (await request.post(`${api}/conversations/${parent.id}/threads`, { data: { actorIdentityId: human.id, rootMessageId: message.id } })).json();
      threads.push(thread);
      await post(thread.id, "Initial thread reply");
    }
    const [thread, second] = threads;
    const firstUnread = await post(parent.id, "PANE_PARENT_UNREAD");
    const { launchUrl } = await (await request.get(`${fixture}/control-launch?actor=member&destination=${encodeURIComponent(`/app/workspaces/${workspace.id}/conversations/${parent.id}?threadId=${thread.id}&threadMessage=1#message-${root.sequence}`)}`)).json();
    const summary = async (id: string) => {
      const { summaries } = await (await request.get(`${api}/identities/me/inbox`, { headers: { "x-minu-actor-id": human.id } })).json();
      return summaries.find((item: { conversationId: string }) => item.conversationId === id);
    };
    const reads: Array<{ id: string; sequence: number }> = [];
    page.on("request", req => {
      const match = new URL(req.url()).pathname.match(/^\/conversations\/([^/]+)\/read$/);
      if (req.method() === "POST" && match) reads.push({ id: match[1], sequence: req.postDataJSON().sequence });
    });
    const painted = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.goto(launchUrl);
    const panel = page.getByRole("dialog", { name: "Thread", exact: true });
    const parentLog = page.getByRole("log").filter({ hasText: "PANE_PARENT_ROOT" });
    const threadLog = panel.getByRole("log");
    const threadComposer = panel.getByRole("combobox", { name: "Thread reply", exact: true });
    await expect(panel).toBeVisible();
    await expect.poll(async () => (await summary(thread.id))?.count).toBe(0);
    expect((await summary(parent.id))?.count).toBe(1);
    expect(reads.filter(read => read.id === parent.id)).toEqual([]);

    // This is the reported failure: the parent is fully visible at its end, but a thread remains open.
    await parentLog.getByText("PANE_PARENT_UNREAD", { exact: true }).click();
    await expect.poll(async () => (await summary(parent.id))?.readSequence).toBe(firstUnread.sequence);
    await expect(panel).toBeVisible();
    const heldThread = await post(thread.id, "PANE_THREAD_HELD_UNREAD");
    await expect(threadLog.getByText("PANE_THREAD_HELD_UNREAD", { exact: true })).toBeInViewport();
    await painted();
    expect(reads.filter(read => read.id === thread.id && read.sequence >= heldThread.sequence)).toEqual([]);
    expect((await summary(thread.id))?.count).toBe(1);
    const parentUpdate = await post(parent.id, "PANE_PARENT_ACTIVE_UPDATE");
    await expect.poll(async () => (await summary(parent.id))?.readSequence).toBe(parentUpdate.sequence);
    expect((await summary(thread.id))?.count).toBe(1);

    // Pane intent does not bypass the existing document-focus or physical occlusion guards.
    await page.evaluate(() => Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false }));
    const unfocused = await post(parent.id, "PANE_UNFOCUSED_PARENT");
    await expect(parentLog.getByText("PANE_UNFOCUSED_PARENT", { exact: true })).toBeInViewport();
    await painted();
    expect(reads.filter(read => read.id === parent.id && read.sequence >= unfocused.sequence)).toEqual([]);
    expect((await summary(parent.id))?.count).toBe(1);
    await page.evaluate(() => { Reflect.deleteProperty(document, "hasFocus"); window.dispatchEvent(new Event("focus")); });
    await expect.poll(async () => (await summary(parent.id))?.count).toBe(0);
    await page.evaluate(() => {
      const cover = document.createElement("div");
      cover.id = "pane-read-cover"; cover.style.cssText = "position:fixed;inset:0;z-index:99999;background:white";
      document.body.append(cover);
    });
    const covered = await post(parent.id, "PANE_COVERED_PARENT");
    await expect(parentLog.getByText("PANE_COVERED_PARENT", { exact: true })).toBeAttached();
    await painted();
    expect(reads.filter(read => read.id === parent.id && read.sequence >= covered.sequence)).toEqual([]);
    expect((await summary(parent.id))?.count).toBe(1);
    await page.evaluate(() => { document.getElementById("pane-read-cover")?.remove(); window.dispatchEvent(new Event("focus")); });
    await expect.poll(async () => (await summary(parent.id))?.count).toBe(0);

    await threadLog.getByText("PANE_THREAD_HELD_UNREAD", { exact: true }).click();
    await expect.poll(async () => (await summary(thread.id))?.count).toBe(0);
    await threadComposer.click();
    const wheelUnread = await post(parent.id, "PANE_PARENT_WHEEL_UNREAD");
    await expect(parentLog.getByText("PANE_PARENT_WHEEL_UNREAD", { exact: true })).toBeInViewport();
    expect((await summary(parent.id))?.count).toBe(1);
    const box = await parentLog.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 10);
    await page.mouse.wheel(0, 100);
    await expect.poll(async () => (await summary(parent.id))?.readSequence).toBe(wheelUnread.sequence);
    await expect(threadComposer).toBeFocused(); // wheel does not move keyboard focus
    await threadComposer.press("ArrowLeft"); // typing/navigation in that still-focused pane takes ownership back
    const lastParent = await post(parent.id, "PANE_PARENT_HELD_AGAIN");
    await expect(parentLog.getByText("PANE_PARENT_HELD_AGAIN", { exact: true })).toBeInViewport();
    const activeReply = await post(thread.id, "PANE_THREAD_ACTIVE_UPDATE");
    await expect.poll(async () => (await summary(thread.id))?.readSequence).toBe(activeReply.sequence);
    expect((await summary(parent.id))?.count).toBe(1);

    // Clicking/focusing a thread-navigation control must not acknowledge its contextual parent first.
    await parentLog.getByRole("button", { name: `Open thread for message ${secondRoot.sequence}: 1 replies`, exact: true }).click();
    await expect(panel.getByRole("article", { name: "Thread root", exact: true })).toContainText("PANE_SECOND_ROOT");
    await expect.poll(async () => (await summary(second.id))?.count).toBe(0);
    expect((await summary(parent.id))?.count).toBe(1);
    expect(reads.filter(read => read.id === parent.id && read.sequence >= lastParent.sequence)).toEqual([]);
    // Programmatic positioning does not claim the pane; keyboard focus at the visible end does.
    await parentLog.evaluate(element => {
      const scroll = element.closest<HTMLElement>(".minu-scroll")!;
      scroll.scrollTop = scroll.scrollHeight;
    });
    await expect(parentLog.getByText("PANE_PARENT_HELD_AGAIN", { exact: true })).toBeInViewport();
    expect((await summary(parent.id))?.count).toBe(1);
    await page.getByRole("combobox", { name: "Conversation message", exact: true }).focus();
    await expect.poll(async () => (await summary(parent.id))?.readSequence).toBe(lastParent.sequence);
    const closingHeld = await post(second.id, "PANE_INACTIVE_THREAD_ON_CLOSE");
    await expect(panel.getByText("PANE_INACTIVE_THREAD_ON_CLOSE", { exact: true })).toBeInViewport();
    await painted();
    expect((await summary(second.id))?.count).toBe(1);
    await panel.getByRole("button", { name: "Close thread", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await painted();
    expect(reads.filter(read => read.id === second.id && read.sequence >= closingHeld.sequence)).toEqual([]);
    expect((await summary(second.id))?.count, "closing an inactive thread is navigation, not reading its pending reply").toBe(1);
    await parentLog.getByRole("button", { name: `Open thread for message ${secondRoot.sequence}: 2 replies`, exact: true }).click();
    await expect.poll(async () => (await summary(second.id))?.count).toBe(0);
    await threadComposer.click();
    await parentLog.evaluate(element => { const scroll = element.closest<HTMLElement>(".minu-scroll")!; scroll.scrollTop = scroll.scrollHeight; });
    const parentBox = await parentLog.boundingBox();
    await page.mouse.move(parentBox!.x + parentBox!.width / 2, parentBox!.y + parentBox!.height - 10);
    await page.mouse.wheel(0, 100);
    await painted();
    const escapeHeld = await post(second.id, "PANE_INACTIVE_THREAD_ON_ESCAPE");
    await expect(panel.getByText("PANE_INACTIVE_THREAD_ON_ESCAPE", { exact: true })).toBeInViewport();
    await threadComposer.press("Shift");
    await threadComposer.press("Escape");
    await expect(panel).toHaveCount(0);
    await painted();
    expect(reads.filter(read => read.id === second.id && read.sequence >= escapeHeld.sequence)).toEqual([]);
    expect((await summary(second.id))?.count).toBe(1);
    await parentLog.getByRole("button", { name: `Open thread for message ${secondRoot.sequence}: 3 replies`, exact: true }).click();
    await expect.poll(async () => (await summary(second.id))?.count).toBe(0);
    await threadComposer.click();
    await post(parent.id, "PANE_PARENT_BEFORE_CLOSE");
    await expect(parentLog.getByText("PANE_PARENT_BEFORE_CLOSE", { exact: true })).toBeInViewport();
    await painted();
    expect((await summary(parent.id))?.count).toBe(1);
    await panel.getByRole("button", { name: "Close thread", exact: true }).click();
    await expect.poll(async () => (await summary(parent.id))?.count).toBe(0);
  } finally {
    // Shared fixture data must not change later tests' global unread totals.
    for (const person of [human, other]) {
      const { summaries } = await (await request.get(`${api}/identities/me/inbox`, { headers: { "x-minu-actor-id": person.id } })).json();
      for (const item of summaries.filter((item: { workspaceId: string; latestSequence: number }) => item.workspaceId === workspace.id && item.latestSequence > 0)) {
        expect((await request.post(`${api}/conversations/${item.conversationId}/read`, {
          headers: { "x-minu-actor-id": person.id }, data: { sequence: item.latestSequence },
        })).ok()).toBe(true);
      }
    }
  }
});
