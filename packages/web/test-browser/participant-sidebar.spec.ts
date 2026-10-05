import type { LocalConversationAgent } from "@minu/channels-control/contracts";
import type { ConversationMetadata } from "@minu/channels-core/types";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const conversationsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;

async function fixture(request: APIRequestContext) {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json() as { workspaces: Array<{ id: string; name: string }> };
  const workspaceId = workspaces.find(({ name }) => name === "Browser Test")!.id;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as { conversations: ConversationMetadata[] };
  const primary = conversations.find(({ name }) => name === "browser-collaboration")!;
  const alternate = conversations.find(({ name }) => name === "alternate-collaboration")!;
  const { conversation } = await (await request.get(`${conversationsBase}/conversations/${primary.id}`)).json() as { conversation: ConversationMetadata };
  const agent = conversation.participants.find(({ type, handle }) => type === "agent" && handle === "builder")!;
  return { workspaceId, primary: conversation, alternate, agent };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function agentView(data: Fixture, state: LocalConversationAgent["state"] = "idle"): LocalConversationAgent {
  return {
    workspaceId: data.workspaceId, conversationId: data.primary.id, identityId: data.agent.id, state,
    capabilities: { start: state === "unbound", replace: false, stop: false, steer: false, interrupt: false, reconnect: false },
    diagnostics: {
      connection: state === "offline" ? "offline" : "connected", queuedTurns: 0, queuedTurnsExact: true,
      capabilities: { safeActivityEvents: "available", interrupt: "unavailable", reconnectExisting: "unavailable", interactiveAttach: "not_verified", openDiagnostic: "unavailable", liveSkillVerification: "not_verified" },
    },
  };
}
async function launch(page: Page, request: APIRequestContext, data: Fixture, actor = "owner") {
  const destination = `/app/workspaces/${data.workspaceId}/conversations/${data.primary.id}`;
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}&actor=${actor}`)).json() as { launchUrl: string };
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: `#${data.primary.name}`, exact: true })).toBeVisible();
}
async function mockAgent(page: Page, data: Fixture, view: () => LocalConversationAgent) {
  await page.route(`**/local/conversations/${data.primary.id}/agents`, (route) => route.fulfill({
    json: { protocolVersion: 17, conversationId: data.primary.id, agents: [{ ...view(), runtimeSessionId: "PRIVATE_SESSION_MUST_NOT_RENDER" }] },
  }));
}
async function expectTokenColor(locator: Locator, property: string, token: string) {
  await expect(locator).toBeVisible();
  const color = await locator.evaluate((node, { property, token }) => {
    const probe = document.createElement("span");
    probe.style.setProperty(property, `var(${token})`);
    node.parentElement!.append(probe);
    const value = getComputedStyle(probe).getPropertyValue(property);
    probe.remove();
    return value;
  }, { property, token });
  await expect(locator).toHaveCSS(property, color);
}
async function expectInactiveIndicator(locator: Locator) {
  await expectTokenColor(locator, "background-color", "--inactive-indicator-bg");
  await expectTokenColor(locator, "border-color", "--inactive-indicator-outline");
  await expect(locator).toHaveCSS("border-width", "1px");
}
async function details(page: Page, name: string) {
  await page.getByRole("button", { name: `Open actions for ${name}`, exact: true }).click();
  await page.getByRole("button", { name: "Details & diagnostics", exact: true }).click();
  return page.getByRole("dialog", { name: `Details for ${name}`, exact: true });
}

