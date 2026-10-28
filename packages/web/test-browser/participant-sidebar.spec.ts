import type { LocalConversationAgent } from "@minu/channels-control/contracts";
import type { ConversationMetadata } from "@minu/channels-core/types";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { mockActionRequests } from "./agent-action-fixtures";

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
    json: { protocolVersion: 24, conversationId: data.primary.id, agents: [{ ...view(), runtimeSessionId: "PRIVATE_SESSION_MUST_NOT_RENDER" }] },
  }));
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}`, route => route.fulfill({ json: { agent: view() } }));
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
  await page.getByRole("button", { name: "Details", exact: true }).click();
  return page.getByRole("dialog", { name: `Details for ${name}`, exact: true });
}

for (const minimized of [false, true]) for (const action of ["stop-runtime", "restart-runtime"] as const) {
  test(`uncertain participants offer confirmed ${action} with pending guards (minimized=${minimized})`, async ({ page, request }) => {
    const data = await fixture(request);
    const label = action === "stop-runtime" ? "Stop runtime" : "Restart runtime";
    let view = agentView(data, "uncertain");
    view.capabilities.recover = true;
    await mockAgent(page, data, () => view);
    const actions = await mockActionRequests(page, data.primary.id);
    await page.addInitScript(value => localStorage.setItem("minu-channels:participants-minimized", String(value)), minimized);
    await launch(page, request, data);
    await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
    await expect(page.getByRole("button", { name: "Start agent", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Fresh session", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop runtime", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Restart runtime", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: label, exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: `${label} for ${data.agent.displayName}?`, exact: true });
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    expect(actions.calls).toHaveLength(0);
    await confirmation.getByRole("button", { name: label, exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop runtime", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Restart runtime", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Details", exact: true })).toBeEnabled();
    expect(actions.calls).toHaveLength(1);
    expect(actions.calls[0]).toMatchObject({ action, identityId: data.agent.id });
    view = { ...view, state: action === "stop-runtime" ? "stopped" : "idle" };
    actions.complete();
    await expect(page.getByRole("button", { name: label, exact: true })).toBeEnabled();
    expect(actions.calls).toHaveLength(1);
  });
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
  await expect(modal.getByRole("region", { name: "Participant diagnostics" })).toHaveCount(0);
  await expect(modal.getByRole("link", { name: "Open diagnostics", exact: true })).toHaveAttribute("target", "_blank");
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
  await mockActionRequests(page, data.primary.id, { reject: { status: 409, error: "Start failed for sidebar fixture" } });
  await launch(page, request, data);
  await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
  await page.getByRole("button", { name: "Start agent", exact: true }).click();
  const issue = page.getByRole("button", { name: `View issue details for ${data.agent.displayName}`, exact: true });
  await expectTokenColor(issue, "color", "--danger");
  await expect(page.getByRole("button", { name: /^View errors/ })).toHaveCount(0);
  await expectInactiveIndicator(page.getByTitle("Runtime: Not started"));
  await issue.click();
  const modal = page.getByRole("dialog", { name: `Details for ${data.agent.displayName}`, exact: true });
  await expect(modal.getByRole("region", { name: "Failed participant action" })).toContainText("Start failed for sidebar fixture");
  await modal.getByRole("button", { name: "Close participant details" }).click();
  await expect(issue).toBeFocused();
  await page.getByRole("button", { name: `Dismiss action notice for ${data.agent.displayName}`, exact: true }).click();
  await expect(issue).toHaveCount(0);
  await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
  await page.getByRole("button", { name: "Start agent", exact: true }).click();
  await expect(issue).toBeVisible();
  await page.getByRole("button", { name: "Minimize participants", exact: true }).click();
  await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
  await page.getByRole("button", { name: "Dismiss action notice", exact: true }).click();
  await page.getByRole("button", { name: "Expand participants", exact: true }).click();
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
    await expect(modal).toContainText("Runtime issue · message #");
    await expect(modal.getByRole("region", { name: "Issue diagnostics" })).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Open diagnostic" })).toHaveCount(0);
    expect(await modal.innerText()).not.toMatch(/fixture-turn-failure-token|runtimeSessionId|PRIVATE_SESSION_MUST_NOT_RENDER/);
    await modal.getByRole("button", { name: "Close participant details" }).click();
    await expect(issue).toBeFocused();
    const sidebarModal = await details(page, data.agent.displayName!);
    const href = await sidebarModal.getByRole("link", { name: "Open diagnostics", exact: true }).getAttribute("href");
    await page.goto(href!);
    const diagnostics = page.getByRole("main", { name: "Participant diagnostics", exact: true });
    await expect(diagnostics.getByRole("region", { name: "Issue diagnostics" }).first()).toContainText("Runtime request timed out");
    await expect(diagnostics.getByRole("link", { name: "Open diagnostics in new tab" })).toHaveAttribute("rel", "noopener noreferrer");
    await launch(page, request, data, "member");
    await expect(page.getByRole("button", { name: `View issue details for ${data.agent.displayName}`, exact: true })).toHaveCount(0);
    const memberModal = await details(page, data.agent.displayName!);
    await expect(memberModal.getByRole("region", { name: "Issue diagnostics" })).toHaveCount(0);
    await expect(memberModal.getByRole("region", { name: "Participant diagnostics" })).toHaveCount(0);
    await expect(memberModal.getByRole("region", { name: "Status freshness" })).toBeVisible();
  } finally {
    await request.post(`${fixtureBase}/turn-failures?value=false`);
  }
});

test("details remain available in read-only Conversations without enabling session actions", async ({ page, request }) => {
  const data = await fixture(request);
  const view = agentView(data, "unbound");
  view.capabilities.recover = true;
  await mockAgent(page, data, () => view);
  await page.route(`**/local/conversations/${data.primary.id}/lifecycle`, (route) => route.fulfill({
    json: { lifecycle: { conversationId: data.primary.id, state: "settled" } },
  }));
  await launch(page, request, data);
  await expect(page.getByText("This Conversation is archived and read-only.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "New session with context", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop runtime", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restart runtime", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Details", exact: true }).click();
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

async function inspectionAgents(page: Page, data: Fixture, view: () => LocalConversationAgent) {
  const other = { ...data.agent, id: "diagnostics-other-agent", handle: "inspector", displayName: "Inspection Agent" };
  await page.route(`**/conversations/${data.primary.id}`, (route) => route.fulfill({
    json: { conversation: { ...data.primary, participants: [...data.primary.participants, other] } },
  }));
  await page.route(`**/local/conversations/${data.primary.id}/agents`, (route) => route.fulfill({
    json: { protocolVersion: 20, conversationId: data.primary.id, agents: [view(), { ...agentView(data, "unbound"), identityId: other.id }] },
  }));
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}`, route => route.fulfill({ json: { agent: view() } }));
  await page.route(`**/local/conversations/${data.primary.id}/agents/${other.id}`, route => route.fulfill({ json: { agent: { ...agentView(data, "unbound"), identityId: other.id } } }));
  return other;
}

