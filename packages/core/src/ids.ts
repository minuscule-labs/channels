import { v7 as uuidv7 } from "uuid";

export const RESOURCE_ID_PREFIXES = [
  "identity",
  "workspace",
  "conversation",
  "folder",
  "preset",
  "message",
  "attachment",
  "event",
  "config",
  "binding",
] as const;

export type ResourceIdPrefix = typeof RESOURCE_ID_PREFIXES[number];

/** Existing Channel IDs remain valid opaque Conversation IDs after the terminology migration. */
const LEGACY_RESOURCE_ID_PREFIXES = ["channel"] as const;

/** Creates a typed UUIDv7 id. Its timestamp is public; message sequences remain authoritative. */
export function createResourceId(prefix: ResourceIdPrefix): string {
  return `${prefix}_${uuidv7().replaceAll("-", "")}`;
}

export function isResourceId(value: unknown, prefix?: ResourceIdPrefix): value is string {
  if (typeof value !== "string") return false;
  const expectedPrefix = prefix === "conversation"
    ? "(?:conversation|channel)"
    : prefix ?? `(?:${[...RESOURCE_ID_PREFIXES, ...LEGACY_RESOURCE_ID_PREFIXES].join("|")})`;
  return new RegExp(`^${expectedPrefix}_[0-9a-f]{32}$`).test(value);
}
