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
    json: { protocolVersion: 18, conversationId: data.primary.id, agents: [{ ...view(), runtimeSessionId: "PRIVATE_SESSION_MUST_NOT_RENDER" }] },
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
    await expect(memberModal.getByRole("region", { name: "Participant diagnostics" })).toHaveCount(0);
    await expect(memberModal.getByRole("region", { name: "Status freshness" })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "New session with context", exact: true })).toHaveCount(0);
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

function requestGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function inspectionAgents(page: Page, data: Fixture, view: () => LocalConversationAgent) {
  const other = { ...data.agent, id: "diagnostics-other-agent", handle: "inspector", displayName: "Inspection Agent" };
  await page.route(`**/conversations/${data.primary.id}`, (route) => route.fulfill({
    json: { conversation: { ...data.primary, participants: [...data.primary.participants, other] } },
  }));
  await page.route(`**/local/conversations/${data.primary.id}/agents`, (route) => route.fulfill({
    json: { protocolVersion: 18, conversationId: data.primary.id, agents: [view(), { ...agentView(data, "unbound"), identityId: other.id }] },
  }));
  return other;
}

const pendingScenarios = [
  { label: "Start agent", state: "unbound", endpoint: "start" },
  { label: "Start agent", state: "stopped", endpoint: "start" },
  { label: "Fresh session", state: "unbound", endpoint: "start", confirmation: "Start a fresh session for", mobile: true },
  { label: "Reconnect", state: "disconnected", endpoint: "reconnect", minimized: true },
  { label: "New session with context", state: "idle", endpoint: "replace", confirmation: "Start a new session with context for" },
  { label: "Fresh session", state: "idle", endpoint: "replace", confirmation: "Start a fresh session for" },
  { label: "Stop agent", state: "running", endpoint: "stop", confirmation: "Stop", closeFirst: true },
  { label: "Cancel current", state: "running", endpoint: "cancel-current" },
  { label: "Stop agent", state: "running", endpoint: "stop", confirmation: "Stop", fail: true },
] satisfies Array<{ label: string; state: LocalConversationAgent["state"]; endpoint: string; confirmation?: string; mobile?: boolean; minimized?: boolean; closeFirst?: boolean; fail?: boolean }>;

