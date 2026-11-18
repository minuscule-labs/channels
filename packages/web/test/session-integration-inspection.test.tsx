import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LocalRuntimeSessionIntegrations } from "@minu/channels-control/contracts";
import { SessionIntegrationInspection } from "../src/components/session-integration-inspection";

const snapshot: LocalRuntimeSessionIntegrations = { version: 1, capturedAt: "2026-10-01T10:00:00.000Z", status: "partial",
  coverage: { configuration: "complete", tools: "partial" }, operations: { inspect: "supported", reconnect: "unsupported", reloadConfiguration: "unsupported" },
  integrations: [{ id: "mcp.notes", name: "notes", kind: "mcp", source: "user", configured: "enabled", connection: "connected", toolCoverage: "partial", offeredCount: 0, registeredCount: 0 }],
  tools: [{ name: "mcp__notes__hidden", visibility: "hidden", routes: [], reachability: "not_reachable" }], issues: ["discovery_failed"] };
describe("integration observations", () => {
  it("keeps failure categories attached to the affected integration row", () => {
    const html = renderToStaticMarkup(<SessionIntegrationInspection snapshot={{ ...snapshot, issues: [], integrations: [
      { ...snapshot.integrations[0]!, failureCode: "registration_failed" },
      { ...snapshot.integrations[0]!, id: "mcp.discovery", name: "discovery", failureCode: "discovery_failed" },
    ] }} />);
    const rows = html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1]!.split("</tr>");
    expect(rows[0]).toContain("notes"); expect(rows[0]).toContain("registration failed"); expect(rows[0]).not.toContain("discovery failed");
    expect(rows[1]).toContain("discovery"); expect(rows[1]).toContain("discovery failed"); expect(rows[1]).not.toContain("registration failed");
  });
  it("shows age, coverage, independently known zero/unknown counts and tool routes", () => {
    const html = renderToStaticMarkup(<SessionIntegrationInspection snapshot={snapshot} />);
    expect(html).toContain("2026-10-01T10:00:00.000Z");
    expect(html).toContain("Configuration:"); expect(html).toContain("partial");
    expect(html).toContain("<td>0</td>"); expect(html).toContain("<td>Unknown</td>");
    expect(html).toContain("mcp__notes__hidden"); expect(html).toContain("not reachable");
    expect(html).not.toContain("<button");
  });
  it("does not label unsupported or unavailable inspection as confirmed absence", () => {
    const unsupported = renderToStaticMarkup(<SessionIntegrationInspection snapshot={{ ...snapshot, status: "unsupported", coverage: { configuration: "unknown", tools: "unknown" }, integrations: [], tools: [] }} />);
    expect(unsupported).toContain("unsupported"); expect(unsupported).not.toContain(">None<");
    expect(renderToStaticMarkup(<SessionIntegrationInspection />)).toContain("Unavailable");
  });
  it("escapes integration names as data", () => {
    const html = renderToStaticMarkup(<SessionIntegrationInspection snapshot={{ ...snapshot, integrations: [{ ...snapshot.integrations[0]!, name: "<script>bad</script>" }] }} />);
    expect(html).not.toContain("<script>"); expect(html).toContain("&lt;script&gt;");
  });
});
