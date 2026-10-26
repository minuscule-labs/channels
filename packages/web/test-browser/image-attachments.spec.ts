import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixture = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=";

async function openConversation(page: Page, request: APIRequestContext) {
  const { workspaces } = await (await request.get(`${api}/workspaces`)).json();
  const workspaceId = workspaces[0].id;
  const { members } = await (await request.get(`${api}/workspaces/${workspaceId}/members`)).json();
  const owner = members.find((member: { accessRole: string }) => member.accessRole === "owner");
  const { conversation } = await (await request.post(`${api}/conversations`, { data: {
    workspaceId, participantIds: [owner.identityId], name: `images-${Date.now()}`,
  } })).json();
  const destination = `/app/workspaces/${workspaceId}/conversations/${conversation.id}`;
  const { launchUrl } = await (await request.get(`${fixture}/control-launch?destination=${encodeURIComponent(destination)}`)).json();
  await page.goto(launchUrl);
  await expect(page.getByRole("combobox", { name: "Conversation message" })).toBeEnabled();
  return { conversation, owner, destination };
}

test("uploads an image-only message, preserves retry payload across reload, and displays in another tab", async ({ page, request }) => {
  const { conversation, destination } = await openConversation(page, request);
  let uploads = 0;
  page.on("request", (req) => { if (req.method() === "POST" && req.url().includes("/attachments?")) uploads += 1; });
  await page.getByLabel("Choose images").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: Buffer.from(pixel, "base64") });
  const queue = page.getByRole("list", { name: "Message images" });
  await expect(queue.getByRole("img", { name: "pixel.png" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  const submissions: { key?: string; body: string }[] = [];
  let lostResponses = 2;
  await page.route(`**/conversations/${conversation.id}/messages`, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    submissions.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData()! });
    if (lostResponses > 0) {
      lostResponses -= 1;
      // Commit against the real API before dropping the browser's response.
      const committed = await request.post(`${api}/conversations/${conversation.id}/messages`, {
        headers: { "idempotency-key": route.request().headers()["idempotency-key"]! }, data: route.request().postDataJSON(),
      });
      expect(committed.status()).toBe(201);
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("draft was preserved");
  // The normal Send action must also reuse an ambiguously failed request, not only Retry.
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("draft was preserved");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("list", { name: "Message images" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same message" }).click();
  await expect(page.getByRole("list", { name: "Message images" })).toHaveCount(0);
  expect(submissions).toHaveLength(3);
  expect(submissions.every((submission) => JSON.stringify(submission) === JSON.stringify(submissions[0]))).toBe(true);
  expect(uploads).toBe(1);
  const image = page.getByRole("log").getByRole("img", { name: "pixel.png" });
  await expect(image).toBeVisible();
  await expect(image).toHaveJSProperty("naturalWidth", 1);
  await expect(page.getByRole("link", { name: "Open image pixel.png" })).toHaveCount(1);
  const other = await page.context().newPage();
  await other.goto(destination);
  await expect(other.getByRole("log").getByRole("img", { name: "pixel.png" })).toBeVisible();
  await other.close();
  await page.route("**/attachments/*/content", (route) => route.fulfill({ status: 404, body: "" }));
  await page.reload();
  await expect(page.getByRole("img", { name: "Image unavailable: pixel.png" })).toBeVisible();
});

test("supports paste/drop/removal on mobile, blocks remote Markdown images, and disables uploads when settled", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { conversation, owner } = await openConversation(page, request);
  const composer = page.getByRole("combobox", { name: "Conversation message" });
  for (const kind of ["paste", "drop"]) {
    await composer.evaluate((element, { pixel, kind }) => {
      const bytes = Uint8Array.from(atob(pixel), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], `${kind}.png`, { type: "image/png" }));
      element.dispatchEvent(kind === "paste" ? new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true })
        : new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, { pixel, kind });
  }
  await expect(page.getByRole("list", { name: "Message images" }).getByRole("img")).toHaveCount(2);
  await page.getByRole("button", { name: "Remove paste.png" }).click();
  await expect(page.getByRole("list", { name: "Message images" }).getByRole("img")).toHaveCount(1);
  await page.getByLabel("Choose images").setInputFiles({ name: "bad.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(page.getByRole("alert")).toContainText("PNG, JPEG, GIF, or WebP");
  const remote: string[] = [];
  await page.route("https://image.invalid/**", async (route) => { remote.push(route.request().url()); await route.abort(); });
  await composer.fill("![external](https://image.invalid/tracker.png)");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("log").getByRole("img", { name: "drop.png" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("log").getByRole("img", { name: "drop.png" })).toHaveJSProperty("naturalWidth", 1);
  expect(remote).toEqual([]);
  await request.patch(`${api}/conversations/${conversation.id}/lifecycle`, { data: { actorIdentityId: owner.identityId, state: "settled" } });
  await page.reload();
  await expect(page.getByRole("button", { name: "Attach images" })).toBeDisabled();
  await expect(composer).toBeDisabled();
});
