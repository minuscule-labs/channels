import type { ConversationMetadata } from "@minu/channels-core/types";
import type {
  AgentCredentialGrant,
  AgentCredentialScopeInput,
  CreateLocalAgentCredentialInput,
  LocalAgentCredentialSummary,
  UpdateLocalAgentCredentialInput,
} from "@minu/channels-control/contracts";
import { LocalControlClientError } from "@minu/channels-control/client";

const DAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_EXPIRY_DAYS = 30;
export const MAX_EXPIRY_DAYS = 90;
export const EXPIRY_PRESET_DAYS = [7, 30, 60, 90] as const;

export type CredentialStatus = "active" | "expired" | "revoked";

/** A display hint only; the backend remains authoritative for expiry and policy. */
export function credentialStatus(credential: Pick<LocalAgentCredentialSummary, "revokedAt" | "expiresAt">, now: number): CredentialStatus {
  if (credential.revokedAt) return "revoked";
  return Date.parse(credential.expiresAt) <= now ? "expired" : "active";
}

export interface CredentialTarget {
  id: string;
  kind: "conversation" | "thread";
  name: string;
  parentId?: string;
  parentName?: string;
}

/** Parent Conversations followed by their threads, so threads are never mistaken for parents. */
export function buildTargetCatalog(parents: ConversationMetadata[], threads: ConversationMetadata[]): CredentialTarget[] {
  const parentsById = new Map(parents.map(parent => [parent.id, parent]));
  const childrenByParent = new Map<string, ConversationMetadata[]>();
  for (const thread of threads) {
    const parentId = thread.thread?.parentConversationId;
    if (!parentId) continue;
    childrenByParent.set(parentId, [...childrenByParent.get(parentId) ?? [], thread]);
  }
  return [...parents].sort((a, b) => a.name.localeCompare(b.name)).flatMap(parent => [
    { id: parent.id, kind: "conversation" as const, name: parent.name },
    ...(childrenByParent.get(parent.id) ?? []).map(thread => ({
      id: thread.id, kind: "thread" as const, name: thread.name, parentId: parent.id, parentName: parentsById.get(parent.id)?.name,
    })),
  ]);
}

export function targetLabel(target: CredentialTarget | undefined): string {
  if (!target) return "Unavailable target";
  return target.kind === "thread" ? `${target.name} in #${target.parentName ?? "Conversation"}` : `#${target.name}`;
}

export function searchTargets(catalog: CredentialTarget[], query: string, excluded: ReadonlySet<string>, limit = 8): CredentialTarget[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return catalog.filter(target => !excluded.has(target.id)
    && (targetLabel(target).toLowerCase().includes(q) || target.id.toLowerCase() === q)).slice(0, limit);
}

export function scopeGrants(scope: AgentCredentialScopeInput): AgentCredentialGrant[] {
  return scope.mode === "locked" ? [{ conversationId: scope.conversationId, includeThreads: scope.includeThreads }] : scope.grants;
}

export function capabilityLabel(credential: Pick<LocalAgentCredentialSummary, "capabilities">): string {
  return credential.capabilities.includes("conversation.inspect") ? "Inspect status" : "Inspection off";
}

export function grantSummary(credential: Pick<LocalAgentCredentialSummary, "scope" | "capabilities">, catalog: ReadonlyMap<string, CredentialTarget>): string {
  const grants = scopeGrants(credential.scope);
  const access = capabilityLabel(credential);
  if (credential.scope.mode === "locked") {
    const target = catalog.get(credential.scope.conversationId);
    return `${access} · Single target${target ? `: ${targetLabel(target)}` : ""}${credential.scope.includeThreads ? " + threads" : ""}`;
  }
  const withThreads = grants.filter(grant => grant.includeThreads).length;
  return `${access} · ${grants.length} ${grants.length === 1 ? "target" : "targets"}${withThreads ? ` (${withThreads} with threads)` : ""}`;
}

export type ExpiryChoice = { kind: "keep" } | { kind: "days"; days: number } | { kind: "date"; date: string };

