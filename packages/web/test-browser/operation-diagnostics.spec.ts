import { openParticipantSection } from "./participant-menu";
import type { LocalAgentDiagnosticReport, LocalAgentOperationDetail, LocalAgentOperationHistory, LocalAgentSessionInspection, LocalAgentSessionEvents, LocalAgentDeliveryTrails } from "@minu/channels-control/contracts";
import type { ConversationMetadata, WorkspaceMember } from "@minu/channels-core/types";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mockActionRequests } from "./agent-action-fixtures";

const conversationsBase = `http://127.0.0.1:${process.env.MINU_TEST_CHANNELS_PORT ?? 58410}`;
const fixtureBase = `http://127.0.0.1:${process.env.MINU_TEST_FIXTURE_PORT ?? 58413}`;
async function fixture(request: APIRequestContext) {
  const { workspaces } = await (await request.get(`${conversationsBase}/workspaces`)).json();
  const workspaceId = workspaces.find((item: { name: string }) => item.name === "Browser Test").id as string;
  const { conversations } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/conversations`)).json() as { conversations: ConversationMetadata[] };
  const primary = conversations.find(({ name }) => name === "browser-collaboration")!;
  const alternate = conversations.find(({ name }) => name === "alternate-collaboration")!;
  const { conversation } = await (await request.get(`${conversationsBase}/conversations/${primary.id}`)).json() as { conversation: ConversationMetadata };
  const { members } = await (await request.get(`${conversationsBase}/workspaces/${workspaceId}/members`)).json() as { members: WorkspaceMember[] };
  return { workspaceId, primary: conversation, alternate, members, ownerId: members.find(({ accessRole }) => accessRole === "owner")!.identityId, agent: conversation.participants.find(({ handle }) => handle === "builder")! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function launch(page: Page, request: APIRequestContext, data: Fixture, actor = "owner") {
  const destination = `/app/workspaces/${data.workspaceId}/conversations/${data.primary.id}`;
  const { launchUrl } = await (await request.get(`${fixtureBase}/control-launch?destination=${encodeURIComponent(destination)}&actor=${actor}`)).json();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: `#${data.primary.name}`, exact: true })).toBeVisible();
}
async function open(page: Page, data: Fixture) {
  await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
  await openParticipantSection(page, "Inspect");
  const link = page.getByRole("menuitem", { name: "Diagnostics", exact: true });
  if (await link.count()) await link.click();
  else await page.goto(`/app/workspaces/${data.workspaceId}/conversations/${data.primary.id}/participants/${data.agent.id}/diagnostics`);
  return page.getByRole("main", { name: "Participant diagnostics", exact: true });
}
function history(data: Fixture): LocalAgentOperationHistory {
  return {
    protocolVersion: 24, conversationId: data.primary.id, participantIdentityId: data.agent.id, capturedAt: "2026-10-01T10:00:00.000Z", coverage: "available", recordingGap: true,
    nextCursor: "2:2", retention: { days: 7, terminalLimit: 1_000, eventLimit: 128 },
    operations: [{ operationId: "selected-stop", conversationId: data.primary.id, participantIdentityId: data.agent.id, action: "stop", requestedAt: "2026-10-01T09:59:00.000Z", acceptedAt: "2026-10-01T09:59:00.000Z", outcome: "unknown", requestDisposition: "handler_failed", observedAt: "2026-10-01T09:59:01.000Z", closedAt: "2026-10-01T09:59:01.000Z", elapsedMs: 1_000, eventsDropped: 1, recordingGap: true, lastConfirmedStage: "delivery_fenced" }],
  };
}
function detail(data: Fixture, operationId = "selected-stop"): LocalAgentOperationDetail {
  return { protocolVersion: 24, conversationId: data.primary.id, participantIdentityId: data.agent.id, capturedAt: "2026-10-01T10:00:00.000Z", coverage: "available", detail: {
    operation: { ...history(data).operations[0]!, operationId, ...(operationId === "parent" ? {
      action: "bulk_stop", participantIdentityId: data.ownerId,
      bulk: { targets: 4, completed: 3, started: 0, stopped: 1, skipped: 1, failed: 1, unknown: 1, childrenUnrecorded: 1, childrenUnavailable: 2 },
    } : { bulkTarget: { outcome: "failed", reason: "uncertain" } }) },
    events: [
      { sequence: 1, observedAt: "2026-10-01T09:59:00.000Z", elapsedMs: 0, source: "agent_host", stage: "delivery_fenced", result: "confirmed" },
      { sequence: 3, observedAt: "2026-10-01T09:59:01.000Z", elapsedMs: 1_000, source: "relay", stage: "interrupt_requested", result: "unknown", reasonCode: "uncertain", triggerSequence: 1 },
    ],
  }, relations: operationId === "selected-stop" ? [{ kind: "bulk_parent", operationId: "parent" }] : [], failuresUnavailable: false,
  failures: [{ triggerSequence: 1, participant: { identityId: data.agent.id, displayLabel: "Builder Agent" }, causeCategory: "runtime_request_timeout", failedAt: "2026-10-01T09:59:01.000Z", elapsedMs: 1_000, attemptCount: 1, deliveryOutcome: "pending", remediation: { code: "retry_request", label: "Retry request" }, operationRelation: "targeted_trigger" }] };
}
function report(data: Fixture, count = 1): LocalAgentDiagnosticReport {
  return { formatVersion: 1, protocolVersion: 24, conversationId: data.primary.id, capturedAt: `capture-${count}`, participant: { identityId: data.agent.id, displayLabel: '<img src=x onerror="window.DIAGNOSTIC_XSS=true">', availability: "current" }, selected: detail(data), coverage: { snapshotUnavailable: true, truncated: true, notes: ["Snapshot unavailable; timeline clipped"] } };
}
function inspection(data: Fixture): LocalAgentSessionInspection {
  return { protocolVersion: 24, conversationId: data.primary.id, participantIdentityId: data.agent.id, capturedAt: "2026-10-01T10:00:00.000Z", availability: "available",
    recorded: { bindingState: "paused", origin: "started", adapter: "pi", contextMode: "fresh", activationSequence: 999999, activatedAt: "2026-10-01T09:00:00.000Z" },
    running: { status: "available", profile: { version: 1, capturedAt: "2026-10-01T10:00:00.000Z",
      model: { status: "verified", provider: "provider", id: "running-model" }, reasoning: { status: "verified", level: "low" },
      skills: { status: "verified", commandIds: ["skill:live"], complete: true } } },
    saved: { status: "available", profile: { adapter: "pi", model: { provider: "provider", id: "future-model" }, reasoningLevel: "high",
      skills: { selection: "explicit", ids: ["future-skill"], complete: true } } },
    latestStart: "not_verified", lastStopBoundary: "not_recorded" };
}
function runtimeEvents(data: Fixture): LocalAgentSessionEvents {
  return { protocolVersion: 24, conversationId: data.primary.id, participantIdentityId: data.agent.id, capturedAt: "2026-10-01T10:00:00.000Z", availability: "available",
    snapshot: { version: 1, source: "runtime_bridge", capturedAt: "2026-10-01T10:00:00.000Z", recordingSince: "2026-10-01T09:00:00.000Z", eventsDropped: 0,
      events: [{ sequence: 1, observedAt: "2026-10-01T09:59:00.000Z", code: "turn_accepted" }, { sequence: 2, observedAt: "2026-10-01T09:59:01.000Z", code: "turn_dispatch_requested" }] } };
}
function deliveryTrails(data: Fixture): LocalAgentDeliveryTrails {
  const selected = { trailId: "trail-selected", triggerSequence: 1, startedAt: "2026-10-01T09:59:00.000Z", observedAt: "2026-10-01T10:00:00.000Z", closedAt: "2026-10-01T10:00:00.000Z", outcome: "delivered" as const,
    eventsDropped: 0, recordingGap: false, events: [{ sequence: 1, stage: "runtime_completed" as const, observedAt: "2026-10-01T09:59:59.000Z", elapsedMs: 59000 }, { sequence: 2, stage: "response_committed" as const, observedAt: "2026-10-01T10:00:00.000Z", elapsedMs: 60000, kind: "reply" as const, responseSequence: 2 }] };
  return { protocolVersion: 24, conversationId: data.primary.id, participantIdentityId: data.agent.id, capturedAt: "2026-10-01T10:00:00.000Z", availability: "available",
    retention: { days: 7, terminalLimit: 1000, eventLimit: 16 }, history: { trails: [selected], nextCursor: "2:2", recordingGap: false }, selected };
}
async function mocks(page: Page, data: Fixture) {
  const counts = { history: 0, detail: 0, report: 0, inspection: 0, events: 0, trails: 0, mutations: 0 };
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}/delivery-trails*`, route => {
    counts.trails++;
    const value = deliveryTrails(data);
    return route.fulfill({ json: new URL(route.request().url()).searchParams.has("cursor") ? { ...value, history: { trails: [], recordingGap: false }, selected: undefined } : value });
  });
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}/session-events`, route => { counts.events++; return route.fulfill({ json: runtimeEvents(data) }); });
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}/session-inspection`, route => { counts.inspection++; return route.fulfill({ json: inspection(data) }); });
  page.on("request", (request) => { if (request.method() !== "GET" && /\/local\/conversations\//.test(request.url())) counts.mutations++; });
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}/operations?*`, (route) => {
    counts.history++;
    return route.fulfill({ json: { ...history(data), operations: [], nextCursor: undefined } });
  });
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}/operations`, (route) => { counts.history++; return route.fulfill({ json: history(data) }); });
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}/operations/*`, (route) => { counts.detail++; return route.fulfill({ json: detail(data, new URL(route.request().url()).pathname.split("/").at(-1)) }); });
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}/diagnostic-report?*`, (route) => { counts.report++; return route.fulfill({ json: report(data, counts.report) }); });
  return counts;
}
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

for (const mobile of [false, true]) test(`message delivery is advanced-only, explicit and keyboard accessible (${mobile ? "mobile" : "desktop"})`, async ({ page, request }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const data = await fixture(request), counts = await mocks(page, data); await launch(page, request, data);
  await expect(page.getByRole("region", { name: "Message delivery", exact: true })).toHaveCount(0); expect(counts.trails).toBe(0);
  if (mobile) await page.getByRole("button", { name: "Show participants" }).click();
  const modal = await open(page, data), region = modal.getByRole("region", { name: "Message delivery", exact: true });
  await expect(region.getByRole("button", { name: "Show message trails" })).toBeEnabled(); expect(counts.trails).toBe(0);
  await region.getByRole("button", { name: "Show message trails" }).focus(); await page.keyboard.press("Enter");
  await expect(region.getByRole("region", { name: "Selected message delivery" })).toContainText("Public response commit acknowledged");
  await expect(region).toContainText("Retention days: 7"); await expect(region).toContainText("Completed-trail limit: 1000");
  await region.getByRole("button", { name: "Refresh message trails" }).click(); await expect.poll(() => counts.trails).toBe(2);
  await modal.getByRole("button", { name: "Preview report" }).click(); await expect(modal.locator('[aria-label="Report preview"]')).not.toContainText("trail-selected");
  await region.getByRole("button", { name: "Older message trails" }).click(); await expect(region).toContainText("Not recorded");
  await region.getByRole("button", { name: "Latest message trails" }).click(); await expect(region).toContainText("Public response commit acknowledged");
  await region.getByRole("button", { name: "Hide message trails" }).click(); await expect(region.getByRole("list")).toHaveCount(0);
  const before = counts.trails; await page.clock.install(); await page.clock.fastForward(15000); expect(counts.trails).toBe(before); expect(counts.mutations).toBe(0);
});

test("message trail close/navigation fences a delayed response without shared storage", async ({ page, request }) => {
  const data = await fixture(request); await mocks(page, data); const pending = gate(); let entered = false;
  await page.route(`**/agents/${data.agent.id}/delivery-trails*`, async route => { entered = true; await pending.promise; await route.fulfill({ json: deliveryTrails(data) }).catch(() => {}); });
  try {
    await launch(page, request, data); const modal = await open(page, data);
    await modal.getByRole("button", { name: "Show message trails" }).click(); await expect.poll(() => entered).toBe(true);
    await modal.getByRole("link", { name: "Back to conversation", exact: true }).click();
    await page.getByRole("link", { name: new RegExp(`^${data.alternate.name}`) }).first().click(); await expect(page.getByRole("heading", { name: `#${data.alternate.name}`, exact: true })).toBeVisible();
    pending.release(); await expect(page.getByRole("list", { name: "Message delivery observations" })).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => /delivery.?trails/i.test(key)))).toBe(false);
  } finally { pending.release(); }
});