for (const scenario of pendingScenarios) {
  test(`inspects self and others during pending ${scenario.label} from ${scenario.state}${scenario.fail ? " with late failure" : ""}`, async ({ page, request }) => {
    if (scenario.mobile) await page.setViewportSize({ width: 390, height: 844 });
    const data = await fixture(request);
    let view = agentView(data, scenario.state);
    view.capabilities = { start: scenario.state === "unbound" || scenario.state === "stopped", replace: scenario.state !== "unbound", stop: true, interrupt: true, reconnect: true, steer: false };
    const other = await inspectionAgents(page, data, () => view);
    const gate = requestGate();
    let calls = 0;
    await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}/${scenario.endpoint}`, async (route) => {
      calls += 1;
      await gate.promise;
      if (scenario.fail) return route.fulfill({ status: 503, json: { error: "Delayed diagnostic action failure" } });
      view = { ...view, state: scenario.endpoint === "stop" ? "stopped" : "idle" };
      await route.fulfill({ json: { agent: view } });
    });
    try {
      await launch(page, request, data);
      if (scenario.mobile) await page.getByRole("button", { name: "Show participants" }).click();
      if (scenario.minimized) await page.getByRole("button", { name: "Minimize participants" }).click();
      const trigger = page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true });
      await trigger.click();
      const actionButton = page.getByRole("button", { name: scenario.label, exact: true });
      if (scenario.label === "Start agent") {
        // Two synchronous activations must not outrun React's pending-state render.
        await actionButton.evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      } else {
        await actionButton.click();
      }
      if (scenario.confirmation) {
        const confirmation = page.getByRole("dialog", { name: `${scenario.confirmation} ${data.agent.displayName}?`, exact: true });
        await confirmation.getByRole("button", { name: scenario.label, exact: true }).evaluate((button) => {
          (button as HTMLButtonElement).click();
          (button as HTMLButtonElement).click();
        });
        await expect(confirmation.getByRole("button", { name: scenario.label, exact: true })).toBeDisabled();
        await expect(confirmation).toContainText("Closing this dialog does not cancel the operation");
        if (scenario.closeFirst) {
          await confirmation.getByRole("button", { name: "Close", exact: true }).click();
          await expect(trigger).toBeFocused();
        } else {
          await confirmation.getByRole("button", { name: "View diagnostics", exact: true }).click();
        }
      }
      await expect.poll(() => calls).toBe(1);
      let modal = page.getByRole("dialog", { name: `Details for ${data.agent.displayName}`, exact: true });
      if (!scenario.confirmation || scenario.closeFirst) modal = await details(page, data.agent.displayName!);
      await expect(modal.getByRole("region", { name: "Pending participant action" })).toContainText(scenario.label);
      await expect(modal).toContainText("host acceptance and progress are not verified");
      await expect(modal.getByRole("region", { name: "Status freshness" })).toContainText("Status snapshot received");
      await expect(modal.getByRole("button", { name: "Close participant details" })).toBeFocused();
      await modal.getByRole("button", { name: "Close participant details" }).click();
      await expect(trigger).toBeFocused();
      await trigger.press("Enter");
      await expect(page.getByRole("button", { name: scenario.label, exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Details & diagnostics", exact: true })).toBeEnabled();
      await page.keyboard.press("Escape");
      const otherModal = await details(page, other.displayName!);
      await expect(otherModal.getByRole("region", { name: "Pending participant action" })).toHaveCount(0);
      await otherModal.getByRole("button", { name: "Close participant details" }).click();
      await page.getByRole("button", { name: `Open actions for ${other.displayName}`, exact: true }).click();
      await expect(page.getByRole("button", { name: "Start agent", exact: true })).toBeDisabled();
      await page.keyboard.press("Escape");
      modal = await details(page, data.agent.displayName!);
      gate.release();
      await expect(modal.getByRole("region", { name: "Pending participant action" })).toHaveCount(0);
      await expect(modal).toBeVisible();
      if (scenario.fail) await expect(modal.getByRole("region", { name: "Failed participant action" })).toContainText("Delayed diagnostic action failure");
      expect(calls).toBe(1);
    } finally {
      gate.release();
    }
  });
}

for (const action of ["start", "stop"] as const) {
  test(`inspects targeted and other participants during pending bulk ${action}`, async ({ page, request }) => {
    if (action === "stop") await page.setViewportSize({ width: 390, height: 844 });
    const data = await fixture(request);
    let view = agentView(data, action === "start" ? "stopped" : "idle");
    view.capabilities = { ...view.capabilities, start: action === "start", stop: action === "stop" };
    const other = await inspectionAgents(page, data, () => view);
    const gate = requestGate();
    let calls = 0;
    await page.route(`**/local/conversations/${data.primary.id}/agents/${action}-all`, async (route) => {
      calls += 1;
      await gate.promise;
      view = { ...view, state: action === "start" ? "idle" : "stopped" };
      await route.fulfill({ json: { protocolVersion: 18, conversationId: data.primary.id, results: [{ identityId: data.agent.id, outcome: action === "start" ? "started" : "stopped" }] } });
    });
    try {
      await launch(page, request, data);
      if (action === "stop") await page.getByRole("button", { name: "Show participants" }).click();
      await page.getByRole("button", { name: "Open participant actions" }).click();
      await page.getByRole("button", { name: action === "start" ? /^Start eligible agents/ : /^Stop active agents/ }).click();
      if (action === "stop") {
        const confirmation = page.getByRole("dialog", { name: "Stop active agents?", exact: true });
        await confirmation.getByRole("button", { name: "Stop active agents", exact: true }).click();
        await expect(confirmation.getByRole("button", { name: "Stop active agents", exact: true })).toBeDisabled();
        await confirmation.getByRole("button", { name: "View diagnostics", exact: true }).click();
      } else {
        await details(page, data.agent.displayName!);
      }
      const modal = page.getByRole("dialog", { name: `Details for ${data.agent.displayName}`, exact: true });
      await expect(modal.getByRole("region", { name: "Pending participant action" })).toContainText(`Bulk ${action === "start" ? "Start eligible" : "Stop active"} agents`);
      await modal.getByRole("button", { name: "Close participant details" }).click();
      await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
      await expect(page.getByRole("button", { name: action === "start" ? "Start agent" : "Stop agent", exact: true })).toBeDisabled();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: `Open actions for ${other.displayName}`, exact: true }).click();
      await expect(page.getByRole("button", { name: "Start agent", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Details & diagnostics", exact: true }).click();
      const otherModal = page.getByRole("dialog", { name: `Details for ${other.displayName}`, exact: true });
      if (action === "start") await expect(otherModal.getByRole("region", { name: "Pending participant action" })).toContainText("Bulk Start eligible agents");
      else await expect(otherModal.getByRole("region", { name: "Pending participant action" })).toHaveCount(0);
      await otherModal.getByRole("button", { name: "Close participant details" }).click();
      await details(page, data.agent.displayName!);
      gate.release();
      await expect(modal.getByRole("region", { name: "Pending participant action" })).toHaveCount(0);
      await expect(modal).toBeVisible();
      expect(calls).toBe(1);
    } finally {
      gate.release();
    }
  });
}

test("freshness preserves the received snapshot after a failed refresh and does not invent an exact queue", async ({ page, request }) => {
  const data = await fixture(request);
  let fail = false;
  let reads = 0;
  const view = agentView(data);
  view.diagnostics = { ...view.diagnostics!, queuedTurns: 0, queuedTurnsExact: false };
  await page.route(`**/local/conversations/${data.primary.id}/agents`, (route) => {
    reads += 1;
    return fail ? route.fulfill({ status: 503, json: { error: "Status unavailable" } })
      : route.fulfill({ json: { protocolVersion: 18, conversationId: data.primary.id, agents: [view] } });
  });
  await page.clock.install();
  await launch(page, request, data);
  const modal = await details(page, data.agent.displayName!);
  const snapshotTime = modal.getByRole("region", { name: "Status freshness" }).locator("time");
  const initialTimestamp = await snapshotTime.getAttribute("datetime");
  // install() keeps ticking during navigation/locator waits. Pause only after
  // bootstrap, let the resulting normal poll settle, then measure a known window.
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 60_000));
  await expect.poll(async () => {
    // Query's async response notification needs a timer tick even with time paused.
    await page.clock.runFor(1);
    return snapshotTime.getAttribute("datetime");
  }).not.toBe(initialTimestamp);
  await modal.getByRole("button", { name: "Close participant details" }).click();
  const beforeOpen = reads;
  await details(page, data.agent.displayName!);
  const timestamp = await snapshotTime.getAttribute("datetime");
  await expect(modal.getByRole("region", { name: "Participant diagnostics" })).toContainText("Checking backlog");
  await expect(modal.getByRole("region", { name: "Participant diagnostics" })).not.toContainText("0 queued");
  await page.clock.fastForward(4_000);
  expect(reads).toBe(beforeOpen);
  fail = true;
  await page.clock.resume();
  await modal.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(modal.getByRole("region", { name: "Status freshness" })).toContainText("Latest status refresh failed");
  await expect(modal.getByRole("region", { name: "Status freshness" }).locator("time")).toHaveAttribute("datetime", timestamp!);
  await expect(modal.getByRole("region", { name: "Runtime details" })).toContainText("Idle");
  await expect(modal).toContainText("current Runtime state is not verified");
  // Normal polling may also run while real-time locator waits are resumed.
  expect(reads).toBeGreaterThan(beforeOpen);
  fail = false;
  await modal.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(modal).not.toContainText("Latest status refresh failed");
});

test("pending timing advances locally and status refresh never repeats the mutation", async ({ page, request }) => {
  const data = await fixture(request);
  await page.clock.install();
  await mockAgent(page, data, () => agentView(data, "unbound"));
  const gate = requestGate();
  let calls = 0;
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}/start`, async (route) => {
    calls += 1;
    await gate.promise;
    await route.fulfill({ json: { agent: agentView(data) } });
  });
  try {
    await launch(page, request, data);
    await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
    await page.getByRole("button", { name: "Start agent", exact: true }).click();
    const modal = await details(page, data.agent.displayName!);
    await page.clock.fastForward(2_100);
    await expect(modal.getByRole("region", { name: "Pending participant action" })).toContainText("2s");
    await modal.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect(modal.getByRole("region", { name: "Pending participant action" })).toBeVisible();
    expect(calls).toBe(1);
  } finally {
    gate.release();
  }
});

