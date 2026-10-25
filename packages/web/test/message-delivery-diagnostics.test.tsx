import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { LocalAgentDeliveryTrails } from "@minu/channels-control/contracts";
import type { DiagnosticSurface } from "../src/lib/operation-diagnostics";
import { MessageDeliveryDiagnostics } from "../src/components/message-delivery-diagnostics";
const summary = { trailId: "trail-one", triggerSequence: 1, startedAt: "2026-10-01T00:00:00.000Z", observedAt: "2026-10-01T00:00:01.000Z", closedAt: "2026-10-01T00:00:01.000Z", outcome: "response_reused" as const, recordingGap: false, eventsDropped: 0 };
const result: LocalAgentDeliveryTrails = { protocolVersion: 22, conversationId: "conversation", participantIdentityId: "agent", capturedAt: "now", availability: "available", retention: { days: 7, terminalLimit: 1000, eventLimit: 16 }, history: { trails: [summary], recordingGap: false }, selected: { ...summary, events: [{ sequence: 1, stage: "response_reused", observedAt: "2026-10-01T00:00:01.000Z", elapsedMs: 1000 }] } };
const render = (value = result, open = true) => renderToStaticMarkup(<MessageDeliveryDiagnostics state={{ deliveryTrails: value, trailsOpen: open }} surface={{} as DiagnosticSurface} loadedSequences={new Set()} onViewMessage={() => {}} />);
it("deduplicated delivery is an existing response acknowledgment, not a claim about the old response kind", () => {
  const html = render(); expect(html).toContain("Existing response acknowledged"); expect(html).toContain("Existing public response acknowledged"); expect(html).not.toContain("Reply delivered"); expect(html).not.toContain("Failure notice");
  expect(render(result, false)).not.toContain("Recorded message trails");
});
it("unknown stage values never become labels, timestamps remain text and unrelated private fields are ignored", () => {
  const raw = { ...result, prompt: "PRIVATE_PROMPT", selected: { ...result.selected!, body: "PRIVATE_BODY", events: [{ ...result.selected!.events[0]!, stage: "<script>PRIVATE_STAGE</script>", observedAt: '<img src=x onerror="alert(1)">' }] } } as unknown as LocalAgentDeliveryTrails;
  const html = render(raw); expect(html).not.toContain("PRIVATE"); expect(html).not.toContain("<script"); expect(html).not.toContain("<img"); expect(html).toContain("&lt;img");
});