test("message trail read errors, session changes and server denial discard stale evidence", async ({ page, request }) => {
  const data = await fixture(request); await mocks(page, data); await launch(page, request, data); const modal = await open(page, data);
  const region = modal.getByRole("region", { name: "Message delivery", exact: true }); await region.getByRole("button", { name: "Show message trails" }).click();
  await expect(region).toContainText("Public response commit acknowledged");
  await page.route(`**/agents/${data.agent.id}/delivery-trails*`, route => route.fulfill({ status: 503, json: { error: "PRIVATE_TRAIL_ERROR" } }));
  await region.getByRole("button", { name: "Refresh message trails" }).click(); await expect(region.getByRole("alert")).toHaveText("Unavailable"); await expect(region.getByRole("list")).toHaveCount(0);
  await expect(modal).not.toContainText("PRIVATE_TRAIL_ERROR");
  await page.route(`**/agents/${data.agent.id}/delivery-trails*`, route => route.fulfill({ json: { ...deliveryTrails(data), availability: "changed", history: undefined, selected: undefined } }));
  await region.getByRole("button", { name: "Refresh message trails" }).click(); await expect(region).toContainText("Changed during read");
  await page.route(`**/agents/${data.agent.id}/delivery-trails*`, route => route.fulfill({ status: 404, json: { error: "PRIVATE_TRAIL_ERROR" } }));
  await region.getByRole("button", { name: "Refresh message trails" }).click(); await expect(modal.getByRole("region", { name: "Operation history", exact: true })).toHaveCount(0);
});

