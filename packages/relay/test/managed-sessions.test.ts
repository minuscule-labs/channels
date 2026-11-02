import assert from "node:assert/strict";
import test from "node:test";
import { getManagedRuntimeSession, resumeManagedRuntimeSession } from "../src/managed-sessions.ts";
import type { ManagedRuntimeSessionSummary } from "../src/relay.ts";

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("exact lookup isolates identities and never falls back to an inventory scan", async () => {
  const calls: string[] = [];
  const runtime = {
    async getManagedSession(id: string, ownerId: string) {
      calls.push(id);
      return { id, ownerId, state: "suspended" as const };
    },
    async listManagedSessions() { throw new Error("Inventory must not run"); },
  };
  assert.equal((await getManagedRuntimeSession(runtime, "target", "owner"))?.id, "target");
  assert.deepEqual(calls, ["target"]);
  runtime.getManagedSession = async id => ({ id, ownerId: "wrong-owner", state: "suspended" });
  await assert.rejects(getManagedRuntimeSession(runtime, "target", "owner"), /identity mismatch/);
});

test("legacy inventory stays single-flight across bindings and timed-out waiters until physical settlement", async () => {
  const listing = gate<ManagedRuntimeSessionSummary[]>();
  let calls = 0;
  const runtime = { async listManagedSessions() { calls++; return listing.promise; } };
  const first = getManagedRuntimeSession(runtime, "one", "owner");
  await assert.rejects(Promise.race([first, Promise.reject(new Error("caller timeout"))]), /caller timeout/);
  const others = Array.from({ length: 100 }, () => getManagedRuntimeSession(runtime, "two", "owner"));
  await Promise.resolve();
  assert.equal(calls, 1);
  listing.resolve([{ id: "one", ownerId: "owner", state: "active" }, { id: "two", ownerId: "owner", state: "suspended" }]);
  assert.equal((await first)?.id, "one");
  assert.ok((await Promise.all(others)).every(value => value?.id === "two"));
  await getManagedRuntimeSession(runtime, "two", "owner");
  assert.equal(calls, 2, "A completed read is not a stale status cache");
});

test("failed reads release their guard and different owners do not share inventory results", async () => {
  let calls = 0;
  const runtime = { async listManagedSessions(ownerId: string): Promise<ManagedRuntimeSessionSummary[]> {
    calls++;
    if (calls === 1) throw new Error("listing failed");
    return [{ id: "target", ownerId, state: "active" }];
  } };
  await assert.rejects(getManagedRuntimeSession(runtime, "target", "owner"), /listing failed/);
  assert.equal((await getManagedRuntimeSession(runtime, "target", "owner"))?.ownerId, "owner");
  assert.equal((await getManagedRuntimeSession(runtime, "target", "other-owner"))?.ownerId, "other-owner");
  assert.equal(calls, 3);
});

test("a timed-out resume remains single-flight until its underlying operation settles", async () => {
  const resumed = gate<{ id: string; ownerId: string }>();
  let calls = 0;
  const runtime = { async resume() { calls++; return resumed.promise; } };
  const first = resumeManagedRuntimeSession(runtime, "target", "owner", { allowStopped: true });
  await assert.rejects(Promise.race([first, Promise.reject(new Error("caller timeout"))]));
  const second = resumeManagedRuntimeSession(runtime, "target", "owner", { allowStopped: true });
  await Promise.resolve();
  assert.equal(calls, 1);
  resumed.resolve({ id: "target", ownerId: "owner" });
  assert.deepEqual(await first, await second);
});
