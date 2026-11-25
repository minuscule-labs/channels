import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LocalAgentSessionInspection } from "@minu/channels-control/contracts";
import { SessionContextInspection } from "../src/components/session-context-inspection";
import type { DiagnosticSurface, DiagnosticSurfaceState } from "../src/lib/operation-diagnostics";

const render = (updatedAt: string | undefined, commandIds = ["skill:review"], adapter = "pi") => {
  const inspection: LocalAgentSessionInspection = { protocolVersion: 25, conversationId: "conversation", participantIdentityId: "agent",
    capturedAt: "2026-10-01T10:00:00.000Z", availability: "available",
    recorded: { bindingState: "connected", origin: "started", adapter: "pi", activatedAt: "2026-10-01T09:00:00.000Z" },
    running: { status: "available", profile: { version: 1, capturedAt: "2026-10-01T10:00:00.000Z", model: { status: "not_verified" },
      reasoning: { status: "not_verified" }, skills: { status: "verified", commandIds, complete: true } } },
    saved: { status: "available", profile: { ...(updatedAt ? { updatedAt } : {}), adapter,
      skills: { selection: "explicit", ids: ["skill:review", "skill:gone"], complete: true } } },
    latestStart: "not_verified", lastStopBoundary: "not_recorded" };
  return renderToStaticMarkup(<SessionContextInspection state={{ inspection } as DiagnosticSurfaceState} surface={{} as DiagnosticSurface}
    loadedSequences={new Set()} onViewMessage={() => {}} />);
};

describe("saved skills missing from a running session", () => {
  it("lists skills saved before the session started that it does not have", () => {
    expect(render("2026-10-01T08:00:00.000Z")).toContain("Saved skills not available in this session: gone<");
    expect(render("2026-10-01T08:00:00.000Z", ["skill:review", "skill:gone"])).not.toContain("not available in this session");
  });
  it("says nothing when settings are newer, undated or for another harness", () => {
    for (const html of [render("2026-10-01T09:30:00.000Z"), render(undefined), render("2026-10-01T08:00:00.000Z", undefined, "codex")]) {
      expect(html).not.toContain("not available in this session");
    }
  });
});