for (const mobile of [false, true]) test(`recent Runtime events are explicit, read-only and keyboard accessible (${mobile ? "mobile" : "desktop"})`, async ({ page, request }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const data = await fixture(request), counts = await mocks(page, data);
  await launch(page, request, data); expect(counts.events).toBe(0);
  if (mobile) await page.getByRole("button", { name: "Show participants" }).click();
  const modal = await open(page, data);
  const region = modal.getByRole("region", { name: "Recent Runtime events", exact: true });
  const show = region.getByRole("button", { name: "Show events", exact: true });
  await expect(show).toBeEnabled(); expect(counts.events).toBe(0);
  await show.focus(); await page.keyboard.press("Enter");
  await expect(region.getByRole("list", { name: "Runtime observations" })).toContainText("Dispatch requested");
  await expect(region).toContainText("Window since: 2026-10-01T09:00:00.000Z");
  await expect(region).toContainText("Events evicted: 0");
  expect(counts.events).toBe(1);
  await region.getByRole("button", { name: "Refresh events" }).click();
  await expect.poll(() => counts.events).toBe(2);
  await modal.getByRole("button", { name: "Preview report" }).click();
  await expect(modal.locator('[aria-label="Report preview"]')).not.toContainText("runtime_bridge");
  await region.getByRole("button", { name: "Hide events" }).click();
  await expect(region.getByRole("list")).toHaveCount(0);
  await page.clock.install(); await page.clock.fastForward(15000);
  expect(counts.events).toBe(2); expect(counts.mutations).toBe(0);
  await region.getByRole("button", { name: "Show events" }).click();
  await expect.poll(() => counts.events).toBe(3);
  await modal.getByRole("link", { name: "Back to conversation", exact: true }).click();
  await page.clock.fastForward(15000); expect(counts.events).toBe(3);
});

test("closing and navigating fences delayed event reads without retaining a private cache", async ({ page, request }) => {
  const data = await fixture(request); await mocks(page, data);
  const pending = gate(); let entered = false;
  await page.route(`**/agents/${data.agent.id}/session-events`, async route => { entered = true; await pending.promise; await route.fulfill({ json: runtimeEvents(data) }).catch(() => {}); });
  try {
    await launch(page, request, data); const modal = await open(page, data);
    await modal.getByRole("button", { name: "Show events", exact: true }).click();
    await expect.poll(() => entered).toBe(true);
    await modal.getByRole("button", { name: "Hide events" }).click();
    await expect(modal.getByRole("list", { name: "Runtime observations" })).toHaveCount(0);
    await modal.getByRole("link", { name: "Back to conversation", exact: true }).click();
    await page.getByRole("link", { name: new RegExp(`^${data.alternate.name}`) }).first().click();
    await expect(page.getByRole("heading", { name: `#${data.alternate.name}`, exact: true })).toBeVisible();
    pending.release();
    await expect(page.getByRole("list", { name: "Runtime observations" })).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => /runtime.?events/i.test(key)))).toBe(false);
  } finally { pending.release(); }
});