export interface AccessDraft {
  name: string;
  mode: AgentCredentialScopeInput["mode"];
  /** Grants are kept across mode switches and when their target is not currently loaded. */
  grants: AgentCredentialGrant[];
  inspect: boolean;
  expiry: ExpiryChoice;
}

export function newDraft(): AccessDraft {
  return { name: "", mode: "generic", grants: [], inspect: true, expiry: { kind: "days", days: DEFAULT_EXPIRY_DAYS } };
}

export function draftFromCredential(credential: LocalAgentCredentialSummary): AccessDraft {
  return {
    name: credential.name,
    mode: credential.scope.mode,
    grants: scopeGrants(credential.scope).map(grant => ({ ...grant })),
    inspect: credential.capabilities.includes("conversation.inspect"),
    expiry: { kind: "keep" },
  };
}

/** Thread grants are exact; inclusion is reserved for a parent Conversation the human explicitly opts into. */
export function addGrant(grants: AgentCredentialGrant[], target: CredentialTarget): AgentCredentialGrant[] {
  if (grants.some(grant => grant.conversationId === target.id)) return grants;
  return [...grants, { conversationId: target.id, includeThreads: false }];
}

export function setIncludeThreads(grants: AgentCredentialGrant[], conversationId: string, includeThreads: boolean, target: CredentialTarget | undefined): AgentCredentialGrant[] {
  if (includeThreads && target?.kind !== "conversation") return grants;
  return grants.map(grant => grant.conversationId === conversationId ? { ...grant, includeThreads } : grant);
}

function localDate(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function endOfLocalDay(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return NaN;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 0).getTime();
}

/** Bounds for a custom date input: the end of the chosen local day must fall within the 90-day maximum. */
export function customExpiryBounds(now: number): { min: string; max: string } {
  const limit = now + MAX_EXPIRY_DAYS * DAY_MS;
  let max = localDate(limit);
  if (endOfLocalDay(max) > limit) max = localDate(limit - DAY_MS);
  return { min: localDate(now), max };
}

/** Resolves the expiry to send. undefined means omit: backend default on create, unchanged on edit. */
export function resolveExpiry(choice: ExpiryChoice, now: number, creating: boolean): { expiresAt?: string; error?: string } {
  if (choice.kind === "keep") return {};
  if (choice.kind === "days") {
    if (!Number.isSafeInteger(choice.days) || choice.days < 1 || choice.days > MAX_EXPIRY_DAYS) return { error: "Choose an expiry within 90 days." };
    if (creating && choice.days === DEFAULT_EXPIRY_DAYS) return {};
    return { expiresAt: new Date(now + choice.days * DAY_MS).toISOString() };
  }
  const expires = endOfLocalDay(choice.date);
  if (!Number.isFinite(expires)) return { error: "Choose an expiry date." };
  if (expires <= now) return { error: "Expiry must be in the future." };
  if (expires > now + MAX_EXPIRY_DAYS * DAY_MS) return { error: "Expiry can be at most 90 days away." };
  return { expiresAt: new Date(expires).toISOString() };
}

export function draftScope(draft: AccessDraft): { scope?: AgentCredentialScopeInput; error?: string } {
  if (draft.grants.length === 0) return { error: "Add at least one Conversation or thread." };
  if (draft.mode === "locked") {
    if (draft.grants.length !== 1) return { error: "Single target keys need exactly one Conversation or thread." };
    return { scope: { mode: "locked", ...draft.grants[0]! } };
  }
  if (draft.grants.length > 128) return { error: "A key can have at most 128 targets." };
  return { scope: { mode: "generic", grants: draft.grants.map(grant => ({ ...grant })) } };
}

function draftName(draft: AccessDraft): { name?: string; error?: string } {
  const name = draft.name.trim();
  if (!name) return { error: "Enter a key name." };
  if (name.length > 100) return { error: "Key names can be at most 100 characters." };
  return { name };
}

