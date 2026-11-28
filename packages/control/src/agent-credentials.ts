import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ConversationClient } from "@minu/channels-core/client";
import type { AgentCredentialRecord, AgentCredentialScope, AgentCredentialStorage } from "@minu/channels-relay-storage-drizzle";

const DAY = 24 * 60 * 60 * 1_000;
export type AgentCredentialSummary = Omit<AgentCredentialRecord, "secretHash">;
export interface AgentCredentialIssue { credential: AgentCredentialSummary; secret: string }
export interface AgentCredentialCreate {
  requestId: string;
  name: string;
  capabilities: Array<"conversation.inspect">;
  scope: AgentCredentialScope;
  expiresAt?: string;
}
export interface AgentCredentialUpdate {
  expectedRevision: number;
  name?: string;
  capabilities?: Array<"conversation.inspect">;
  scope?: AgentCredentialScope;
  expiresAt?: string;
}

export class AgentCredentialError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 503, readonly code: string) {
    super(code);
    this.name = "AgentCredentialError";
  }
}

function invalid(): never { throw new AgentCredentialError(400, "invalid_request"); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) invalid();
  return record;
}
function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
    || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) >= Number.MAX_SAFE_INTEGER) invalid();
  return value as number;
}
function capabilities(value: unknown): Array<"conversation.inspect"> {
  if (!Array.isArray(value) || value.length > 1 || value.some(item => item !== "conversation.inspect")) invalid();
  return [...value] as Array<"conversation.inspect">;
}
function grant(value: unknown): { conversationId: string; includeThreads: boolean } {
  const input = object(value, ["conversationId", "includeThreads"]);
  if (typeof input.includeThreads !== "boolean") invalid();
  return { conversationId: text(input.conversationId), includeThreads: input.includeThreads };
}
function scope(value: unknown): AgentCredentialScope {
  const input = object(value, ["mode", "conversationId", "includeThreads", "grants"]);
  if (input.mode === "locked") {
    if ("grants" in input) invalid();
    return { mode: "locked", ...grant({ conversationId: input.conversationId, includeThreads: input.includeThreads }) };
  }
  if (input.mode !== "generic" || "conversationId" in input || "includeThreads" in input
    || !Array.isArray(input.grants) || input.grants.length < 1 || input.grants.length > 128) invalid();
  const grants = input.grants.map(grant);
  if (new Set(grants.map(item => item.conversationId)).size !== grants.length) invalid();
  return { mode: "generic", grants };
}
function summary(record: AgentCredentialRecord): AgentCredentialSummary {
  // Explicit projection: do not let future private fields leak through object spread.
  return { id: record.id, workspaceId: record.workspaceId, principalIdentityId: record.principalIdentityId,
    requestId: record.requestId, name: record.name, capabilities: [...record.capabilities],
    scope: structuredClone(record.scope), revision: record.revision, secretGeneration: record.secretGeneration,
    createdAt: record.createdAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt,
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}) };
}
function hash(secret: string): string { return createHash("sha256").update(secret).digest("hex"); }
function issue(id: string): { secret: string; secretHash: string } {
  const secret = `chak_${id}_${randomBytes(32).toString("base64url")}`;
  return { secret, secretHash: hash(secret) };
}

export interface AgentCredentialServiceOptions {
  client: Pick<ConversationClient, "getWorkspace" | "getIdentity" | "listWorkspaceMembers" | "getConversation">;
  store: Pick<AgentCredentialStorage, "create" | "replace" | "get" | "list">;
  now?: () => Date;
}

export class AgentCredentialService {
  constructor(private readonly options: AgentCredentialServiceOptions) {}
  private now(): Date { return this.options.now?.() ?? new Date(); }

  /** Also used by the HTTP boundary immediately before returning sensitive results. */
  async authorizeAdministrator(workspaceId: string, actorIdentityId: string): Promise<void> {
    try {
      const [workspace, identity, members] = await Promise.all([
        this.options.client.getWorkspace(workspaceId), this.options.client.getIdentity(actorIdentityId),
        this.options.client.listWorkspaceMembers(workspaceId),
      ]);
      const member = members.find(item => item.identityId === actorIdentityId);
      if (workspace.status !== "active" || identity.type !== "human" || identity.status !== "active"
        || member?.status !== "active" || !["owner", "admin"].includes(member.accessRole)) {
        throw new AgentCredentialError(403, "forbidden");
      }
    } catch (error) {
      if (error instanceof AgentCredentialError) throw error;
      throw new AgentCredentialError(403, "forbidden");
    }
  }

