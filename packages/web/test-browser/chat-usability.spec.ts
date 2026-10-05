import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const conversationsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

async function fixture(request: APIRequestContext) {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json();
  const workspaceId = workspaces.find(({ name }: { name: string }) => name === "Browser Test").id as string;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json();
  return {
    workspaceId,
    primaryId: conversations.find(({ name }: { name: string }) => name === "browser-collaboration").id as string,
    alternateId: conversations.find(({ name }: { name: string }) => name === "alternate-collaboration").id as string,
  };
}

async function launch(page: Page, request: APIRequestContext, workspaceId: string, conversationId: string) {
  const destination = `/app/workspaces/${workspaceId}/conversations/${conversationId}`;
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}`)).json();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Live updates live")).toBeVisible();
}

async function expectAtEnd(timeline: Locator) {
  await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
}

async function peer(request: APIRequestContext, body: string, options = "") {
  expect((await request.post(`${fixtureBase}/peer-message?body=${encodeURIComponent(body)}${options}`)).ok()).toBe(true);
}

test("opens cold and cached Conversations at the end, including when metadata arrives after messages", async ({ page, request }) => {
  const { workspaceId, primaryId } = await fixture(request);
  await peer(request, "Primary history", "&count=40");
  // Seed own messages so shared fixture history doesn't add unread peer counts to later notification tests.
  await peer(request, "Alternate history", "&count=30&conversation=alternate&author=human");
  await page.route(`**/conversations/${primaryId}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });
  await launch(page, request, workspaceId, primaryId);
  const timeline = page.locator(".minu-scroll.absolute");
  await expect(page.getByText("Primary history 40", { exact: true })).toBeVisible();
  await expectAtEnd(timeline);
  await timeline.evaluate((element) => { element.scrollTop = 0; });
  await page.getByRole("link", { name: /^alternate-collaboration/ }).first().click();
  await expect(page.getByRole("heading", { name: "#alternate-collaboration" })).toBeVisible();
  await expectAtEnd(timeline);
  await timeline.evaluate((element) => { element.scrollTop = 0; });
  await page.getByRole("link", { name: /^browser-collaboration/ }).first().click();
  await expect(page.getByRole("heading", { name: "#browser-collaboration" })).toBeVisible();
  await expectAtEnd(timeline);

  await peer(request, "Latest while anchored");
  await expect(page.getByText("Latest while anchored", { exact: true })).toBeVisible();
  await expectAtEnd(timeline);
  // Reproduce a layout-generated scroll arriving before ResizeObserver, without any reader scroll.
  const gapAfterLayoutScroll = await timeline.evaluate((element) => {
    const spacer = document.createElement("div");
    spacer.style.height = "160px";
    element.firstElementChild!.append(spacer);
    element.dispatchEvent(new Event("scroll"));
    const gap = element.scrollHeight - element.clientHeight - element.scrollTop;
    spacer.remove();
    return gap;
  });
  expect(gapAfterLayoutScroll).toBeLessThan(2);
  await expectAtEnd(timeline);
  await timeline.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await peer(request, "Leave history in place");
  await expect(page.getByRole("button", { name: "1 new message" })).toBeVisible();
  expect(await timeline.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "1 new message" }).click();
  await expectAtEnd(timeline);
});

test("keeps the composer focused while Enter sends, on success, and on failure", async ({ page, request }) => {
  const { workspaceId, primaryId } = await fixture(request);
  let releaseSend = () => {};
  const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
  await page.route(`**/conversations/${primaryId}/messages`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await sendGate;
    await route.continue();
  });
  await launch(page, request, workspaceId, primaryId);
  const composer = page.getByRole("combobox", { name: "Conversation message" });
  const composerSurface = composer.locator("xpath=../../..");
  const [composerBackground, timelineBackground, topBorderWidth] = await Promise.all([
    composerSurface.evaluate((element) => getComputedStyle(element).backgroundColor),
    page.locator(".minu-scroll.absolute").first().evaluate((element) => getComputedStyle(element).backgroundColor),
    composerSurface.evaluate((element) => getComputedStyle(element).borderTopWidth),
  ]);
  expect(composerBackground).toBe(timelineBackground);
  expect(topBorderWidth).toBe("0px");
  const composerBox = await composer.locator("xpath=..").boundingBox();
  expect(page.viewportSize()!.height - composerBox!.y - composerBox!.height).toBeLessThanOrEqual(28);
  await composer.fill("Focused Enter send");
  await composer.press("Enter");
  await expect(composer).toHaveAttribute("aria-busy", "true");
  await expect(composer).toBeFocused();
  await composer.press("Control+Enter");
  await expect(composer).toHaveValue("Focused Enter send");
  releaseSend();
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
  await composer.pressSequentially("Next message without clicking");
  await expect(composer).toHaveValue("Next message without clicking");

  await page.unroute(`**/conversations/${primaryId}/messages`);
  await page.route(`**/conversations/${primaryId}/messages`, (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Send unavailable" }) })
    : route.continue());
  await composer.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Your draft was preserved");
  await expect(composer).toHaveValue("Next message without clicking");
  await expect(composer).toBeFocused();
});

