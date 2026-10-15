import { expect, test, type APIRequestContext } from "@playwright/test";
import type { ConversationMetadata } from "@minu/channels-core/types";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

async function setup(request: APIRequestContext) {
  const { workspaces } = await (await request.get(`${api}/workspaces`)).json();
  const workspace = workspaces.find((item: { name: string }) => item.name === "Browser Test");
  const { conversations } = await (await request.get(`${api}/workspaces/${workspace.id}/conversations`)).json() as { conversations: ConversationMetadata[] };
  const primary = conversations.find(({ name }) => name === "browser-collaboration")!;
  const alternate = conversations.find(({ name }) => name === "alternate-collaboration")!;
  const destination = `/app/workspaces/${workspace.id}/conversations/${primary.id}`;
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}`)).json();
  return { primary, alternate, launchUrl, destination };
}

async function streamCount(request: APIRequestContext) {
  return (await (await request.get(`${fixture}/stream-metrics`)).json()).active as number;
}

test("six tabs share one stream, keep status responsive, and survive the creating tab closing", async ({ page, request, context }) => {
  test.setTimeout(60_000);
  const data = await setup(request);
  const pages = [page];
  try {
    await page.goto(data.launchUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Live updates live")).toBeVisible();
    const origin = new URL(page.url()).origin;
    for (let index = 1; index < 6; index++) {
      const next = await context.newPage();
      pages.push(next);
      const id = index === 1 ? data.alternate.id : data.primary.id;
      await next.goto(`${origin}/app/workspaces/${data.primary.workspaceId}/conversations/${id}`, { waitUntil: "domcontentloaded" });
      await expect(next.getByLabel("Live updates live")).toBeVisible();
    }
    await expect.poll(() => streamCount(request)).toBe(1);
    await Promise.all(pages.map(async (tab, index) => {
      const id = index === 1 ? data.alternate.id : data.primary.id;
      const status = await tab.evaluate(async (conversationId) => {
        const start = performance.now();
        const response = await fetch(`/local/conversations/${conversationId}/agents`, { signal: AbortSignal.timeout(3_000) });
        await response.json();
        return { status: response.status, ms: performance.now() - start };
      }, id);
      expect(status.status).toBe(200);
      expect(status.ms).toBeLessThan(3_000);
    }));
    // Include the normal five-second idle poll and its three-second request deadline.
    await pages[5]!.waitForTimeout(8_500);
    for (const tab of pages) {
      await expect(tab.getByText(/Runtime status (unavailable|refresh failed)/)).toHaveCount(0);
    }
    const body = `Shared stream message ${Date.now()}`;
    expect((await request.post(`${fixture}/peer-message?body=${encodeURIComponent(body)}`)).ok()).toBe(true);
    for (const tab of pages.filter((_, index) => index !== 1)) {
      await expect(tab.getByRole("log").getByText(body, { exact: true })).toBeVisible();
    }
    await expect(pages[1]!.getByRole("log").getByText(body, { exact: true })).toHaveCount(0);
    const alternateBody = `Alternate shared message ${Date.now()}`;
    await request.post(`${fixture}/peer-message?conversation=alternate&body=${encodeURIComponent(alternateBody)}`);
    await expect(pages[1]!.getByRole("log").getByText(alternateBody, { exact: true })).toBeVisible();
    await expect(page.getByRole("log").getByText(alternateBody, { exact: true })).toHaveCount(0);
    // Bound worker delivery while a tab is suspended, then recover omitted events via snapshots.
    const suspended = pages[5]!;
    const session = await context.newCDPSession(suspended);
    const burst = `Suspended shared tab ${Date.now()}`;
    try {
      await session.send("Page.setWebLifecycleState", { state: "frozen" });
      for (let index = 0; index < 3; index++) {
        await request.post(`${fixture}/peer-message?count=50&body=${encodeURIComponent(`${burst}-${index}`)}`);
      }
    } finally {
      await session.send("Page.setWebLifecycleState", { state: "active" });
      await session.detach();
    }
    await expect(suspended.getByRole("log").getByText(`${burst}-0 1`, { exact: true })).toBeVisible();
    await expect(suspended.getByRole("log").getByText(`${burst}-2 50`, { exact: true })).toBeVisible();
    await expect(suspended.getByLabel("Live updates live")).toBeVisible();
    await page.close();
    const afterClose = `Creator closed ${Date.now()}`;
    await request.post(`${fixture}/peer-message?body=${encodeURIComponent(afterClose)}`);
    await expect(pages[5]!.getByRole("log").getByText(afterClose, { exact: true })).toBeVisible();
    await expect.poll(() => streamCount(request)).toBe(1);
  } finally {
    await Promise.all(pages.filter((tab) => !tab.isClosed()).map((tab) => tab.close()));
  }
});

test("unsupported SharedWorker falls back to snapshot polling without long-lived connections", async ({ page, request }) => {
  const data = await setup(request);
  await page.addInitScript(() => Object.defineProperty(window, "SharedWorker", { configurable: true, value: undefined }));
  await page.goto(data.launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Live updates polling")).toBeVisible();
  await expect.poll(() => streamCount(request)).toBe(0);
  const body = `Polling fallback ${Date.now()}`;
  await request.post(`${fixture}/peer-message?body=${encodeURIComponent(body)}`);
  await expect(page.getByRole("log").getByText(body, { exact: true })).toBeVisible({ timeout: 8_000 });
  const status = await page.evaluate(async () => (await fetch("/local/session", { signal: AbortSignal.timeout(3_000) })).status);
  expect(status).toBe(200);
});