const pendingScenarios = [
  { label: "Start agent", state: "unbound", action: "start" },
  { label: "Start agent", state: "stopped", action: "start" },
  { label: "Fresh session", state: "unbound", action: "start-fresh", confirmation: "Start a fresh session for", mobile: true },
  { label: "Reconnect", state: "disconnected", action: "reconnect", minimized: true },
  { label: "New session with context", state: "idle", action: "replace", confirmation: "Start a new session with context for" },
  { label: "Fresh session", state: "idle", action: "replace-fresh", confirmation: "Start a fresh session for" },
  { label: "Stop agent", state: "running", action: "stop", confirmation: "Stop" },
  { label: "Cancel current", state: "running", action: "cancel" },
  { label: "Stop agent", state: "running", action: "stop", confirmation: "Stop", fail: true },
] satisfies Array<{ label: string; state: LocalConversationAgent["state"]; action: string; confirmation?: string; mobile?: boolean; minimized?: boolean; fail?: boolean }>;

for (const scenario of pendingScenarios) test(`inspects self and others during accepted ${scenario.label} from ${scenario.state}${scenario.fail ? " with late rejection" : ""}`, async ({ page, request }) => {
  if (scenario.mobile) await page.setViewportSize({ width: 390, height: 844 });
  const data = await fixture(request);
  let view = agentView(data, scenario.state);
  view.capabilities = { start: scenario.state === "unbound" || scenario.state === "stopped", replace: scenario.state !== "unbound", stop: true, interrupt: true, reconnect: true, steer: false };
  const other = await inspectionAgents(page, data, () => view);
  const actions = await mockActionRequests(page, data.primary.id);
  await launch(page, request, data);
  if (scenario.mobile) await page.getByRole("button", { name: "Show participants" }).click();
  if (scenario.minimized) await page.getByRole("button", { name: "Minimize participants" }).click();
  const trigger = page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true });
  await trigger.click();
  const actionButton = page.getByRole("button", { name: scenario.label, exact: true });
  await actionButton.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  if (scenario.confirmation) {
    const confirmation = page.getByRole("dialog", { name: `${scenario.confirmation} ${data.agent.displayName}?`, exact: true });
    await confirmation.getByRole("button", { name: scenario.label, exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect(confirmation).toHaveCount(0);
  }
  await expect.poll(() => actions.calls.length).toBe(1);
  expect(actions.calls[0]!.action).toBe(scenario.action);
  let modal = await details(page, data.agent.displayName!);
  await expect(modal.getByRole("region", { name: "Pending participant action" })).toContainText(scenario.label);
  await modal.getByRole("button", { name: "Refresh status", exact: true }).click();
  expect(actions.calls).toHaveLength(1);
  await modal.getByRole("button", { name: "Close participant details" }).click();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(page.getByRole("button", { name: scenario.label, exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Details", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  const otherModal = await details(page, other.displayName!);
  await expect(otherModal.getByRole("region", { name: "Pending participant action" })).toHaveCount(0);
  await otherModal.getByRole("button", { name: "Close participant details" }).click();
  await page.getByRole("button", { name: `Open actions for ${other.displayName}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Start agent", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  modal = await details(page, data.agent.displayName!);
  view = { ...view, state: scenario.action === "stop" ? "stopped" : "idle" };
  actions.complete(scenario.fail ? { state: "failed", error: "Delayed participant rejection" } : {});
  await expect(modal.getByRole("region", { name: "Pending participant action" })).toHaveCount(0);
  await expect(modal).toBeVisible();
  if (scenario.fail) await expect(modal.getByRole("region", { name: "Failed participant action" })).toContainText("Delayed participant rejection");
  expect(actions.calls).toHaveLength(1);
});

for (const action of ["start", "stop"] as const) test(`inspects participants during accepted bulk ${action}`, async ({ page, request }) => {
  if (action === "stop") await page.setViewportSize({ width: 390, height: 844 });
  const data = await fixture(request);
  let view = agentView(data, action === "start" ? "stopped" : "idle");
  view.capabilities = { ...view.capabilities, start: action === "start", stop: action === "stop" };
  const other = await inspectionAgents(page, data, () => view);
  const actions = await mockActionRequests(page, data.primary.id);
  await launch(page, request, data);
  if (action === "stop") await page.getByRole("button", { name: "Show participants" }).click();
  await page.getByRole("button", { name: "Open participant actions" }).click();
  await page.getByRole("button", { name: action === "start" ? /^Start eligible agents/ : /^Stop active agents/ }).click();
  if (action === "stop") {
    const confirmation = page.getByRole("dialog", { name: "Stop active agents?", exact: true });
    await confirmation.getByRole("button", { name: "Stop active agents", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
  }
  const modal = await details(page, data.agent.displayName!);
  await expect(modal.getByRole("region", { name: "Pending participant action" })).toContainText(`Bulk ${action === "start" ? "Start eligible" : "Stop active"} agents`);
  await modal.getByRole("button", { name: "Close participant details" }).click();
  await page.getByRole("button", { name: `Open actions for ${other.displayName}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Start agent", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await details(page, data.agent.displayName!);
  view = { ...view, state: action === "start" ? "idle" : "stopped" };
  actions.complete({ results: [{ identityId: data.agent.id, outcome: action === "start" ? "started" : "stopped" }] });
  await expect(modal.getByRole("region", { name: "Pending participant action" })).toHaveCount(0);
  expect(actions.calls).toHaveLength(1);
});

test("per-participant refresh reads only its target, preserves receipt time on failure, and recovers", async ({ page, request }) => {
  const data = await fixture(request);
  let fail = false, reads = 0;
  await mockAgent(page, data, () => agentView(data));
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}`, route => {
    reads++;
    return fail ? route.fulfill({ status: 503, json: { error: "PRIVATE_STATUS_ERROR" } }) : route.fulfill({ json: { agent: agentView(data) } });
  });
  await launch(page, request, data);
  const modal = await details(page, data.agent.displayName!);
  const time = modal.getByRole("region", { name: "Status freshness" }).locator("time");
  const before = await time.getAttribute("datetime");
  fail = true;
  await modal.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(modal).toContainText("Status refresh failed");
  await expect(time).toHaveAttribute("datetime", before!);
  await expect(modal).not.toContainText("PRIVATE_STATUS_ERROR");
  await expect(modal).toContainText("Connection uncertain");
  expect(reads).toBe(1);
  fail = false;
  await modal.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(modal).not.toContainText("Status refresh failed");
  await expect(modal.getByRole("region", { name: "Status freshness" })).toContainText("Idle");
  expect(reads).toBe(2);
});

test("polls receipts slowly when idle, quickly while pending, and pauses while hidden", async ({ page, request }) => {
  const data = await fixture(request);
  await page.clock.install();
  await mockAgent(page, data, () => agentView(data, "unbound"));
  const actions = await mockActionRequests(page, data.primary.id);
  let receiptReads = 0;
  page.on("request", outgoing => {
    if (outgoing.method() === "GET" && outgoing.url().endsWith(`/local/conversations/${data.primary.id}/agent-actions`)) receiptReads++;
  });
  await launch(page, request, data);
  await expect.poll(() => receiptReads).toBe(1);
  await page.clock.fastForward(5_000);
  expect(receiptReads).toBe(1);
  await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
  await page.getByRole("button", { name: "Start agent", exact: true }).click();
  const modal = await details(page, data.agent.displayName!);
  await expect(modal.getByRole("region", { name: "Pending participant action" })).toBeVisible();
  const pendingReads = receiptReads;
  await page.clock.fastForward(1_000);
  await expect.poll(() => receiptReads).toBeGreaterThan(pendingReads);
  actions.complete();
  await page.clock.fastForward(1_000);
  await expect(modal.getByRole("region", { name: "Pending participant action" })).toHaveCount(0);
  const idleReads = receiptReads;
  await page.clock.fastForward(5_000);
  expect(receiptReads).toBe(idleReads);
  await page.clock.fastForward(10_000);
  await expect.poll(() => receiptReads).toBe(idleReads + 1);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenReads = receiptReads;
  await page.clock.fastForward(30_000);
  expect(receiptReads).toBe(hiddenReads);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => receiptReads).toBe(hiddenReads + 1);
  expect(actions.calls).toHaveLength(1);
});

test("active Runtime status does not poll every second", async ({ page, request }) => {
  const data = await fixture(request);
  await page.clock.install();
  let statusReads = 0;
  const view = agentView(data, "running");
  view.activity = { phase: "running", triggerMessageId: "trigger", triggerSequence: 1, startedAt: new Date().toISOString(), queuedTurns: 0, queuedTurnsExact: true };
  await mockAgent(page, data, () => { statusReads++; return view; });
  await launch(page, request, data);
  await expect(page.getByTitle("Runtime: Working", { exact: true })).toBeVisible();
  const initialReads = statusReads;
  await page.clock.fastForward(2_000);
  expect(statusReads).toBe(initialReads);
  await page.clock.fastForward(3_000);
  await expect.poll(() => statusReads).toBe(initialReads + 1);
});

test("accepted timing passes 30 seconds without a false failure and Refresh never repeats the mutation", async ({ page, request }) => {
  const data = await fixture(request);
  await page.clock.install();
  await mockAgent(page, data, () => agentView(data, "unbound"));
  const actions = await mockActionRequests(page, data.primary.id);
  await launch(page, request, data);
  await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
  await page.getByRole("button", { name: "Start agent", exact: true }).click();
  const modal = await details(page, data.agent.displayName!);
  await page.clock.fastForward(31_400);
  await expect(modal.getByRole("region", { name: "Pending participant action" })).toContainText("Start agent");
  await expect(modal.getByRole("region", { name: "Failed participant action" })).toHaveCount(0);
  await modal.getByRole("button", { name: "Refresh status", exact: true }).click();
  expect(actions.calls).toHaveLength(1);
  actions.complete();
  await page.clock.resume();
  await expect(modal.getByRole("region", { name: "Pending participant action" })).toHaveCount(0);
});

test("a lost acceptance response is reconciled without another Fresh-session request", async ({ page, request }) => {
  const data = await fixture(request);
  const view = agentView(data); view.capabilities.replace = true;
  await mockAgent(page, data, () => view);
  const actions = await mockActionRequests(page, data.primary.id, { loseAcceptance: true });
  await launch(page, request, data);
  await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
  await page.getByRole("button", { name: "Fresh session", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: `Start a fresh session for ${data.agent.displayName}?`, exact: true });
  await confirmation.getByRole("button", { name: "Fresh session", exact: true }).click();
  await confirmation.getByRole("button", { name: /Cancel|Close/, exact: true }).click();
  const modal = await details(page, data.agent.displayName!);
  actions.complete();
  await expect(modal.getByRole("region", { name: "Pending participant action" })).toHaveCount(0);
  await expect(modal.getByRole("region", { name: "Failed participant action" })).toHaveCount(0);
  expect(actions.calls).toHaveLength(1);
  expect(actions.calls[0]!.action).toBe("replace-fresh");
});

test("a late failure cannot contaminate controls in the next Conversation", async ({ page, request }) => {
  const data = await fixture(request);
  const view = agentView(data); view.capabilities.stop = true;
  await mockAgent(page, data, () => view);
  const actions = await mockActionRequests(page, data.primary.id);
  await launch(page, request, data);
  await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
  await page.getByRole("button", { name: "Stop agent", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: `Stop ${data.agent.displayName}?`, exact: true });
  await confirmation.getByRole("button", { name: "Stop agent", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await page.getByRole("link", { name: new RegExp(`^${data.alternate.name}`) }).first().click();
  await expect(page.getByRole("heading", { name: `#${data.alternate.name}`, exact: true })).toBeVisible();
  const modal = await details(page, data.agent.displayName!);
  actions.complete({ state: "failed", error: "Previous Conversation Stop failed" });
  await expect(modal).not.toContainText("Previous Conversation Stop failed");
  await expect(modal.getByRole("region", { name: "Pending participant action" })).toHaveCount(0);
});

test("bulk failure remains inspectable and dismissible without reopening confirmation", async ({ page, request }) => {
  const data = await fixture(request);
  const view = agentView(data); view.capabilities.stop = true;
  await mockAgent(page, data, () => view);
  const actions = await mockActionRequests(page, data.primary.id);
  await launch(page, request, data);
  await page.getByRole("button", { name: "Open participant actions" }).click();
  await page.getByRole("button", { name: /^Stop active agents/ }).click();
  const confirmation = page.getByRole("dialog", { name: "Stop active agents?", exact: true });
  await confirmation.getByRole("button", { name: "Stop active agents", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  const modal = await details(page, data.agent.displayName!);
  actions.complete({ state: "failed", error: "Delayed bulk Stop failure" });
  await expect(modal.getByRole("region", { name: "Failed participant action" })).toContainText("Delayed bulk Stop failure");
  await modal.getByRole("button", { name: `Dismiss action notice for ${data.agent.displayName}`, exact: true }).click();
  await expect(modal.getByRole("region", { name: "Failed participant action" })).toHaveCount(0);
  await modal.getByRole("button", { name: "Close participant details" }).click();
  await expect(page.getByText("Delayed bulk Stop failure", { exact: true })).toHaveCount(0);
});

test("refresh recovers multiple participants while the collection status remains unavailable", async ({ page, request }) => {
  const data = await fixture(request);
  const other = await inspectionAgents(page, data, () => agentView(data));
  let collectionReads = 0, individualReads = 0, mutations = 0;
  await page.route(`**/local/conversations/${data.primary.id}/agents`, route => {
    collectionReads++;
    return route.fulfill({ status: 503, json: { error: "PRIVATE_COLLECTION_ERROR" } });
  });
  page.on("request", request => {
    if (request.method() === "GET" && new RegExp(`/local/conversations/${data.primary.id}/agents/[^/]+$`).test(new URL(request.url()).pathname)) individualReads++;
    if (request.method() !== "GET" && request.url().includes(`/local/conversations/${data.primary.id}/`)) mutations++;
  });
  await launch(page, request, data);
  await expect.poll(() => collectionReads).toBeGreaterThan(0);
  for (const [participant, status] of [[data.agent, "Idle"], [other, "Not started"]] as const) {
    const modal = await details(page, participant.displayName!);
    await expect(modal.getByRole("region", { name: "Status freshness" })).toContainText("Status unavailable");
    await modal.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect(modal.getByRole("region", { name: "Status freshness" })).toContainText(status);
    await modal.getByRole("button", { name: "Close participant details" }).click();
  }
  await page.getByRole("button", { name: `Open actions for ${other.displayName}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Start agent", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  const first = await details(page, data.agent.displayName!);
  await expect(first.getByRole("region", { name: "Status freshness" })).toContainText("Idle");
  expect(individualReads).toBe(2);
  expect(mutations).toBe(0);
  await expect(page.locator("body")).not.toContainText("PRIVATE_COLLECTION_ERROR");
});

for (const [status, label] of [[401, "Local browser session is missing or expired"], [502, "Local control status request failed (HTTP 502)"]] as const) {
  test(`explains an initial HTTP ${status} status failure safely and recovers one participant`, async ({ page, request }) => {
    const data = await fixture(request);
    await page.route(`**/local/conversations/${data.primary.id}/agents`, route => route.fulfill({ status, json: { error: "PRIVATE_STATUS_ERROR_MUST_NOT_RENDER" } }));
    await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}`, route => route.fulfill({ json: { agent: agentView(data) } }));
    await launch(page, request, data);
    const sidebar = page.getByRole("complementary", { name: "Participants sidebar" });
    await expect(sidebar).toContainText(label);
    const modal = await details(page, data.agent.displayName!);
    await expect(modal).not.toContainText("PRIVATE_STATUS_ERROR_MUST_NOT_RENDER");
    await modal.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect(modal.getByRole("region", { name: "Status freshness" })).toContainText("Idle");
    await modal.getByRole("button", { name: "Close participant details" }).click();
    await expect(sidebar).not.toContainText("Runtime status unavailable");
  });
}
