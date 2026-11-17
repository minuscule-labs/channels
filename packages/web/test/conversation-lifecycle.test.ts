import { afterEach, describe, expect, it, vi } from "vitest";
import { announceLifecycleChange, listenForLifecycleChanges, snoozeRefetchInterval } from "../src/lib/conversation-lifecycle";

class ChannelMock {
  static instances: ChannelMock[] = [];
  onmessage?: (event: { data: unknown }) => void;
  postMessage = vi.fn((data: unknown) => {
    for (const channel of ChannelMock.instances) {
      if (channel !== this && channel.name === this.name && !channel.closed) channel.onmessage?.({ data });
    }
  });
  closed = false;
  close = vi.fn(() => { this.closed = true; });
  constructor(readonly name: string) { ChannelMock.instances.push(this); }
}

afterEach(() => { vi.unstubAllGlobals(); ChannelMock.instances = []; });

describe("snooze lifecycle timers", () => {
  const day = 86_400_000;
  const now = Date.parse("2026-11-17T12:00:00Z");
  it("bounds a 30-day snooze and recomputes the final remaining delay", () => {
    const lifecycle = { state: "snoozed" as const, snoozedUntil: new Date(now + 30 * day).toISOString() };
    expect(snoozeRefetchInterval(lifecycle, now)).toBe(day);
    expect(snoozeRefetchInterval(lifecycle, now + 29.5 * day)).toBe(day / 2);
    expect(snoozeRefetchInterval(lifecycle, now + 30 * day)).toBe(1_000);
  });
  it("does not poll active, settled, missing, or malformed lifecycle data", () => {
    expect(snoozeRefetchInterval({ state: "active" }, now)).toBe(false);
    expect(snoozeRefetchInterval({ state: "settled", settledAt: new Date(now).toISOString() }, now)).toBe(false);
    expect(snoozeRefetchInterval(undefined, now)).toBe(false);
    expect(snoozeRefetchInterval({ state: "snoozed", snoozedUntil: "invalid" }, now)).toBe(false);
  });
});

describe("cross-tab lifecycle invalidation", () => {
  it("notifies only the same principal, shares no cached state, and closes its channels", () => {
    vi.stubGlobal("BroadcastChannel", ChannelMock);
    const samePrincipal = vi.fn(), otherPrincipal = vi.fn();
    const stop = listenForLifecycleChanges("owner", samePrincipal);
    const stopOther = listenForLifecycleChanges("other-owner", otherPrincipal);
    announceLifecycleChange("owner", "conversation");
    expect(samePrincipal).toHaveBeenCalledExactlyOnceWith("conversation");
    expect(otherPrincipal).not.toHaveBeenCalled();
    expect(ChannelMock.instances[2]!.closed).toBe(true);
    stop();
    stopOther();
    expect(ChannelMock.instances.every(({ closed }) => closed)).toBe(true);
  });
  it("ignores malformed notifications and tolerates unavailable browser support", () => {
    vi.stubGlobal("BroadcastChannel", ChannelMock);
    const changed = vi.fn();
    const stop = listenForLifecycleChanges("owner", changed);
    announceLifecycleChange("another-owner", "conversation");
    expect(changed).not.toHaveBeenCalled();
    for (const data of [null, {}, "", "a".repeat(257), "a\0b"]) ChannelMock.instances[0]!.onmessage?.({ data });
    expect(changed).not.toHaveBeenCalled();
    stop();
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(() => announceLifecycleChange("owner", "conversation")).not.toThrow();
    expect(() => listenForLifecycleChanges("owner", changed)()).not.toThrow();
    announceLifecycleChange(undefined, "conversation");
  });
});
