import { describe, expect, test, vi } from "vitest";
import { LocalControlClientError } from "@minu/channels-control/client";
import { LOCAL_CONTROL_PROTOCOL_VERSION, type LocalAgentActionInput, type LocalAgentActionReceipt } from "@minu/channels-control/contracts";
import { ParticipantActionRequests, actionIsPending, type BrowserAgentAction } from "../src/lib/agent-actions";

function setup() {
  let latest: readonly BrowserAgentAction[] = [];
  const changes: Array<readonly BrowserAgentAction[]> = [];
  const receipts = new Map<string, LocalAgentActionReceipt>();
  const completed = vi.fn(), revoked = vi.fn();
  const submitAgentAction = vi.fn(async (conversationId: string, input: LocalAgentActionInput) => {
    const receipt: LocalAgentActionReceipt = { ...input, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, conversationId, state: "pending", requestedAt: Date.now() };
    receipts.set(input.requestId, receipt);
    return receipt;
  });
  const api = {
    submitAgentAction,
    agentAction: vi.fn(async (_conversationId: string, requestId: string) => {
      const receipt = receipts.get(requestId);
      if (!receipt) throw new LocalControlClientError("Not found", 404);
      return receipt;
    }),
    pendingAgentActions: vi.fn(async () => ({ actions: [...receipts.values()].filter(action => action.state === "pending") })),
  };
  const requests = new ParticipantActionRequests("conversation", api, value => { latest = value; changes.push(value); }, completed, revoked);
  return { requests, api, receipts, completed, revoked, changes, get latest() { return latest; } };
}