  private expiry(value: unknown, now: Date): string {
    if (value === undefined) return new Date(now.getTime() + 30 * DAY).toISOString();
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) invalid();
    const expires = Date.parse(value);
    if (!Number.isFinite(expires) || expires <= now.getTime() || expires > now.getTime() + 90 * DAY) invalid();
    return new Date(expires).toISOString();
  }

  private async validateTargets(workspaceId: string, targetScope: AgentCredentialScope): Promise<void> {
    const grants = targetScope.mode === "locked" ? [targetScope] : targetScope.grants;
    // Sequential bounded work, not unbounded fan-out over user-supplied grants.
    for (const target of grants) {
      try {
        const conversation = await this.options.client.getConversation(target.conversationId);
        if (conversation.workspaceId !== workspaceId) throw new Error("Wrong workspace");
        // A thread grant is exact; includeThreads is reserved for a parent Conversation.
        if (conversation.thread && target.includeThreads) invalid();
      } catch (error) {
        if (error instanceof AgentCredentialError) throw error;
        throw new AgentCredentialError(404, "target_unavailable");
      }
    }
  }

  async list(workspaceId: string, actorIdentityId: string): Promise<AgentCredentialSummary[]> {
    await this.authorizeAdministrator(workspaceId, actorIdentityId);
    const records = await this.options.store.list(workspaceId, actorIdentityId);
    await this.authorizeAdministrator(workspaceId, actorIdentityId);
    return records.map(summary);
  }

  async create(workspaceId: string, actorIdentityId: string, value: unknown): Promise<AgentCredentialIssue> {
    await this.authorizeAdministrator(workspaceId, actorIdentityId);
    const input = object(value, ["requestId", "name", "capabilities", "scope", "expiresAt"]);
    const requestId = text(input.requestId, 128);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) invalid();
    const now = this.now();
    const record: AgentCredentialRecord = {
      id: randomUUID().replaceAll("-", ""), workspaceId, principalIdentityId: actorIdentityId, requestId,
      name: text(input.name, 100), capabilities: capabilities(input.capabilities), scope: scope(input.scope),
      revision: 1, secretGeneration: 1, secretHash: "", createdAt: now.toISOString(), updatedAt: now.toISOString(),
      expiresAt: this.expiry(input.expiresAt, now),
    };
    await this.validateTargets(workspaceId, record.scope);
    await this.authorizeAdministrator(workspaceId, actorIdentityId);
    const issued = issue(record.id);
    record.secretHash = issued.secretHash;
    if (!await this.options.store.create(record)) throw new AgentCredentialError(409, "request_already_recorded");
    await this.authorizeAdministrator(workspaceId, actorIdentityId);
    return { credential: summary(record), secret: issued.secret };
  }

  private async owned(workspaceId: string, actorIdentityId: string, id: string): Promise<AgentCredentialRecord> {
    await this.authorizeAdministrator(workspaceId, actorIdentityId);
    const record = await this.options.store.get(id);
    if (!record || record.workspaceId !== workspaceId || record.principalIdentityId !== actorIdentityId) {
      throw new AgentCredentialError(404, "credential_unavailable");
    }
    return record;
  }

  async get(workspaceId: string, actorIdentityId: string, id: string): Promise<AgentCredentialSummary> {
    const record = await this.owned(workspaceId, actorIdentityId, id);
    await this.authorizeAdministrator(workspaceId, actorIdentityId);
    return summary(record);
  }

  async mutate(workspaceId: string, actorIdentityId: string, id: string,
    operation: "update" | "rotate" | "revoke", value: unknown): Promise<{ credential: AgentCredentialSummary; secret?: string }> {
    const record = await this.owned(workspaceId, actorIdentityId, id);
    const input = object(value, operation === "update"
      ? ["expectedRevision", "name", "capabilities", "scope", "expiresAt"] : ["expectedRevision"]);
    const expected = revision(input.expectedRevision);
    if (record.revision !== expected) throw new AgentCredentialError(409, "revision_conflict");
    const now = this.now();
    if (record.revokedAt || (operation !== "revoke" && Date.parse(record.expiresAt) <= now.getTime())) {
      throw new AgentCredentialError(409, "credential_inactive");
    }
    let secret: string | undefined;
    if (operation === "update") {
      if (Object.keys(input).length === 1) invalid();
      if ("name" in input) record.name = text(input.name, 100);
      if ("capabilities" in input) record.capabilities = capabilities(input.capabilities);
      if ("scope" in input) record.scope = scope(input.scope);
      if ("expiresAt" in input) record.expiresAt = this.expiry(input.expiresAt, now);
      await this.validateTargets(workspaceId, record.scope);
    } else if (operation === "rotate") {
      await this.validateTargets(workspaceId, record.scope);
      const issued = issue(id);
      secret = issued.secret;
      record.secretHash = issued.secretHash;
      record.secretGeneration++;
    } else {
      record.revokedAt = now.toISOString();
    }
    record.revision++;
    record.updatedAt = now.toISOString();
    await this.authorizeAdministrator(workspaceId, actorIdentityId);
    if (!await this.options.store.replace(record, expected)) throw new AgentCredentialError(409, "revision_conflict");
    await this.authorizeAdministrator(workspaceId, actorIdentityId);
    return { credential: summary(record), ...(secret ? { secret } : {}) };
  }

  /** Private admission primitive; B3 additionally checks current principal, scope and final generation. */
  async authenticate(secret: string): Promise<AgentCredentialRecord> {
    const match = /^chak_([a-f0-9]{32})_[A-Za-z0-9_-]{43}$/.exec(secret);
    if (!match) throw new AgentCredentialError(401, "unauthenticated");
    const record = await this.options.store.get(match[1]!);
    const candidate = Buffer.from(hash(secret), "hex");
    const expected = record && /^[a-f0-9]{64}$/.test(record.secretHash) ? Buffer.from(record.secretHash, "hex") : Buffer.alloc(32);
    const matches = timingSafeEqual(candidate, expected);
    const expires = record ? Date.parse(record.expiresAt) : NaN;
    if (!record || !matches || record.revokedAt || !Number.isFinite(expires) || expires <= this.now().getTime()) {
      throw new AgentCredentialError(401, "unauthenticated");
    }
    return record;
  }
}
