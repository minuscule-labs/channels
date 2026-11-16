import type { LocalRuntimeSessionIntegrations } from "./contracts.ts";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): value is string => typeof value === "string" && value.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value) && !value.includes("..");
const coverage = (value: unknown) => value === "complete" || value === "partial" ? value : "unknown";
const support = (value: unknown) => value === "supported" || value === "unsupported" ? value : "unknown";
const codes: readonly string[] = ["configuration_invalid", "connection_failed", "authentication_required", "discovery_failed", "registration_failed", "provider_unavailable", "invalid_observation", "truncated"];

export function unsupportedSessionIntegrations(capturedAt: string): LocalRuntimeSessionIntegrations {
  return { version: 1, capturedAt, status: "unsupported", coverage: { configuration: "unknown", tools: "unknown" },
    operations: { inspect: "unsupported", reconnect: "unknown", reloadConfiguration: "unknown" }, integrations: [], tools: [], issues: [] };
}

/** Independent Channels allowlist; no dependency on a harness or separately versioned Runtime code. */
export function safeSessionIntegrations(input: unknown): LocalRuntimeSessionIntegrations | undefined {
  const raw = object(input), rawCoverage = object(raw.coverage), operations = object(raw.operations);
  if (raw.version !== 1 || typeof raw.capturedAt !== "string" || raw.capturedAt.length !== 24 || !Number.isFinite(Date.parse(raw.capturedAt)) || new Date(raw.capturedAt).toISOString() !== raw.capturedAt
    || !["available", "partial", "unsupported", "unavailable"].includes(String(raw.status))) return undefined;
  const snapshot: LocalRuntimeSessionIntegrations = { version: 1, capturedAt: raw.capturedAt, status: raw.status as LocalRuntimeSessionIntegrations["status"],
    ...(typeof raw.workerId === "string" && /^[a-f0-9-]{36}$/.test(raw.workerId) ? { workerId: raw.workerId } : {}),
    coverage: { configuration: coverage(rawCoverage.configuration), tools: coverage(rawCoverage.tools) },
    operations: { inspect: support(operations.inspect), reconnect: support(operations.reconnect), reloadConfiguration: support(operations.reloadConfiguration) },
    integrations: [], tools: [], issues: [] };
  const issues = new Set<LocalRuntimeSessionIntegrations["issues"][number]>();
  if (Array.isArray(raw.issues)) for (const value of raw.issues.slice(0, 32)) {
    if (typeof value === "string" && codes.includes(value)) issues.add(value as LocalRuntimeSessionIntegrations["issues"][number]);
    else issues.add("invalid_observation");
  }
  const entries = Array.isArray(raw.integrations) ? raw.integrations : [];
  const tools = Array.isArray(raw.tools) ? raw.tools : [];
  let invalidConfiguration = !Array.isArray(raw.integrations), invalidTools = !Array.isArray(raw.tools);
  if (entries.length > 128 || tools.length > 512) issues.add("truncated");
  for (const value of entries.slice(0, 128)) {
    const entry = object(value);
    if (!id(entry.id) || !id(entry.name) || snapshot.integrations.some(item => item.id === entry.id)) { invalidConfiguration = true; continue; }
    const integration: LocalRuntimeSessionIntegrations["integrations"][number] = { id: entry.id, name: entry.name,
      kind: entry.kind === "mcp" || entry.kind === "native" ? entry.kind : "other",
      source: ["user", "project", "extension", "native"].includes(String(entry.source)) ? entry.source as LocalRuntimeSessionIntegrations["integrations"][number]["source"] : "unknown",
      configured: entry.configured === "enabled" || entry.configured === "disabled" ? entry.configured : "unknown",
      connection: ["disabled", "connecting", "connected", "disconnected", "authentication_required", "failed", "closed", "not_applicable"].includes(String(entry.connection)) ? entry.connection as LocalRuntimeSessionIntegrations["integrations"][number]["connection"] : "unknown",
      toolCoverage: coverage(entry.toolCoverage) };
    if (typeof entry.failureCode === "string" && ["connection_failed", "authentication_required", "discovery_failed", "registration_failed"].includes(entry.failureCode)) integration.failureCode = entry.failureCode as LocalRuntimeSessionIntegrations["integrations"][number]["failureCode"];
    for (const key of ["offeredCount", "registeredCount", "callableCount", "reachableCount"] as const) if (typeof entry[key] === "number" && Number.isSafeInteger(entry[key]) && entry[key] >= 0) integration[key] = entry[key];
    snapshot.integrations.push(integration);
  }
  for (const value of tools.slice(0, 512)) {
    const tool = object(value);
    if (!id(tool.name) || snapshot.tools.some(item => item.name === tool.name)) { invalidTools = true; continue; }
    let routes = Array.isArray(tool.routes) ? [...new Set(tool.routes.filter((route): route is "model" | "indirect" => route === "model" || route === "indirect"))] : [];
    let reachability: LocalRuntimeSessionIntegrations["tools"][number]["reachability"] = tool.reachability === "reachable" || tool.reachability === "not_reachable" ? tool.reachability : "unknown";
    if (tool.visibility === "hidden") { if (routes.length || reachability === "reachable") invalidTools = true; routes = []; reachability = "not_reachable"; }
    else if (reachability === "reachable" && routes.length === 0) { invalidTools = true; reachability = "unknown"; }
    snapshot.tools.push({ name: tool.name,
      ...(id(tool.integrationId) && snapshot.integrations.some(item => item.id === tool.integrationId) ? { integrationId: tool.integrationId } : {}),
      visibility: tool.visibility === "declared" || tool.visibility === "discoverable" || tool.visibility === "hidden" ? tool.visibility : "unknown", routes, reachability });
  }
  if (invalidConfiguration || invalidTools) issues.add("invalid_observation");
  if (entries.length > 128 || invalidConfiguration) snapshot.coverage.configuration = "partial";
  if (tools.length > 512 || invalidTools) snapshot.coverage.tools = "partial";
  snapshot.issues = [...issues];
  // Reserve 32 KiB for the existing live/saved profile and session-inspection envelope.
  while (Buffer.byteLength(JSON.stringify(snapshot)) > 96 * 1024) {
    if (snapshot.tools.length) { snapshot.tools.pop(); snapshot.coverage.tools = "partial"; }
    else if (snapshot.integrations.length) { snapshot.integrations.pop(); snapshot.coverage.configuration = "partial"; }
    else return undefined;
    if (!snapshot.issues.includes("truncated")) snapshot.issues.push("truncated");
  }
  if (snapshot.status === "unsupported" || snapshot.status === "unavailable") {
    snapshot.integrations = []; snapshot.tools = []; snapshot.coverage = { configuration: "unknown", tools: "unknown" };
    if (snapshot.status === "unsupported") snapshot.operations.inspect = "unsupported";
  } else if (snapshot.issues.length || snapshot.coverage.configuration !== "complete" || snapshot.coverage.tools !== "complete") snapshot.status = "partial";
  if (snapshot.coverage.tools !== "complete") for (const entry of snapshot.integrations) entry.toolCoverage = "partial";
  return snapshot;
}