test("a late dismissed operation failure cannot close diagnostics in the next Conversation", async ({ page, request }) => {
  const data = await fixture(request);
  const view = agentView(data);
  view.capabilities.stop = true;
  await mockAgent(page, data, () => view);
  const gate = requestGate();
  const path = `/local/conversations/${data.primary.id}/agents/${data.agent.id}/stop`;
  await page.route(`**${path}`, async (route) => {
    await gate.promise;
    await route.fulfill({ status: 503, json: { error: "Previous Conversation Stop failed" } });
  });
  try {
    await launch(page, request, data);
    await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
    await page.getByRole("button", { name: "Stop agent", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: `Stop ${data.agent.displayName}?`, exact: true });
    await confirmation.getByRole("button", { name: "Stop agent", exact: true }).click();
    await confirmation.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("link", { name: new RegExp(`^${data.alternate.name}`) }).first().click();
    await expect(page.getByRole("heading", { name: `#${data.alternate.name}`, exact: true })).toBeVisible();
    const modal = await details(page, data.agent.displayName!);
    const response = page.waitForResponse((incoming) => incoming.url().endsWith(path));
    gate.release();
    await response;
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("region", { name: "Failed participant action" })).toHaveCount(0);
    await expect(modal.getByRole("region", { name: "Pending participant action" })).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Close participant details" })).toBeFocused();
  } finally {
    gate.release();
  }
});