test("event errors and observed session replacement clear earlier observations", async ({ page, request }) => {
  const data = await fixture(request); await mocks(page, data); await launch(page, request, data);
  const modal = await open(page, data), region = modal.getByRole("region", { name: "Recent Runtime events", exact: true });
  await region.getByRole("button", { name: "Show events" }).click();
  await expect(region).toContainText("Turn accepted");
  await page.route(`**/agents/${data.agent.id}/session-inspection`, route => route.fulfill({ json: { ...inspection(data), recorded: { ...inspection(data).recorded, activatedAt: "2026-10-01T11:00:00.000Z" } } }));
  await modal.getByRole("button", { name: "Refresh session" }).click();
  await expect(region.getByRole("list")).toHaveCount(0); await expect(region.getByRole("button", { name: "Show events" })).toBeVisible();
  await region.getByRole("button", { name: "Show events" }).click(); await expect(region).toContainText("Turn accepted");
  await page.route(`**/agents/${data.agent.id}/session-events`, route => route.fulfill({ status: 503, json: { error: "PRIVATE_EVENT_ERROR" } }));
  await region.getByRole("button", { name: "Refresh events" }).click();
  await expect(region.getByRole("alert")).toHaveText("Unavailable"); await expect(region.getByRole("list")).toHaveCount(0);
  await expect(modal).not.toContainText("PRIVATE_EVENT_ERROR");
  await page.route(`**/agents/${data.agent.id}/session-events`, route => route.fulfill({ json: { ...runtimeEvents(data), availability: "changed", snapshot: undefined } }));
  await region.getByRole("button", { name: "Refresh events" }).click(); await expect(region).toContainText("Changed during read");
  await page.route(`**/agents/${data.agent.id}/session-events`, route => route.fulfill({ status: 404, json: { error: "PRIVATE_EVENT_ERROR" } }));
  await region.getByRole("button", { name: "Refresh events" }).click();
  await expect(modal.getByRole("region", { name: "Operation history", exact: true })).toHaveCount(0);
});

test("event labels are curated, timestamps are literal text and empty/clipped windows stay explicit", async ({ page, request }) => {
  const data = await fixture(request); await mocks(page, data);
  await page.route(`**/agents/${data.agent.id}/session-events`, route => route.fulfill({ json: { ...runtimeEvents(data), snapshot: { ...runtimeEvents(data).snapshot,
    eventsDropped: 7, events: [{ sequence: 8, observedAt: '<img src=x onerror="window.EVENT_XSS=true">', code: "<script>SECRET</script>" }] } } }));
  await launch(page, request, data); const modal = await open(page, data);
  const region = modal.getByRole("region", { name: "Recent Runtime events", exact: true });
  await region.getByRole("button", { name: "Show events" }).click();
  await expect(region).toContainText("Events evicted: 7"); await expect(region).toContainText("<img src=x");
  await expect(region).not.toContainText("SECRET"); expect(await page.evaluate(() => (window as unknown as { EVENT_XSS?: boolean }).EVENT_XSS)).toBeUndefined();
  expect(await region.locator("img,script").count()).toBe(0);
  await page.route(`**/agents/${data.agent.id}/session-events`, route => route.fulfill({ json: { ...runtimeEvents(data), snapshot: { ...runtimeEvents(data).snapshot, eventsDropped: 0, events: [] } } }));
  await region.getByRole("button", { name: "Refresh events" }).click(); await expect(region).toContainText("No retained events");
});

test("session inspection is open-only and separates recorded, observed and future evidence without mutations", async ({ page, request }) => {
  const data = await fixture(request); const counts = await mocks(page, data);
  await launch(page, request, data); expect(counts.inspection).toBe(0);
  const modal = await open(page, data);
  const session = modal.getByRole("region", { name: "Session and context", exact: true });
  await expect(session).toContainText("Recorded context policy: Fresh");
  await expect(session).toContainText("Last Stop boundary: Not recorded");
  await expect(session).toContainText("Latest Start behavior: Not verified");
  await expect(session).toContainText("Activation boundary message #999999 is not in loaded history");
  const live = session.getByRole("region", { name: "Observed running profile", exact: true });
  const future = session.getByRole("region", { name: "Saved future session settings", exact: true });
  await expect(live).toContainText("provider/running-model (verified)");
  await expect(live).not.toContainText("future-model"); await expect(future).toContainText("provider/future-model");
  await expect(live).toContainText("not evidence that skill instructions were loaded or used");
  const previous = counts.inspection;
  await session.getByRole("button", { name: "Refresh session", exact: true }).click();
  await expect.poll(() => counts.inspection).toBeGreaterThan(previous);
  expect(counts.mutations).toBe(0);
  await modal.getByRole("link", { name: "Back to conversation", exact: true }).click();
  await expect(modal).not.toBeVisible();
});

test("public activation boundaries beyond the sidebar preview navigate without lifecycle mutations", async ({ page, request }) => {
  const data = await fixture(request); const counts = await mocks(page, data);
  for (let batch = 0; batch < 2; batch++) {
    expect((await request.post(`${fixtureBase}/peer-message?author=human&count=50`)).ok()).toBe(true);
  }
  const response = await request.post(`${conversationsBase}/conversations/${data.primary.id}/messages`, { data: { participantId: data.ownerId, body: "Public activation boundary navigation" } });
  const { message } = await response.json() as { message: { sequence: number } };
  expect(message.sequence).toBeGreaterThan(100);
  await page.route(`**/agents/${data.agent.id}/session-inspection`, route => route.fulfill({ json: { ...inspection(data), recorded: { ...inspection(data).recorded, activationSequence: message.sequence } } }));
  await launch(page, request, data); const modal = await open(page, data);
  await expect(modal.getByRole("region", { name: "Saved host context limits", exact: true })).toContainText("Stop/Start can refresh those host limits");
  await modal.getByRole("button", { name: `View activation boundary message #${message.sequence}`, exact: true }).click();
  await expect(modal).not.toBeVisible(); await expect(page.getByText("Public activation boundary navigation", { exact: true })).toBeVisible();
  await expect(page.locator(`[data-message-sequence="${message.sequence}"]`)).toBeFocused();
  expect(counts.mutations).toBe(0);
});