test("compact rows use Runtime colors, preserve live activity, and move secondary details into a modal", async ({ page, request }) => {
  const data = await fixture(request);
  const created = await request.post(`${conversationsBase}/conversations/${data.primary.id}/messages`, {
    data: { participantId: data.primary.participants.find(({ type }) => type === "human")!.id, body: "Participant sidebar trigger fixture" },
  });
  const { message } = await created.json() as { message: { id: string; sequence: number } };
  let view = agentView(data);
  await mockAgent(page, data, () => view);
  await launch(page, request, data);
  const sidebar = page.getByRole("complementary", { name: "Participants sidebar" });
  const row = sidebar.locator(`[data-participant-id="${data.agent.id}"]`);
  await expectTokenColor(row.getByTitle("Runtime: Idle"), "background-color", "--accent");
  await expect(row.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).locator("svg.lucide-ellipsis-vertical")).toBeVisible();
  await expect(row).not.toContainText("Idle");
  await expect(row).not.toContainText(`@${data.agent.handle}`);
  await expect(row.locator("details")).toHaveCount(0);
  view = { ...agentView(data, "running"), activity: { phase: "using_tools", triggerMessageId: message.id, triggerSequence: message.sequence, startedAt: new Date().toISOString(), queuedTurns: 2, queuedTurnsExact: true } };
  await page.reload();
  await expectTokenColor(row.getByTitle("Runtime: Working"), "background-color", "--success");
  await expect(row).toContainText("Using tools…");
  await expect(row).toContainText("2 queued");
  const centers = await row.evaluate((node) => ["[data-participant-avatar]", "span.font-medium", "button[aria-label^='Open actions for']"].map((selector) => {
    const rect = node.querySelector(selector)!.getBoundingClientRect();
    return rect.top + rect.height / 2;
  }));
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
  await expect(row).not.toContainText("Participant sidebar trigger fixture");
  const modal = await details(page, data.agent.displayName!);
  await expect(modal.getByRole("region", { name: "Triggering message" })).toContainText("Participant sidebar trigger fixture");
  await expect(modal.getByRole("region", { name: "Participant diagnostics" })).toContainText("Not verified");
  await expect(modal).toContainText(`@${data.agent.handle}`);
  expect(await modal.innerText()).not.toContain("PRIVATE_SESSION_MUST_NOT_RENDER");
  await modal.getByRole("button", { name: "Close participant details" }).click();
  await expect(page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true })).toBeFocused();
  view = { ...view, activity: { ...view.activity!, phase: "retrying", retryAttempt: 2 } };
  await page.reload();
  await expectTokenColor(row.getByTitle("Runtime: Retrying (attempt 2)"), "background-color", "--warning");
  await expect(row).toContainText("Retrying (attempt 2)");
  await expect(row.getByRole("button", { name: /View errors/ })).toHaveCount(0);
  view = agentView(data, "offline");
  await page.reload();
  await expectInactiveIndicator(row.getByTitle("Runtime: Offline"));
  await expect(row.getByRole("button", { name: /View errors/ })).toHaveCount(0);
});

test("participant rail minimizes, keeps avatar popups usable, and remembers its preference", async ({ page, request }) => {
  const data = await fixture(request);
  await mockAgent(page, data, () => agentView(data));
  await launch(page, request, data);
  const sidebar = page.getByRole("complementary", { name: "Participants sidebar" });
  await expect(sidebar.getByRole("button", { name: "Open participant actions" })).toBeVisible();
  await page.getByRole("button", { name: "Minimize participants" }).click();
  await expect(sidebar).toHaveAttribute("data-minimized", "true");
  expect(await sidebar.evaluate((node) => node.getBoundingClientRect().width)).toBe(64);
  const bulkMenu = sidebar.getByRole("button", { name: "Open participant actions" });
  await expect(bulkMenu).toBeVisible();
  await bulkMenu.click();
  await expect(page.getByText(/Start eligible agents/)).toBeVisible();
  await page.keyboard.press("Escape");
  const avatar = sidebar.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true });
  await expect(avatar).toHaveAttribute("title", `${data.agent.displayName} · Idle`);
  await expect(avatar.locator("svg.lucide-ellipsis-vertical")).toHaveCount(0);
  const modal = await details(page, data.agent.displayName!);
  await expect(modal).toContainText("Idle");
  await modal.getByRole("button", { name: "Close participant details" }).click();
  await expect(avatar).toBeFocused();
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-minimized", "true");
  await page.locator(`a[href="/app/workspaces/${data.workspaceId}/conversations/${data.alternate.id}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/conversations/${data.alternate.id}$`));
  await expect(sidebar).toHaveAttribute("data-minimized", "true");
  await page.getByRole("button", { name: "Expand participants" }).click();
  await expect(sidebar).toHaveAttribute("data-minimized", "false");
  expect(await sidebar.evaluate((node) => node.getBoundingClientRect().width)).toBe(288);
});