test("a dismissed bulk Stop failure remains inspectable without reopening confirmation", async ({ page, request }) => {
  const data = await fixture(request);
  await mockAgent(page, data, () => agentView(data));
  const gate = requestGate();
  await page.route(`**/local/conversations/${data.primary.id}/agents/stop-all`, async (route) => {
    await gate.promise;
    await route.fulfill({ status: 503, json: { error: "Delayed bulk Stop failure" } });
  });
  try {
    await launch(page, request, data);
    await page.getByRole("button", { name: "Open participant actions" }).click();
    await page.getByRole("button", { name: /^Stop active agents/ }).click();
    const confirmation = page.getByRole("dialog", { name: "Stop active agents?", exact: true });
    await confirmation.getByRole("button", { name: "Stop active agents", exact: true }).click();
    await confirmation.getByRole("button", { name: "View diagnostics", exact: true }).click();
    const modal = page.getByRole("dialog", { name: `Details for ${data.agent.displayName}`, exact: true });
    await expect(modal.getByRole("button", { name: "Close participant details" })).toBeFocused();
    gate.release();
    await expect(modal.getByRole("region", { name: "Failed participant action" })).toContainText("Conversation-wide bulk request failed: Delayed bulk Stop failure");
    await expect(modal).toBeVisible();
    await expect(confirmation).toHaveCount(0);
  } finally {
    gate.release();
  }
});

for (const [status, label] of [
  [401, "Local browser session is missing or expired"],
  [502, "Local control status request failed (HTTP 502)"],
] as const) {
  test(`explains an initial HTTP ${status} status failure safely and recovers on refresh`, async ({ page, request }) => {
    const data = await fixture(request);
    let fail = true;
    await page.route(`**/local/conversations/${data.primary.id}/agents`, (route) => fail
      ? route.fulfill({ status, json: { error: "PRIVATE_STATUS_ERROR_MUST_NOT_RENDER" } })
      : route.fulfill({ json: { protocolVersion: 18, conversationId: data.primary.id, agents: [agentView(data)] } }));
    await launch(page, request, data);
    const sidebar = page.getByRole("complementary", { name: "Participants sidebar" });
    await expect(sidebar).toContainText(label);
    await expect(sidebar).toContainText("Runtime status unavailable");
    const modal = await details(page, data.agent.displayName!);
    await expect(modal.getByRole("region", { name: "Status freshness" })).toContainText(label);
    await expect(modal).not.toContainText("PRIVATE_STATUS_ERROR_MUST_NOT_RENDER");
    fail = false;
    await modal.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect(modal.getByRole("region", { name: "Runtime details" })).toContainText("Idle");
    await expect(modal).not.toContainText(label);
    await modal.getByRole("button", { name: "Close participant details" }).click();
    await expect(sidebar).not.toContainText("Runtime status unavailable");
  });
}