test("closing and reopening the same participant fences late session observations", async ({ page, request }) => {
  const data = await fixture(request); await mocks(page, data);
  const entered = gate(), pending = gate(), delivered = gate(); let reads = 0;
  await page.route(`**/agents/${data.agent.id}/session-inspection`, async route => {
    const first = ++reads === 1;
    if (first) { entered.release(); await pending.promise; }
    const value = inspection(data);
    if (value.running.status === "available") value.running.profile.model = { status: "verified", provider: "provider", id: first ? "late-old-model" : "reopened-model" };
    await route.fulfill({ json: value }); if (first) delivered.release();
  });
  await launch(page, request, data); const modal = await open(page, data); await entered.promise;
  try {
    await modal.getByRole("link", { name: "Back to conversation", exact: true }).click(); await expect(modal).not.toBeVisible();
    await open(page, data); await expect(modal).toContainText("reopened-model");
  } finally { pending.release(); }
  await delivered.promise; await expect(modal).not.toContainText("late-old-model"); await expect(modal).toContainText("reopened-model");
});

test("unsupported live evidence stays unverified even when future settings are populated", async ({ page, request }) => {
  const data = await fixture(request); await mocks(page, data);
  await page.route(`**/agents/${data.agent.id}/session-inspection`, route => route.fulfill({ json: { ...inspection(data), running: { status: "not_verified" } } }));
  await launch(page, request, data); const modal = await open(page, data);
  const live = modal.getByRole("region", { name: "Observed running profile", exact: true });
  await expect(live).toContainText("Current model: Not verified");
  await expect(live).not.toContainText("future-model");
  await expect(modal.getByRole("region", { name: "Saved future session settings", exact: true })).toContainText("future-model");
});

test("denied session inspection clears already loaded report/history instead of exposing a previous profile", async ({ page, request }) => {
  const data = await fixture(request); await mocks(page, data);
  await launch(page, request, data); const modal = await open(page, data);
  await expect(modal).toContainText("running-model");
  await modal.getByRole("button", { name: "Preview report", exact: true }).click();
  await expect(modal.locator('[aria-label="Report preview"]')).toBeVisible();
  await page.route(`**/agents/${data.agent.id}/session-inspection`, route => route.fulfill({ status: 404, json: { error: "PRIVATE_AUTH_ERROR" } }));
  await modal.getByRole("button", { name: "Refresh session", exact: true }).click();
  await expect(modal).toContainText("Diagnostics unavailable");
  await expect(modal).not.toContainText("running-model"); await expect(modal).not.toContainText("future-model");
  await expect(modal.locator('[aria-label="Report preview"]')).toHaveCount(0); await expect(modal).not.toContainText("PRIVATE_AUTH_ERROR");
});

for (const [resource, status] of [["receipts", 401], ["receipts", 403], ["status", 403], ["failures", 403]] as const) {
  test(`a ${resource} HTTP ${status} denial clears the entire diagnostics page despite stale authorization metadata`, async ({ page, request }) => {
    const data = await fixture(request), counts = await mocks(page, data);
    const path = resource === "receipts" ? "agent-actions" : resource === "status" ? `agents/${data.agent.id}` : "turn-failures";
    let denied = false, deniedReads = 0;
    await page.route(`**/local/conversations/${data.primary.id}/${path}`, route => {
      if (denied) {
        deniedReads++;
        return route.fulfill({ status, json: { error: "PRIVATE_AUTH_ERROR" } });
      }
      return route.continue();
    });
    // Install before mounting so all status and receipt polls share the clock.
    await page.clock.install();
    await launch(page, request, data);
    const surface = await open(page, data);
    await surface.getByRole("button", { name: "Preview report", exact: true }).click();
    await expect(surface.locator('[aria-label="Report preview"]')).toContainText("capture-1");
    await expect(surface.getByRole("region", { name: "Selected operation", exact: true })).toBeVisible();
    await surface.getByRole("button", { name: "Show events", exact: true }).click();
    await expect(surface.getByRole("list", { name: "Runtime observations" })).toBeVisible();
    denied = true;
    await page.clock.fastForward(resource === "receipts" ? 15_000 : 10_000);
    await expect.poll(() => deniedReads).toBeGreaterThan(0);
    await expect(surface).toContainText("Diagnostics unavailable");
    await expect(surface.locator('[aria-label="Report preview"]')).toHaveCount(0);
    await expect(surface.getByRole("region", { name: "Selected operation", exact: true })).toHaveCount(0);
    await expect(surface.getByRole("region", { name: "Operation history", exact: true })).toHaveCount(0);
    await expect(surface.getByRole("list", { name: "Runtime observations" })).toHaveCount(0);
    await expect(surface).not.toContainText("PRIVATE_AUTH_ERROR");
    denied = false;
    await page.clock.fastForward(10_000);
    await expect(surface).toContainText("Diagnostics unavailable");
    await expect(surface.locator('[aria-label="Report preview"]')).toHaveCount(0);
    expect(counts.mutations).toBe(0);
  });
}

