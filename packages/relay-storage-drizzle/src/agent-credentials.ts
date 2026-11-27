import { and, eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema.ts";

export type AgentCredentialScope =
  | { mode: "generic"; grants: Array<{ conversationId: string; includeThreads: boolean }> }
  | { mode: "locked"; conversationId: string; includeThreads: boolean };

/** Private persistence record. Never serialize this record to an HTTP client. */
export interface AgentCredentialRecord {
  id: string;
  workspaceId: string;
  principalIdentityId: string;
  requestId: string;
  name: string;
  capabilities: Array<"conversation.inspect">;
  scope: AgentCredentialScope;
  revision: number;
  secretGeneration: number;
  secretHash: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export class AgentCredentialStorage {
  constructor(private readonly database: LibSQLDatabase<typeof schema>) {}

  async get(id: string): Promise<AgentCredentialRecord | undefined> {
    const [row] = await this.database.select().from(schema.agentCredentials)
      .where(eq(schema.agentCredentials.id, id)).limit(1);
    return row?.definition;
  }

  async list(workspaceId: string, principalIdentityId: string): Promise<AgentCredentialRecord[]> {
    const table = schema.agentCredentials;
    const rows = await this.database.select().from(table)
      .where(and(eq(table.workspaceId, workspaceId), eq(table.principalIdentityId, principalIdentityId)))
      .orderBy(table.id);
    return rows.map(row => row.definition);
  }

  /** Duplicate request IDs never issue another secret or replay the first secret. */
  async create(record: AgentCredentialRecord): Promise<boolean> {
    const rows = await this.database.insert(schema.agentCredentials).values({
      id: record.id, workspaceId: record.workspaceId, principalIdentityId: record.principalIdentityId,
      requestId: record.requestId, revision: record.revision, definition: record,
    }).onConflictDoNothing().returning({ id: schema.agentCredentials.id });
    return rows.length === 1;
  }

  async replace(record: AgentCredentialRecord, expectedRevision: number): Promise<boolean> {
    if (record.revision !== expectedRevision + 1) throw new Error("Invalid credential revision");
    const table = schema.agentCredentials;
    const rows = await this.database.update(table).set({ revision: record.revision, definition: record })
      .where(and(eq(table.id, record.id), eq(table.workspaceId, record.workspaceId),
        eq(table.principalIdentityId, record.principalIdentityId), eq(table.requestId, record.requestId),
        eq(table.revision, expectedRevision))).returning({ id: table.id });
    return rows.length === 1;
  }
}
