import type { AgentRuntimePort, ManagedRuntimeSessionSummary } from "./relay.ts";

// Retain physical work until it settles, even when a caller's timeout stops waiting.
// Legacy inventory is shared per owner, not repeated for every binding/retry.
const pending = new WeakMap<object, Map<string, Promise<unknown>>>();
function singleFlight<T>(runtime: object, key: string, operation: () => Promise<T>): Promise<T> {
  let operations = pending.get(runtime);
  if (!operations) pending.set(runtime, operations = new Map());
  const existing = operations.get(key);
  if (existing) return existing as Promise<T>;
  const result = Promise.resolve().then(operation);
  operations.set(key, result);
  const clear = () => {
    if (operations.get(key) === result) operations.delete(key);
  };
  void result.then(clear, clear);
  return result;
}

export async function getManagedRuntimeSession(
  runtime: Pick<AgentRuntimePort, "getManagedSession" | "listManagedSessions">,
  sessionId: string,
  ownerId: string,
  timeoutMs = 2_000,
): Promise<ManagedRuntimeSessionSummary | undefined> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Managed session read timeout must be a supported positive integer");
  }
  // The shared physical read has one deadline. Callers keep their own waiting limits;
  // an adapter that ignores cancellation still occupies its guard until settlement.
  const session = runtime.getManagedSession
    ? await singleFlight(runtime, JSON.stringify(["read", ownerId, sessionId]), () =>
      runtime.getManagedSession!(sessionId, ownerId, { signal: AbortSignal.timeout(timeoutMs) }))
    : (await singleFlight(runtime, JSON.stringify(["list", ownerId]), () => {
      if (!runtime.listManagedSessions) throw new Error("Managed Runtime lookup is unavailable");
      return runtime.listManagedSessions(ownerId, { signal: AbortSignal.timeout(timeoutMs) });
    })).find(candidate => candidate.id === sessionId && candidate.ownerId === ownerId);
  if (session && (session.id !== sessionId || session.ownerId !== ownerId)) {
    throw new Error("Managed Runtime lookup identity mismatch");
  }
  return session;
}

export function resumeManagedRuntimeSession(
  runtime: Pick<AgentRuntimePort, "resume">,
  sessionId: string,
  ownerId: string,
  options?: { allowStopped?: boolean },
) {
  return singleFlight(runtime, JSON.stringify(["resume", ownerId, sessionId, Boolean(options?.allowStopped)]), () => {
    if (!runtime.resume) throw new Error("Managed Runtime resume is unavailable");
    return runtime.resume(sessionId, ownerId, options);
  });
}