test("open-only timeline, explicit uncertainty, pagination, relations, escaped preview and fresh-read Copy", async ({ page, request }) => {
  const data = await fixture(request);
  const counts = await mocks(page, data);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } });
  });
  await launch(page, request, data);
  expect(counts.history).toBe(0);
  const modal = await open(page, data);
  const selected = modal.getByRole("region", { name: "Selected operation", exact: true });
  await expect(selected).toContainText("Lifecycle outcome: unknown");
  await expect(selected).toContainText("Handler failed (confirmed effects may remain)");
  await expect(selected).toContainText("Sequence gap before observation #3");
  await expect(selected).toContainText("Exact targeted trigger (not causation)");
  const timeline = selected.getByRole("list", { name: "Operation timeline" });
  const detailReads = counts.detail;
  await selected.getByRole("combobox", { name: "Timeline result filter" }).selectOption("unknown");
  await expect(timeline).not.toContainText("delivery fenced");
  await expect(timeline).toContainText("#3 · interrupt requested");
  await selected.getByRole("combobox", { name: "Timeline result filter" }).selectOption("all");
  await expect(timeline).toContainText("#1 · delivery fenced");
  expect(counts.detail).toBe(detailReads);
  await modal.getByRole("button", { name: "Older operations" }).click();
  await expect(modal).toContainText("No retained operations on this page");
  await modal.getByRole("button", { name: "Latest page" }).click();
  await expect(modal.getByRole("list", { name: "Recorded operations" })).toContainText("stop");
  await modal.getByRole("button", { name: "View bulk parent" }).click();
  await expect(selected).toContainText("parent");
  await expect(selected).toContainText("3/4 assessed; 0 started, 1 stopped, 1 skipped, 1 failed");
  await expect(selected).toContainText("1 lifecycle outcomes unknown (overlaps handler counts)");
  await expect(selected).toContainText("Bulk subject is the initiating human");
  await modal.getByRole("button", { name: /^stop · unknown/ }).click();
  await modal.getByRole("button", { name: "Preview report" }).click();
  await expect(modal.locator('[aria-label="Report preview"]')).toContainText("capture-1");
  await expect(modal.locator('[aria-label="Report preview"] img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { DIAGNOSTIC_XSS?: boolean }).DIAGNOSTIC_XSS)).toBeUndefined();
  await modal.getByRole("button", { name: "Copy fresh report" }).click();
  await expect(modal).toContainText("Fresh report copied");
  expect(counts.report).toBe(2);
  const copied = await page.evaluate(() => (window as unknown as { copied: string }).copied);
  expect(JSON.parse(copied).capturedAt).toBe("capture-2");
  expect(counts.mutations).toBe(0);
  await modal.getByRole("link", { name: "Back to conversation", exact: true }).click();
  const before = { ...counts };
  await page.waitForTimeout(5_500);
  expect(counts).toEqual(before);
  const reopened = await open(page, data);
  await expect(reopened.locator('[aria-label="Report preview"]')).toHaveCount(0);
  expect(counts.report).toBe(2);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain("capture-");
  expect(storage).not.toContain("selected-stop");
});

for (const lane of ["history", "detail", "copy"] as const) test(`role revocation clears/fences a pending ${lane} read`, async ({ page, request }) => {
  const data = await fixture(request);
  await mocks(page, data);
  let revoked = false;
  await page.route(`**/workspaces/${data.workspaceId}/members`, (route) => route.fulfill({ json: { members: data.members.map((member) => member.identityId === data.ownerId && revoked ? { ...member, accessRole: "member" } : member) } }));
  const pending = gate();
  let entered = false;
  const suffix = lane === "history" ? "operations" : lane === "detail" ? "operations/selected-stop" : "diagnostic-report?*";
  await page.route(`**/local/conversations/${data.primary.id}/agents/${data.agent.id}/${suffix}`, async (route) => {
    entered = true;
    await pending.promise;
    await route.fulfill({ json: lane === "history" ? history(data) : lane === "detail" ? detail(data) : report(data) }).catch(() => undefined);
  });
  await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { (window as unknown as { copied: boolean }).copied = true; } } }); });
  try {
    await launch(page, request, data);
    const modal = await open(page, data);
    if (lane === "copy") {
      await expect(modal.getByRole("region", { name: "Selected operation", exact: true })).toBeVisible();
      await modal.getByRole("button", { name: "Copy fresh report" }).click();
    }
    await expect.poll(() => entered).toBe(true);
    revoked = true;
    await expect(modal.getByRole("region", { name: "Operation history", exact: true })).toHaveCount(0, { timeout: 10_000 });
    pending.release();
    await expect(modal).not.toContainText("selected-stop");
    await expect(modal.locator('[aria-label="Report preview"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { copied?: boolean }).copied)).toBeUndefined();
    await expect(modal.getByRole("region", { name: "Participant diagnostics" })).toHaveCount(0);
  } finally { pending.release(); }
});

for (const loss of ["session", "identity", "participation", "disabled-human", "disabled-membership", "workspace"] as const) test(`${loss} loss clears a report preview`, async ({ page, request }) => {
  const data = await fixture(request);
  await mocks(page, data);
  let lost = false;
  if (loss === "session" || loss === "identity") await page.route("**/local/session", (route) => lost && loss === "session" ? route.fulfill({ status: 401, json: { error: "PRIVATE_AUTH_ERROR" } }) : route.fulfill({ json: { protocolVersion: 24, identityId: lost ? data.agent.id : data.ownerId } }));
  else if (loss === "participation") await page.route(`**/conversations/${data.primary.id}`, (route) => route.fulfill({ json: { conversation: { ...data.primary, participants: lost ? data.primary.participants.filter(({ id }) => id !== data.ownerId) : data.primary.participants } } }));
  else if (loss === "disabled-membership") await page.route(`**/workspaces/${data.workspaceId}/members`, (route) => route.fulfill({ json: { members: data.members.map((member) => member.identityId === data.ownerId && lost ? { ...member, status: "disabled" } : member) } }));
  else if (loss === "workspace") {
    const { workspace } = await (await request.get(`${conversationsBase}/workspaces/${data.workspaceId}`)).json();
    await page.route(`**/workspaces/${data.workspaceId}`, (route) => route.fulfill({ json: { workspace: { ...workspace, status: lost ? "archived" : "active" } } }));
  } else {
    const { identities } = await (await request.get(`${conversationsBase}/identities`)).json();
    await page.route("**/identities", (route) => route.fulfill({ json: { identities: identities.map((identity: { id: string }) => identity.id === data.ownerId && lost ? { ...identity, status: "disabled" } : identity) } }));
  }
  await launch(page, request, data);
  const modal = await open(page, data);
  await modal.getByRole("button", { name: "Preview report" }).click();
  await expect(modal.locator('[aria-label="Report preview"]')).toBeVisible();
  await modal.getByRole("button", { name: "Show events", exact: true }).click();
  await expect(modal.getByRole("list", { name: "Runtime observations" })).toBeVisible();
  await modal.getByRole("button", { name: "Show message trails" }).click();
  await expect(modal.getByRole("list", { name: "Message delivery observations" })).toBeVisible();
  lost = true;
  await expect(modal.locator('[aria-label="Report preview"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(modal.getByRole("region", { name: "Operation history", exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("PRIVATE_AUTH_ERROR");
  await expect(page.getByRole("list", { name: "Runtime observations" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Message delivery observations" })).toHaveCount(0);
});

test("server denial clears existing history and report; clipboard and report faults are safe", async ({ page, request }) => {
  const data = await fixture(request);
  await mocks(page, data);
  await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("PRIVATE_CLIPBOARD_ERROR"); } } }); });
  await launch(page, request, data);
  const modal = await open(page, data);
  await modal.getByRole("button", { name: "Copy fresh report" }).click();
  await expect(modal).toContainText("Clipboard access failed");
  await expect(modal).not.toContainText("PRIVATE_CLIPBOARD_ERROR");
  await page.route("**/diagnostic-report?*", (route) => route.fulfill({ status: 503, json: { error: "PRIVATE_REPORT_ERROR" } }));
  await modal.getByRole("button", { name: "Preview report" }).click();
  await expect(modal).toContainText("Report read failed");
  await expect(modal).not.toContainText("PRIVATE_REPORT_ERROR");
  await page.route("**/diagnostic-report?*", (route) => route.fulfill({ status: 403, json: { error: "denied" } }));
  await modal.getByRole("button", { name: "Copy fresh report" }).click();
  await expect(modal).toContainText("Diagnostics unavailable");
  await expect(modal).not.toContainText("selected-stop");
});