export function buildCreateInput(draft: AccessDraft, requestId: string, now: number): { input?: CreateLocalAgentCredentialInput; error?: string } {
  const name = draftName(draft);
  const scope = draftScope(draft);
  const expiry = resolveExpiry(draft.expiry, now, true);
  const error = name.error ?? scope.error ?? expiry.error;
  if (error) return { error };
  return { input: {
    requestId, name: name.name!, capabilities: draft.inspect ? ["conversation.inspect"] : [], scope: scope.scope!,
    ...(expiry.expiresAt ? { expiresAt: expiry.expiresAt } : {}),
  } };
}

function sameGrants(a: AgentCredentialGrant[], b: AgentCredentialGrant[]): boolean {
  const key = (grants: AgentCredentialGrant[]) => grants.map(grant => `${grant.conversationId}:${grant.includeThreads}`).sort().join("|");
  return key(a) === key(b);
}

function sameScope(a: AgentCredentialScopeInput, b: AgentCredentialScopeInput): boolean {
  return a.mode === b.mode && sameGrants(scopeGrants(a), scopeGrants(b));
}

export interface RebasedDraft {
  draft: AccessDraft;
  /** Targets the human changed that also changed concurrently; they keep the current value. */
  conflicts: string[];
  /** Scope mode or a single target changed on both sides, so the whole current scope is kept. */
  scopeReset: boolean;
}

/**
 * Re-applies only the fields the human edited (draft vs. the version they opened) onto current metadata.
 * Untouched fields come from current, so a stale draft never restores access another admin removed.
 */
export function rebaseDraft(draft: AccessDraft, opened: LocalAgentCredentialSummary, current: LocalAgentCredentialSummary): RebasedDraft {
  const base = draftFromCredential(opened);
  const latest = draftFromCredential(current);
  const rebased: AccessDraft = {
    name: draft.name.trim() !== base.name ? draft.name : latest.name,
    inspect: draft.inspect !== base.inspect ? draft.inspect : latest.inspect,
    // "Keep" now refers to the current expiry; an explicit choice is the human's edit.
    expiry: draft.expiry,
    mode: latest.mode,
    grants: latest.grants,
  };
  const humanChanged = draft.mode !== base.mode || !sameGrants(draft.grants, base.grants);
  if (!humanChanged) return { draft: rebased, conflicts: [], scopeReset: false };
  const otherChanged = latest.mode !== base.mode || !sameGrants(latest.grants, base.grants);
  if (!otherChanged) return { draft: { ...rebased, mode: draft.mode, grants: draft.grants }, conflicts: [], scopeReset: false };
  if (draft.mode !== "generic" || base.mode !== "generic" || latest.mode !== "generic") return { draft: rebased, conflicts: [], scopeReset: true };

  const flags = (grants: AgentCredentialGrant[]) => new Map(grants.map(grant => [grant.conversationId, grant.includeThreads]));
  const [before, mine, theirs] = [flags(base.grants), flags(draft.grants), flags(latest.grants)];
  const conflicts: string[] = [];
  const grants: AgentCredentialGrant[] = [];
  for (const id of new Set([...latest.grants, ...draft.grants, ...base.grants].map(grant => grant.conversationId))) {
    let value = theirs.get(id);
    if (mine.get(id) !== before.get(id)) {
      if (theirs.get(id) === before.get(id) || theirs.get(id) === mine.get(id)) value = mine.get(id);
      else conflicts.push(id);
    }
    if (value !== undefined) grants.push({ conversationId: id, includeThreads: value });
  }
  return { draft: { ...rebased, mode: "generic", grants }, conflicts, scopeReset: false };
}

/** Only changed fields are sent, so an unchanged expiry is never silently extended. */
export function buildUpdateInput(draft: AccessDraft, credential: LocalAgentCredentialSummary, expectedRevision: number, now: number): { input?: UpdateLocalAgentCredentialInput; error?: string } {
  const name = draftName(draft);
  const scope = draftScope(draft);
  const expiry = resolveExpiry(draft.expiry, now, false);
  const error = name.error ?? scope.error ?? expiry.error;
  if (error) return { error };
  const input: UpdateLocalAgentCredentialInput = { expectedRevision };
  if (name.name !== credential.name) input.name = name.name;
  const inspect = credential.capabilities.includes("conversation.inspect");
  if (draft.inspect !== inspect) input.capabilities = draft.inspect ? ["conversation.inspect"] : [];
  if (!sameScope(scope.scope!, credential.scope)) input.scope = scope.scope;
  if (expiry.expiresAt) input.expiresAt = expiry.expiresAt;
  if (Object.keys(input).length === 1) return { error: "No changes to save." };
  return { input };
}