test("a failed participant action gets an inline red issue description and viewable details", async ({ page, request }) => {
  const data = await fixture(request);
  await mockAgent(page, data, () => agentView(data, "unbound"));
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}/start`, (route) => route.fulfill({ status: 503, json: { error: "Start failed for sidebar fixture" } }));
  await launch(page, request, data);
  await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  const issue = page.getByRole("button", { name: `View issue details for ${data.agent.displayName}`, exact: true });
  await expectTokenColor(issue, "color", "--danger");
  await expect(page.getByRole("button", { name: /^View errors/ })).toHaveCount(0);
  await expectInactiveIndicator(page.getByTitle("Runtime: Not started"));
  await issue.click();
  const modal = page.getByRole("dialog", { name: `Details for ${data.agent.displayName}`, exact: true });
  await expect(modal.getByRole("region", { name: "Failed participant action" })).toContainText("Start failed for sidebar fixture");
  await modal.getByRole("button", { name: "Close participant details" }).click();
  await expect(issue).toBeFocused();
  await page.getByRole("button", { name: "Dismiss agent action error", exact: true }).click();
  await expect(issue).toHaveCount(0);
});

test("recorded turn issues appear in chat and open safe in-app diagnostics for owners", async ({ page, request }) => {
  const data = await fixture(request);
  await request.post(`${fixtureBase}/turn-failures?value=true`);
  try {
    await mockAgent(page, data, () => agentView(data));
    await launch(page, request, data);
    await expect(page.getByRole("button", { name: /^Issues:/ })).toHaveCount(0);
    await expectTokenColor(page.getByTitle("Runtime: Idle"), "background-color", "--accent");
    const issue = page.getByRole("button", { name: `View Runtime issue details for ${data.agent.displayName}`, exact: true });
    await expectTokenColor(issue.locator("strong"), "color", "--danger");
    await expect(page.getByRole("button", { name: `View issue details for ${data.agent.displayName}`, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^View errors/ })).toHaveCount(0);
    await issue.click();
    const modal = page.getByRole("dialog", { name: `Details for ${data.agent.displayName}`, exact: true });
    await expect(modal.getByRole("region", { name: "Issue diagnostics" })).toContainText("Runtime request timed out");
    await expect(modal.getByText("Recommended: Retry request")).toBeVisible();
    await expect(modal.getByRole("button", { name: "Open diagnostic" })).toHaveCount(0);
    expect(await modal.innerText()).not.toMatch(/fixture-turn-failure-token|runtimeSessionId|PRIVATE_SESSION_MUST_NOT_RENDER/);
    await modal.getByRole("button", { name: "Close participant details" }).click();
    await expect(issue).toBeFocused();
    const sidebarModal = await details(page, data.agent.displayName!);
    await expect(sidebarModal.getByRole("region", { name: "Issue diagnostics" })).toContainText("Runtime request timed out");
    await launch(page, request, data, "member");
    await expect(page.getByRole("button", { name: `View issue details for ${data.agent.displayName}`, exact: true })).toHaveCount(0);
    const memberModal = await details(page, data.agent.displayName!);
    await expect(memberModal.getByRole("region", { name: "Issue diagnostics" })).toHaveCount(0);
  } finally {
    await request.post(`${fixtureBase}/turn-failures?value=false`);
  }
});

test("details remain available in read-only Conversations without enabling session actions", async ({ page, request }) => {
  const data = await fixture(request);
  await mockAgent(page, data, () => agentView(data, "unbound"));
  await page.route(`**/local/conversations/${data.primary.id}/lifecycle`, (route) => route.fulfill({
    json: { lifecycle: { conversationId: data.primary.id, state: "settled" } },
  }));
  await launch(page, request, data);
  await expect(page.getByText("This Conversation is archived and read-only.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Start session", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Details & diagnostics", exact: true }).click();
  await expect(page.getByRole("dialog", { name: `Details for ${data.agent.displayName}`, exact: true })).toContainText("Not started");
});

test("mobile participants retain their drawer and open details without a minimize control", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const data = await fixture(request);
  await mockAgent(page, data, () => agentView(data));
  await launch(page, request, data);
  await page.getByRole("button", { name: "Show participants" }).click();
  await expect(page.getByRole("button", { name: "Minimize participants" })).toHaveCount(0);
  const modal = await details(page, data.agent.displayName!);
  await expect(modal).toContainText("Idle");
  await modal.getByRole("button", { name: "Close participant details" }).click();
  await expect(page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Close participants" }).click();
  await expect(page.getByRole("dialog", { name: "Participants", exact: true })).toHaveCount(0);
});
