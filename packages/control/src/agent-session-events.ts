import { LOCAL_RUNTIME_EVENT_CODES, type LocalRuntimeEventCode, type LocalRuntimeSessionEvents } from "./contracts.ts";

/** Independent fixed-field allowlist; neither raw harness events nor adapter extensions pass through. */
export function safeSessionEvents(input: unknown): LocalRuntimeSessionEvents | undefined {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const time = (value: unknown): value is string => typeof value === "string" && value.length === 24
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  const raw = object(input);
  if (raw.version !== 1 || raw.source !== "runtime_bridge" || !time(raw.capturedAt) || !time(raw.recordingSince)
    || !counter(raw.eventsDropped) || !Array.isArray(raw.events) || raw.events.length > 200
    || (raw.eventsDropped > 0 && raw.events.length !== 200)) return undefined;
  const events: LocalRuntimeSessionEvents["events"] = [];
  let previous = raw.eventsDropped;
  for (const value of raw.events) {
    const event = object(value);
    if (!counter(event.sequence) || event.sequence <= previous || event.sequence - previous !== 1
      || !time(event.observedAt) || !LOCAL_RUNTIME_EVENT_CODES.includes(event.code as LocalRuntimeEventCode)) return undefined;
    previous = event.sequence;
    events.push({ sequence: event.sequence, observedAt: event.observedAt, code: event.code as LocalRuntimeEventCode });
  }
  const snapshot: LocalRuntimeSessionEvents = { version: 1, source: "runtime_bridge", capturedAt: raw.capturedAt,
    recordingSince: raw.recordingSince, eventsDropped: raw.eventsDropped, events };
  return Buffer.byteLength(JSON.stringify(snapshot)) <= 32 * 1024 ? snapshot : undefined;
}