describe("participant request reconciliation", () => {
  test("a replacement taking longer than the old 30 second deadline remains pending and later succeeds", async () => {
    vi.useFakeTimers();
    const f = setup();
    try {
      await f.requests.submit("replace", "builder");
      const pending = f.latest[0]!;
      await vi.advanceTimersByTimeAsync(31_400);
      expect(actionIsPending(pending)).toBe(true);
      expect(pending.error).toBeUndefined();
      f.receipts.set(pending.requestId, { ...pending, state: "succeeded", completedAt: Date.now() });
      await f.requests.refresh();
      expect(f.latest[0]!.state).toBe("succeeded");
      expect(f.completed).toHaveBeenCalledOnce();
      expect(f.api.submitAgentAction).toHaveBeenCalledOnce();
    } finally { f.requests.dispose(); vi.useRealTimers(); }
  });

  test("a lost acceptance response reconciles the same request ID by reading, never replaying Fresh session", async () => {
    const f = setup();
    const submit = f.api.submitAgentAction.getMockImplementation()!;
    f.api.submitAgentAction.mockImplementation(async (...args) => { await submit(...args); throw new TypeError("PRIVATE_PROXY_ERROR"); });
    await expect(f.requests.submit("replace-fresh", "builder")).rejects.toThrow("unconfirmed");
    expect(f.changes.some(actions => actions.some(action => action.state === "unconfirmed"))).toBe(true);
    const pending = [...f.receipts.values()][0]!;
    f.receipts.set(pending.requestId, { ...pending, state: "succeeded", completedAt: Date.now() });
    await f.requests.refresh();
    expect(f.latest[0]!.state).toBe("succeeded");
    expect(f.api.submitAgentAction).toHaveBeenCalledOnce();
    expect(f.api.agentAction.mock.calls.every(([, requestId]) => requestId === pending.requestId)).toBe(true);
    expect(JSON.stringify(f.changes)).not.toContain("PRIVATE");
  });

  test("one participant does not block another, but a second intent or bulk action cannot queue behind it", async () => {
    const f = setup();
    await f.requests.submit("stop", "builder");
    await f.requests.submit("replace-fresh", "reviewer");
    await expect(f.requests.submit("replace-fresh", "builder")).rejects.toThrow("pending");
    await expect(f.requests.submit("stop-all")).rejects.toThrow("pending");
    expect(f.latest.filter(actionIsPending)).toHaveLength(2);
    expect(f.api.submitAgentAction).toHaveBeenCalledTimes(2);
  });

  test("dismissing an unconfirmed transport notice does not unlock or reissue a pending operation", async () => {
    const f = setup();
    await f.requests.submit("replace-fresh", "builder");
    f.api.pendingAgentActions.mockRejectedValue(new TypeError("PRIVATE_ERROR"));
    f.api.agentAction.mockRejectedValueOnce(new TypeError("PRIVATE_ERROR"));
    await f.requests.refresh();
    const uncertain = f.latest[0]!;
    expect(uncertain.state).toBe("unconfirmed");
    f.requests.dismiss(uncertain.requestId);
    expect(f.latest[0]!.dismissed).toBe(true);
    await expect(f.requests.submit("replace-fresh", "builder")).rejects.toThrow("pending");
    await f.requests.refresh();
    expect(f.latest[0]!.state).toBe("pending");
    expect(f.api.submitAgentAction).toHaveBeenCalledOnce();
  });

  test("missing receipts after restart or expiry remain unconfirmed and are never replayed", async () => {
    const f = setup();
    await f.requests.submit("replace-fresh", "builder");
    f.receipts.clear();
    await f.requests.refresh();
    expect(f.latest[0]!.state).toBe("unconfirmed");
    expect(f.latest[0]!.error).toContain("unconfirmed");
    await f.requests.refresh();
    expect(f.api.submitAgentAction).toHaveBeenCalledOnce();
  });

  test("a definitive Fresh-session rejection is dismissible independently of status and other participants", async () => {
    const f = setup();
    await f.requests.submit("replace-fresh", "builder");
    const pending = f.latest[0]!;
    f.receipts.set(pending.requestId, { ...pending, state: "failed", completedAt: Date.now(), error: "Runtime is busy; stop the agent first" });
    await f.requests.refresh();
    expect(f.latest[0]!.state).toBe("failed");
    expect(actionIsPending(f.latest[0]!)).toBe(false);
    f.requests.dismiss(pending.requestId);
    await f.requests.refresh();
    expect(f.latest[0]!.dismissed).toBe(true);
    expect(f.api.submitAgentAction).toHaveBeenCalledOnce();
  });

  test("reopening a Conversation adopts accepted host actions without mutating them", async () => {
    const f = setup();
    const pending: LocalAgentActionReceipt = { requestId: "other-tab", action: "stop-all", conversationId: "conversation", protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, state: "pending", requestedAt: Date.now() };
    f.receipts.set(pending.requestId, pending);
    await f.requests.refresh();
    expect(f.latest[0]!.requestId).toBe("other-tab");
    await expect(f.requests.submit("start", "builder")).rejects.toThrow("pending");
    expect(f.api.submitAgentAction).not.toHaveBeenCalled();
  });

  test("navigation fences delayed receipt reads and permission loss clears request projections", async () => {
    const f = setup();
    await f.requests.submit("stop", "builder");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.api.pendingAgentActions.mockImplementation(async () => { await held; return { actions: [] }; });
    const read = f.requests.refresh();
    const before = f.changes.length;
    f.requests.dispose(); release(); await read;
    expect(f.changes).toHaveLength(before);
    const other = setup();
    await other.requests.submit("replace", "reviewer");
    other.api.pendingAgentActions.mockRejectedValue(new LocalControlClientError("PRIVATE_DENIAL", 403));
    await other.requests.refresh();
    expect(other.latest).toEqual([]); expect(other.revoked).toHaveBeenCalledOnce();
    await expect(other.requests.submit("stop", "reviewer")).rejects.toThrow("unavailable");
  });

  test.each(["succeeded", "failed"] as const)("a delayed acceptance response cannot regress an already confirmed %s receipt", async state => {
    const f = setup();
    const submit = f.api.submitAgentAction.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.api.submitAgentAction.mockImplementation(async (...args) => { const receipt = await submit(...args); await held; return receipt; });
    const submitting = f.requests.submit("replace-fresh", "builder");
    const pending = [...f.receipts.values()][0]!;
    f.receipts.set(pending.requestId, { ...pending, state, completedAt: Date.now() });
    await f.requests.refresh();
    expect(f.latest[0]!.state).toBe(state);
    release(); await submitting;
    expect(f.latest[0]!.state).toBe(state);
    expect(f.completed).toHaveBeenCalledOnce();
    expect(f.api.submitAgentAction).toHaveBeenCalledOnce();
  });

  for (const state of ["succeeded", "failed"] as const) test.each([
    ["transport", new TypeError("PRIVATE_PROXY_ERROR")],
    ["admission", new LocalControlClientError("PRIVATE_LATE_REJECTION", 409)],
  ] as const)(`a delayed %s POST failure cannot overwrite a GET-confirmed ${state} receipt`, async (_kind, error) => {
    const f = setup();
    const submit = f.api.submitAgentAction.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.api.submitAgentAction.mockImplementation(async (...args) => { await submit(...args); await held; throw error; });
    const submitting = f.requests.submit("replace-fresh", "builder");
    const pending = [...f.receipts.values()][0]!;
    const confirmed = { ...pending, state, completedAt: Date.now(), ...(state === "failed" ? { error: "Runtime is busy" } : {}) };
    f.receipts.set(pending.requestId, confirmed);
    await f.requests.refresh();
    f.requests.dismiss(pending.requestId);
    const changes = f.changes.length;
    // There is no later successful GET to hide a regression caused by the POST.
    f.api.pendingAgentActions.mockRejectedValue(new TypeError("PRIVATE_READ_ERROR"));
    f.api.agentAction.mockRejectedValue(new TypeError("PRIVATE_READ_ERROR"));
    release();
    await expect(submitting).resolves.toBeUndefined();
    await f.requests.refresh();
    expect(f.latest).toEqual([{ ...confirmed, dismissed: true }]);
    expect(actionIsPending(f.latest[0]!)).toBe(false);
    expect(f.changes).toHaveLength(changes);
    expect(f.completed).toHaveBeenCalledOnce();
    expect(f.revoked).not.toHaveBeenCalled();
    expect(f.api.submitAgentAction).toHaveBeenCalledOnce();
    expect(f.api.agentAction).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.changes)).not.toContain("PRIVATE");
    f.requests.dispose();
  });

  test.each(["acceptance", "failure"] as const)("a delayed POST %s cannot resurrect a confirmed action superseded by a new intent", async outcome => {
    const f = setup();
    const submit = f.api.submitAgentAction.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.api.submitAgentAction.mockImplementationOnce(async (...args) => {
      const receipt = await submit(...args);
      await held;
      if (outcome === "failure") throw new TypeError("PRIVATE_LATE_FAILURE");
      return receipt;
    });
    const submitting = f.requests.submit("replace-fresh", "builder");
    const first = [...f.receipts.values()][0]!;
    f.receipts.set(first.requestId, { ...first, state: "succeeded", completedAt: Date.now() });
    await f.requests.refresh();
    await f.requests.submit("stop", "builder");
    const current = f.latest[0]!;
    expect(current.requestId).not.toBe(first.requestId);
    expect(current.state).toBe("pending");
    release();
    await expect(submitting).resolves.toBeUndefined();
    expect(f.latest).toEqual([current]);
    expect(f.completed).toHaveBeenCalledOnce();
    expect(f.api.submitAgentAction).toHaveBeenCalledTimes(2);
    f.requests.dispose();
  });

  test.each([401, 403])("a delayed POST HTTP %s still revokes controls after GET confirmed completion", async status => {
    const f = setup();
    const submit = f.api.submitAgentAction.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.api.submitAgentAction.mockImplementation(async (...args) => { await submit(...args); await held; throw new LocalControlClientError("PRIVATE_DENIAL", status); });
    const submitting = f.requests.submit("replace-fresh", "builder");
    const pending = [...f.receipts.values()][0]!;
    f.receipts.set(pending.requestId, { ...pending, state: "succeeded", completedAt: Date.now() });
    await f.requests.refresh();
    expect(f.latest[0]!.state).toBe("succeeded");
    release();
    await expect(submitting).resolves.toBeUndefined();
    expect(f.latest).toEqual([]);
    expect(f.revoked).toHaveBeenCalledOnce();
    await expect(f.requests.submit("stop", "builder")).rejects.toThrow("unavailable");
    expect(f.api.submitAgentAction).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.changes)).not.toContain("PRIVATE");
  });
});