test("lazily renders Mermaid, retains copyable source, and anchors through diagram resizing", async ({ page, request }) => {
  const { workspaceId, primaryId } = await fixture(request);
  await peer(request, "Diagram history", "&count=35");
  const modules: string[] = [];
  page.on("request", (outgoing) => modules.push(outgoing.url()));
  await launch(page, request, workspaceId, primaryId);
  expect(modules.some((url) => url.includes("mermaid-renderer"))).toBe(false);
  const timeline = page.locator(".minu-scroll.absolute");
  await expectAtEnd(timeline);
  const code = "graph TD\n  A[Start] --> B[Think]\n  B --> C[Build]\n  C --> D[Verify]\n  D --> E[Done]";
  await peer(request, `\`\`\`mermaid\n${code}\n\`\`\``);
  const diagram = page.getByRole("img", { name: "Mermaid diagram" }).last();
  await expect(diagram.locator("svg")).toBeVisible();
  await expect(diagram).toContainText("Start");
  await expectAtEnd(timeline);
  expect(modules.some((url) => url.includes("mermaid-renderer"))).toBe(true);

  const block = diagram.locator("../..");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await block.getByRole("button", { name: "Copy code" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${code}\n`);
  // Copy is above a tall diagram; clicking it can deliberately scroll up. Return to the end first.
  await timeline.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
  await block.getByText("Mermaid source", { exact: true }).click();
  await expect(block.locator('pre[data-language="mermaid"]')).toBeVisible();
  await expectAtEnd(timeline);
  const toolbar = block.locator(":scope > div").first();
  const expand = toolbar.getByRole("button", { name: "Expand Mermaid diagram", exact: true });
  const copy = toolbar.getByRole("button", { name: "Copy code", exact: true });
  expect((await expand.boundingBox())!.x).toBeLessThan((await copy.boundingBox())!.x);
  await expand.click();
  const expanded = page.getByRole("dialog", { name: "Mermaid diagram", exact: true });
  await expect(expanded).toBeVisible();
  await expect(expanded.getByRole("img", { name: "Expanded Mermaid diagram" }).locator("svg")).toBeVisible();
  await expanded.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(expanded.getByText("125%", { exact: true })).toBeVisible();
  const viewport = expanded.getByRole("region", { name: "Expanded interactive Mermaid diagram. Drag to pan." });
  await expect.poll(() => viewport.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
  await expect(expanded.getByRole("button", { name: /^Pan / })).toHaveCount(0);
  const viewportBounds = (await viewport.boundingBox())!;
  const zoomControls = expanded.getByRole("group", { name: "Diagram zoom controls" });
  const zoomBounds = (await zoomControls.boundingBox())!;
  expect(viewportBounds.x + viewportBounds.width - zoomBounds.x - zoomBounds.width).toBeCloseTo(16, 0);
  expect(viewportBounds.y + viewportBounds.height - zoomBounds.y - zoomBounds.height).toBeCloseTo(16, 0);
  const scrollBeforeDrag = await viewport.evaluate((element) => element.scrollLeft);
  await page.mouse.move(viewportBounds.x + viewportBounds.width / 2, viewportBounds.y + viewportBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(viewportBounds.x + viewportBounds.width / 2 - 80, viewportBounds.y + viewportBounds.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(scrollBeforeDrag);
  await expanded.getByRole("button", { name: "Reset diagram zoom", exact: true }).click();
  await expect(expanded.getByText("100%", { exact: true })).toBeVisible();
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(0);
  await expanded.getByRole("button", { name: "Close expanded diagram", exact: true }).click();
  await expect(expand).toBeFocused();
  await expect(block.locator('pre[data-language="mermaid"]')).toBeVisible();
  // The Expand control shares the toolbar above a tall diagram, like Copy; return to latest before testing resize anchoring.
  await timeline.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
  await expectAtEnd(timeline);
  await page.setViewportSize({ width: 1050, height: 650 });
  await expectAtEnd(timeline);
  const composer = page.getByRole("combobox", { name: "Conversation message" });
  await composer.fill(Array.from({ length: 12 }, () => "Larger draft").join("\n"));
  await expectAtEnd(timeline);

  await peer(request, "```mermaid\nnot a valid diagram\n```");
  await expect(page.getByRole("status").filter({ hasText: "Unable to render this diagram" })).toBeVisible();
  await expectAtEnd(timeline);
  await timeline.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await peer(request, "> ~~~mermaid\n> sequenceDiagram\n>   Alice->>Bob: Hello\n> ~~~");
  await expect(page.getByRole("img", { name: "Mermaid diagram" }).last().locator("svg")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "1 new message" })).toBeVisible();
  expect(await timeline.evaluate((element) => element.scrollTop)).toBe(0);
});

test("renders Mermaid and highlighted TypeScript together, including nested fences", async ({ page, request }) => {
  const { workspaceId, alternateId } = await fixture(request);
  // Keep supported fences out of the primary fixture used by the existing cold-highlighter test.
  await peer(request, "Mixed history", "&count=35&conversation=alternate&author=human");
  await launch(page, request, workspaceId, alternateId);
  await peer(request, [
    "```mermaid", "graph TD", "  A[Mixed start] --> B[Mixed done]", "```", "",
    "> ~~~MeRmAiD", "> sequenceDiagram", ">   Alice->>Bob: Nested hello", "> ~~~", "",
    "```typescript", "const mixedAnswer: number = 42;", "```",
  ].join("\n"), "&conversation=alternate&author=human");
  const message = page.getByRole("log").locator("article").last();
  // Wait for highlighting first: this is the asynchronous transform that used to erase Mermaid.
  await expect(message.locator('pre[data-language="ts"] .th-keyword')).toBeVisible();
  await expect(message.getByRole("img", { name: "Mermaid diagram" })).toHaveCount(2);
  await expect(message.getByRole("img", { name: "Mermaid diagram" }).first()).toContainText("Mixed start");
  await expect(message.getByRole("img", { name: "Mermaid diagram" }).last()).toContainText("Nested hello");
  await expect(message.locator('pre[data-language="mermaid"]')).toHaveCount(2);
  await expectAtEnd(page.locator(".minu-scroll.absolute"));
});

test("rejects resource-capable Mermaid before any remote or local resource request", async ({ page, request }) => {
  const { workspaceId, primaryId } = await fixture(request);
  const attemptedResources: string[] = [];
  await page.route(/review\.invalid|\/mermaid-resource-probe/, async (route) => {
    attemptedResources.push(route.request().url());
    await route.abort();
  });
  await launch(page, request, workspaceId, primaryId);
  const unsafeSources = [
    'flowchart TD\nA@{ img: "https://review.invalid/image-probe.png", label: "Image", w: 60, h: 60 }',
    'flowchart TD\nA@{ "\\\\x69mg": "/mermaid-resource-probe", label: "Escaped image" }',
    'kanban\n  column[Tasks]\n    task[Remote]@{ img: "//review.invalid/image.png" }',
    'graph TD\nA-->B\nstyle A fill:url(https://review.invalid/image-probe.png)',
    'graph TD\nA-->B;classDef default fill:u\\\\72l(/mermaid-resource-probe)',
    '%%{init: {"securityLevel":"loose", "flowchart":{"htmlLabels":true}}}%%\ngraph TD\nA["<img src=/mermaid-resource-probe onerror=alert(1)>"]',
    '---\nconfig:\n  themeCSS: "@import url(https://review.invalid/style.css)"\n---\ngraph TD\nA-->B',
    'graph TD\nA["#60;#105;mg src=/mermaid-resource-probe#62;"]',
    'gantt\n  dateFormat YYYY-MM-DD\n  todayMarker stroke:red,stroke-width:5px,mask-image:url(https://review.invalid/marker-mask.svg),filter:url(/mermaid-resource-probe)\n  section Review\n  Task : 2026-10-02, 2d',
    '%% benign leading comment\ngantt\n  todayMarker filter:url(/mermaid-resource-probe)\n  section Review\n  Task : 2026-10-02, 2d',
    'sequenceDiagram\n  participant Alice\n  properties Alice: {"icon":"https://review.invalid/image-probe.png"}',
    'sequenceDiagram; Alice->>Bob: Hello;properties Alice: {"icon":"/mermaid-resource-probe"}',
    'sequenceDiagram\n  rect url(https://review.invalid/fill.svg)\n  Alice->>Bob: Hello\n  end',
  ];
  await peer(request, unsafeSources.map((source) => `\`\`\`mermaid\n${source}\n\`\`\``).join("\n\n"));
  const message = page.getByRole("log").locator("article").last();
  await expect(message.getByRole("status").filter({ hasText: "Unable to render" })).toHaveCount(unsafeSources.length);
  await expect(message.locator('pre[data-language="mermaid"]')).toHaveCount(unsafeSources.length);
  await expect(message.getByRole("img", { name: "Mermaid diagram" })).toHaveCount(0);
  await expect(message.locator("a, img, image, foreignObject, script")).toHaveCount(0);
  expect(attemptedResources).toEqual([]);
});

test("keeps ordinary Mermaid links display-only", async ({ page, request }) => {
  const { workspaceId, primaryId } = await fixture(request);
  await launch(page, request, workspaceId, primaryId);
  await peer(request, '```mermaid\ngraph TD\nA[Start]-->B[Done]\nclick B "javascript:alert(1)"\n```');
  const diagram = page.getByRole("img", { name: "Mermaid diagram" }).last();
  await expect(diagram.locator("svg")).toBeVisible();
  await expect(diagram.locator("a, img, image, foreignObject, script")).toHaveCount(0);
  expect(await diagram.innerHTML()).not.toMatch(/onerror=|javascript:/);
});