test("navigation fences a pending report; next Conversation never receives its preview", async ({ page, request }) => {
  const data = await fixture(request);
  await mocks(page, data);
  const pending = gate();
  let entered = false;
  await page.route("**/diagnostic-report?*", async (route) => { entered = true; await pending.promise; await route.fulfill({ json: report(data) }).catch(() => undefined); });
  try {
    await launch(page, request, data);
    const modal = await open(page, data);
    await modal.getByRole("button", { name: "Preview report" }).click();
    await expect.poll(() => entered).toBe(true);
    await modal.getByRole("link", { name: "Back to conversation", exact: true }).click();
    await page.getByRole("link", { name: new RegExp(`^${data.alternate.name}`) }).first().click();
    await expect(page.getByRole("heading", { name: `#${data.alternate.name}`, exact: true })).toBeVisible();
    pending.release();
    const next = await open(page, data);
    await expect(next).not.toContainText("selected-stop");
    await expect(next.locator('[aria-label="Report preview"]')).toHaveCount(0);
  } finally { pending.release(); }
});

test("read-only mobile details retain timeline and message navigation without mutations", async ({ page, request }) => {
  const data = await fixture(request);
  const counts = await mocks(page, data);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`**/local/conversations/${data.primary.id}/lifecycle`, (route) => route.fulfill({ json: { lifecycle: { workspaceId: data.workspaceId, conversationId: data.primary.id, state: "settled" } } }));
  await launch(page, request, data);
  await page.getByRole("button", { name: "Show participants" }).click();
  const modal = await open(page, data);
  await expect(modal.getByRole("region", { name: "Selected operation", exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "View triggering message #1", exact: true }).first().click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('[data-message-sequence="1"]')).toBeFocused();
  expect(counts.mutations).toBe(0);
});