export type CredentialFailureKind = "denied" | "invalid" | "unavailable" | "conflict" | "inactive" | "recorded" | "unknown";
/**
 * `kind` is for display. `mayHaveCommitted` drives mutation orchestration: the backend re-authorizes and
 * re-checks the browser session after persistence, so 401/403 are no proof that a write did not happen.
 */
export interface CredentialFailure { kind: CredentialFailureKind; message: string; mayHaveCommitted: boolean }

/**
 * Only rejections the backend raises before persistence (400, 404, 409) prove nothing was written.
 * Denial, overload, proxy errors, timeouts and network failures leave the outcome unknown.
 */
export function classifyCredentialFailure(error: unknown): CredentialFailure {
  const known = (kind: CredentialFailureKind, message: string): CredentialFailure => ({ kind, message, mayHaveCommitted: false });
  if (!(error instanceof LocalControlClientError)) {
    return { kind: "unknown", message: "The connection failed before a response arrived. The change may or may not have been saved.", mayHaveCommitted: true };
  }
  if (error.status === 401 || error.status === 403) {
    return { kind: "denied", message: "An active Workspace owner or admin session is required. The change may already have been saved; check it once access is restored.", mayHaveCommitted: true };
  }
  if (error.status === 400) return known("invalid", "The key settings were rejected as invalid. Check the targets and expiry.");
  if (error.status === 404) {
    return error.message === "target_unavailable"
      ? known("unavailable", "One or more targets are unavailable. Remove or replace them, then try again.")
      : known("unavailable", "This API key is unavailable.");
  }
  if (error.status === 409 && error.message === "revision_conflict") return known("conflict", "This key changed since you opened it.");
  if (error.status === 409 && error.message === "credential_inactive") return known("inactive", "This key is expired or revoked.");
  if (error.status === 409 && error.message === "request_already_recorded") return known("recorded", "This creation request was already recorded.");
  return { kind: "unknown", message: "The server did not confirm the outcome. The change may or may not have been saved.", mayHaveCommitted: true };
}

/** Runs `task` over `items` with at most `limit` in flight, preserving input order in the results. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function findCreatedCredential(credentials: LocalAgentCredentialSummary[], requestId: string): LocalAgentCredentialSummary | undefined {
  return credentials.find(credential => credential.requestId === requestId);
}

export function newCreateRequestId(): string {
  return `ui_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Non-secret record of a mutation whose outcome must be reviewed before another attempt. */
export type CredentialIntent =
  | { kind: "create"; requestId: string; input: CreateLocalAgentCredentialInput; state: "pending" | "unknown" | "undelivered"; credentialId?: string; denied?: boolean }
  | { kind: "update" | "rotate" | "revoke"; credentialId: string; expectedRevision: number; secretGeneration: number;
    input?: UpdateLocalAgentCredentialInput; state: "pending" | "unknown" | "undelivered"; denied?: boolean };

type Listener = () => void;
const intents = new Map<string, CredentialIntent>();
const listeners = new Set<Listener>();

export function intentKey(workspaceId: string, kind: "create" | "credential", credentialId?: string): string {
  return kind === "create" ? `${workspaceId}:create` : `${workspaceId}:credential:${credentialId}`;
}

/** Live-page store only (module memory, not React Query, URLs or storage); raw secrets are never recorded. */
export const credentialIntents = {
  get(key: string): CredentialIntent | undefined { return intents.get(key); },
  set(key: string, intent: CredentialIntent): void {
    if ("secret" in intent) throw new Error("Credential intents cannot hold secrets");
    intents.set(key, intent);
    for (const listener of listeners) listener();
  },
  clear(key: string): void {
    if (!intents.delete(key)) return;
    for (const listener of listeners) listener();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
