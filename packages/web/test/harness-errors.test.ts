import { describe, expect, it } from "vitest";
import { harnessDiscoveryMessage } from "../src/lib/harness-errors";

describe("harness discovery messages", () => {
  const fallback = "Harness discovery unavailable.";
  it("shows the fixed Claude Code sign-in instruction", () => {
    expect(harnessDiscoveryMessage(new Error("Claude Code is not logged in; run `claude` to sign in"), fallback))
      .toBe("Claude Code is not logged in; run `claude` to sign in");
  });
  it("shows each fixed install, sign-in and version instruction for Codex and Claude Code", () => {
    for (const message of ["Claude Code is not installed; install `claude` and restart Channels",
      "This Claude Code version is not supported; update `claude`",
      "Codex is not installed; install `codex` and restart Channels",
      "Codex is not logged in; run `codex login`"]) expect(harnessDiscoveryMessage(new Error(message), fallback)).toBe(message);
  });
  it("never surfaces any other error text", () => {
    for (const error of [new Error("Runtime options are unavailable"), new Error("Claude Code is not logged in; run `claude` to sign in PRIVATE"),
      "Claude Code is not logged in; run `claude` to sign in", undefined,
      new Error("Codex is not logged in; run `codex login` PRIVATE"), new Error("Codex is not installed; install `codex`"),
      new Error("Codex is not installed; install `codex` and restart Channels\n/Users/private/path")]) expect(harnessDiscoveryMessage(error, fallback)).toBe(fallback);
  });
});