for (const kind of ["individual", "bulk"] as const) test(`timeline/report remain usable during an accepted ${kind} Stop`, async ({ page, request }) => {
  const data = await fixture(request);
  const counts = await mocks(page, data);
  await page.route(`**/local/conversations/${data.primary.id}/agents`, route => route.fulfill({ json: {
    protocolVersion: 24, conversationId: data.primary.id, agents: [{ workspaceId: data.workspaceId, conversationId: data.primary.id, identityId: data.agent.id, state: "idle", capabilities: { start: false, stop: true, replace: false, interrupt: false, reconnect: false, steer: false } }],
  } }));
  const actions = await mockActionRequests(page, data.primary.id);
  if (kind === "individual") {
    let reads = 0;
    await page.route(`**/agents/${data.agent.id}/operations`, route => {
      counts.history++;
      return route.fulfill({ json: ++reads === 1 ? { ...history(data), operations: [], nextCursor: undefined } : history(data) });
    });
  }
  await launch(page, request, data);
  if (kind === "individual") {
    await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
    await openParticipantSection(page, "Agent");
    await page.getByRole("menuitem", { name: "Pause agent", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Open participant actions" }).click();
    await page.getByRole("menuitem", { name: /^Stop active agents/ }).click();
  }
  const confirmation = page.getByRole("dialog", { name: kind === "individual" ? `Pause ${data.agent.displayName}?` : "Stop active agents?", exact: true });
  await confirmation.getByRole("button", { name: kind === "individual" ? "Pause agent" : "Stop active agents", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  const surface = await open(page, data);
  await expect(surface).toContainText("Participant action pending");
  await expect(surface.getByRole("button", { name: "Show events", exact: true })).toBeEnabled();
  await expect(surface.getByRole("button", { name: "Show message trails" })).toBeEnabled();
  await expect(surface.getByRole("region", { name: "Selected operation", exact: true })).toContainText("Lifecycle outcome: unknown", { timeout: 10_000 });
  if (kind === "individual") expect(counts.history).toBeGreaterThanOrEqual(2);
  await surface.getByRole("button", { name: "Preview report" }).click();
  await expect(surface.locator('[aria-label="Report preview"]')).toContainText("capture-1");
  actions.complete();
  await expect(surface).not.toContainText("Participant action pending");
  await expect(surface).toBeVisible();
  expect(counts.mutations).toBe(1);
});

test("minimized keyboard inspection restores focus and tabs do not share reports", async ({ page, context, request }) => {
  const data = await fixture(request);
  const firstCounts = await mocks(page, data);
  await launch(page, request, data);
  await page.getByRole("button", { name: "Minimize participants" }).click();
  const trigger = page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await openParticipantSection(page, "Inspect");
  await page.getByRole("menuitem", { name: "Diagnostics", exact: true }).focus();
  await page.keyboard.press("Enter");
  const modal = page.getByRole("main", { name: "Participant diagnostics", exact: true });
  await modal.getByRole("button", { name: "Preview report" }).click();
  await expect(modal.locator('[aria-label="Report preview"]')).toContainText("capture-1");
  const second = await context.newPage();
  try {
    const secondCounts = await mocks(second, data);
    await second.goto(`/app/workspaces/${data.workspaceId}/conversations/${data.primary.id}`);
    const secondModal = await open(second, data);
    await expect(secondModal.getByRole("region", { name: "Selected operation", exact: true })).toBeVisible();
    await expect(secondModal.locator('[aria-label="Report preview"]')).toHaveCount(0);
    expect(secondCounts.report).toBe(0);
    await modal.getByRole("link", { name: "Back to conversation", exact: true }).click();
    await expect(trigger).toBeFocused();
    await secondModal.getByRole("button", { name: "Preview report" }).click();
    await expect(secondModal.locator('[aria-label="Report preview"]')).toBeVisible();
    expect(firstCounts.report).toBe(1);
    expect(secondCounts.report).toBe(1);
  } finally { await second.close(); }
});

test("members never query privileged history; unavailable and missing timelines remain honest", async ({ page, request }) => {
  const data = await fixture(request);
  const counts = await mocks(page, data);
  await request.post(`${fixtureBase}/member-participant?value=true`);
  try {
    await launch(page, request, data, "member");
    const modal = await open(page, data);
    await expect(modal.getByRole("region", { name: "Operation history", exact: true })).toHaveCount(0);
    expect(counts.history).toBe(0); expect(counts.events).toBe(0); expect(counts.trails).toBe(0);
  } finally { await request.post(`${fixtureBase}/member-participant?value=false`); }
  await launch(page, request, data);
  await page.route("**/operations/selected-stop", (route) => route.fulfill({ json: { ...detail(data), detail: undefined } }));
  const modal = await open(page, data);
  await expect(modal).toContainText("Missing history is not proof of expiry or success");
  await page.route(`**/agents/${data.agent.id}/operations`, (route) => route.fulfill({ json: { ...history(data), operations: [], coverage: "unavailable" } }));
  await modal.getByRole("button", { name: "Refresh operations" }).click();
  await expect(modal).toContainText("Journal unavailable; this does not mean no operations occurred");
});

test("issue notices select exact public trigger evidence, not a matching timestamp", async ({ page, request }) => {
  const data = await fixture(request);
  await mocks(page, data);
  const first = { ...detail(data).failures[0]!, causeCategory: "runtime_offline" };
  const other = { ...first, triggerSequence: 999_999, causeCategory: "runtime_rejected" };
  await page.route(`**/local/conversations/${data.primary.id}/turn-failures`, (route) => route.fulfill({ json: {
    protocolVersion: 24, conversationId: data.primary.id,
    notices: [first, other].map(({ participant, failedAt, triggerSequence }) => ({ participant, failedAt, triggerSequence })),
    diagnostics: [first, other],
  } }));
  await launch(page, request, data);
  await page.getByRole("button", { name: "View Runtime issue details for Builder Agent", exact: true }).first().click();
  const modal = page.getByRole("dialog", { name: "Details for Builder Agent", exact: true });
  await expect(modal).toContainText("Runtime issue · message #1");
  const href = await modal.getByRole("link", { name: "Open diagnostics", exact: true }).getAttribute("href");
  await page.goto(href!);
  const issue = page.getByRole("main", { name: "Participant diagnostics", exact: true }).getByRole("region", { name: "Issue diagnostics", exact: true }).first();
  await expect(issue).toContainText("Runtime offline");
  await expect(issue).not.toContainText("Runtime rejected the turn");
});

test("pending history polling is bounded to one minute and stops when closed", async ({ page, request }) => {
  const data = await fixture(request);
  const counts = await mocks(page, data);
  await page.route(`**/agents/${data.agent.id}/operations`, (route) => { counts.history++; return route.fulfill({ json: { ...history(data), operations: [{ ...history(data).operations[0], outcome: "pending" }] } }); });
  await launch(page, request, data);
  const modal = await open(page, data);
  await expect(modal).toContainText("Pending inspection refreshes every five seconds");
  const before = counts.history;
  await expect.poll(() => counts.history, { timeout: 10_000 }).toBeGreaterThan(before);
  await page.clock.install();
  await page.clock.fastForward(65_000);
  await expect(modal).toContainText("Automatic pending refresh paused");
  const stopped = counts.history;
  await page.clock.fastForward(30_000);
  expect(counts.history).toBe(stopped);
  await page.clock.resume();
  await modal.getByRole("link", { name: "Back to conversation", exact: true }).click();
  expect(counts.mutations).toBe(0);
});


test("diagnostics opens in a separate tab without losing chat controls or issuing a mutation", async ({ page, context, request }) => {
  const data = await fixture(request);
  let mutations = 0;
  context.on("request", request => { if (request.method() !== "GET" && /\/local\/conversations\//.test(request.url())) mutations++; });
  await launch(page, request, data);
  await page.getByRole("button", { name: `Open actions for ${data.agent.displayName}`, exact: true }).click();
  await openParticipantSection(page, "Inspect");
  await page.getByRole("menuitem", { name: "Details", exact: true }).click();
  const details = page.getByRole("dialog", { name: `Details for ${data.agent.displayName}`, exact: true });
  const opened = context.waitForEvent("page");
  await details.getByRole("link", { name: "Open diagnostics", exact: true }).click();
  const diagnostics = await opened;
  try {
    await expect(diagnostics.getByRole("main", { name: "Participant diagnostics", exact: true })).toBeVisible();
    await expect(diagnostics.getByRole("heading", { name: `Diagnostics for ${data.agent.displayName}`, exact: true })).toBeVisible();
    await expect(details).toBeVisible();
    await expect(diagnostics.getByRole("button", { name: "Pause agent", exact: true })).toHaveCount(0);
    await expect(diagnostics.getByRole("button", { name: "Fresh session", exact: true })).toHaveCount(0);
    expect(mutations).toBe(0);
  } finally { await diagnostics.close(); }
});
