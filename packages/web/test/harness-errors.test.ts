import { describe, expect, it } from "vitest";
import { harnessDiscoveryMessage } from "../src/lib/harness-errors";

describe("harness discovery messages", () => {
  const fallback = "Harness discovery unavailable.";
  it("shows the fixed Claude Code sign-in instruction", () => {
    expect(harnessDiscoveryMessage(new Error("Claude Code is not logged in; run `claude` to sign in"), fallback))
      .toBe("Claude Code is not logged in; run `claude` to sign in");
  });
  it("never surfaces any other error text", () => {
    for (const error of [new Error("Runtime options are unavailable"), new Error("Claude Code is not logged in; run `claude` to sign in PRIVATE"),
      "Claude Code is not logged in; run `claude` to sign in", undefined]) expect(harnessDiscoveryMessage(error, fallback)).toBe(fallback);
  });
});
