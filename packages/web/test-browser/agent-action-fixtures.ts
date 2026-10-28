import type { LocalAgentActionInput, LocalAgentActionReceipt } from "@minu/channels-control/contracts";
import type { Page } from "@playwright/test";

/** Browser-side boundary fixture; real HTTP admission is covered by control tests. */
export async function mockActionRequests(page: Page, conversationId: string, options: {
  reject?: { status: number; error: string };
  loseAcceptance?: boolean;
  onSubmit?(input: LocalAgentActionInput): Partial<Pick<LocalAgentActionReceipt, "state" | "error" | "results">> | void;
} = {}) {
  const calls: LocalAgentActionInput[] = [];
  const receipts = new Map<string, LocalAgentActionReceipt>();
  const path = `/local/conversations/${conversationId}/agent-actions`;
  await page.route(`**${path}**`, async route => {
    const request = route.request();
    if (request.method() === "POST") {
      const input = request.postDataJSON() as LocalAgentActionInput;
      calls.push(input);
      if (options.reject) return route.fulfill({ status: options.reject.status, json: { error: options.reject.error } });
      const result = options.onSubmit?.(input);
      const receipt: LocalAgentActionReceipt = { ...input, protocolVersion: 23, conversationId, requestedAt: Date.now(), state: "pending", ...result };
      if (receipt.state !== "pending") receipt.completedAt = Date.now();
      receipts.set(input.requestId, receipt);
      if (options.loseAcceptance) return route.abort("failed");
      return route.fulfill({ status: 202, json: receipt });
    }
    const requestId = new URL(request.url()).pathname.slice(path.length + 1);
    if (!requestId) return route.fulfill({ json: { actions: [...receipts.values()].filter(receipt => receipt.state === "pending") } });
    const receipt = receipts.get(requestId);
    return receipt ? route.fulfill({ json: receipt }) : route.fulfill({ status: 404, json: { error: "Receipt unavailable" } });
  });
  return {
    calls, receipts,
    reject(value?: { status: number; error: string }) { options.reject = value; },
    complete(result: Partial<Pick<LocalAgentActionReceipt, "state" | "error" | "results">> = {}) {
      for (const [id, receipt] of receipts) receipts.set(id, { ...receipt, state: "succeeded", completedAt: Date.now(), ...result });
    },
  };
}
