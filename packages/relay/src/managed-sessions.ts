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
): Promise<ManagedRuntimeSessionSummary | undefined> {
  const session = runtime.getManagedSession
    ? await singleFlight(runtime, JSON.stringify(["read", ownerId, sessionId]), () => runtime.getManagedSession!(sessionId, ownerId))
    : (await singleFlight(runtime, JSON.stringify(["list", ownerId]), () => {
      if (!runtime.listManagedSessions) throw new Error("Managed Runtime lookup is unavailable");
      return runtime.listManagedSessions(ownerId);
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
