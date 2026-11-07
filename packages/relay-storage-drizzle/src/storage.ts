import { createClient, type Client, type ResultSet } from "@libsql/client";
import { randomUUID } from "node:crypto";
import type {
  ConversationPreset,
  ConversationCreationSetup,
  AuthoredDocument,
  AuthoredDocumentMutation,
  AuthoredDocumentRevision,
  AuthoredSkillInvocation,
  AuthoredInvocationMessageLink,
  AuthoredContextSnapshot,
  ConversationAgentBindingRecord,
  ConversationAgentBindingState,
  ConversationWorkingFolder,
  DeliveryDeadLetterInput,
  DeliveryDeadLetterRecord,
  LocalWorkspaceConfig,
  RelayBindingStore,
  RuntimeModelRef,
  TurnFailureDeliveryInput,
  TurnFailureDiagnosticInput,
  TurnFailureDiagnosticRecord,
  RuntimeSessionCleanupAttempt,
  RuntimeSessionHistoryOrigin,
  RuntimeSessionActivation,
  RuntimeSessionHistoryRecord,
  RuntimeSessionContextMode,
  RuntimeSessionRetirementReason,
  WorkspaceAgentConfig,
} from "@minu/channels-relay";
import { AuthoredContextUnavailableError, validateAuthoredContext, invocationDocumentMatches, invocationTargetMatches, reviseAuthoredDocument, validateConversationWorkingFolders } from "@minu/channels-relay";
import { and, asc, desc, eq, gt, isNull, lte, lt, ne, or, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.ts";

export interface DrizzleLibSqlRelayStorageOptions {
  /** Private Relay state is local-only and must use a file: libSQL URL. */
  url: string;
  migrationsFolder?: string;
}

export function defaultRelayMigrationsFolder(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const packageRoot = currentDirectory.endsWith("/dist/src")
    ? resolve(currentDirectory, "../..")
    : resolve(currentDirectory, "..");
  return resolve(packageRoot, "drizzle");
}

export function localRelayLibSqlUrl(path: string): string {
  return path.startsWith("file:") ? path : `file:${resolve(path)}`;
}

function workspaceConfig(row: typeof schema.localWorkspaceConfigs.$inferSelect): LocalWorkspaceConfig {
  let runtimeModelPolicies: Record<string, RuntimeModelRef[]> | undefined;
  if (row.runtimeModelPolicies) {
    const parsed: unknown = JSON.parse(row.runtimeModelPolicies);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Stored Runtime model policies are invalid");
    }
    runtimeModelPolicies = parsed as Record<string, RuntimeModelRef[]>;
  }
  return {
    ...row,
    notesFolderId: row.notesFolderId ?? undefined,
    idleSleepTimeoutMs: row.idleSleepTimeoutMs ?? undefined,
    runtimeModelPolicies,
  };
}

function agentConfig(row: typeof schema.workspaceAgentConfigs.$inferSelect): WorkspaceAgentConfig {
  const parsedSkillIds: unknown = row.skillIds ? JSON.parse(row.skillIds) : undefined;
  if (parsedSkillIds !== undefined && (!Array.isArray(parsedSkillIds)
    || parsedSkillIds.some((id) => typeof id !== "string"))) {
    throw new Error("Stored agent skill ids are invalid");
  }
  return {
    ...row,
    personaRef: row.personaRef ?? undefined,
    personaPrompt: row.personaPrompt ?? undefined,
    runtimeAdapter: row.runtimeAdapter ?? undefined,
    modelProvider: row.modelProvider ?? undefined,
    modelId: row.modelId ?? undefined,
    reasoningLevel: row.reasoningLevel ?? undefined,
    skillIds: parsedSkillIds as string[] | undefined,
    handoffSummaryTokens: row.handoffSummaryTokens ?? undefined,
    recentContextTokens: row.recentContextTokens ?? undefined,
    recentContextMessages: row.recentContextMessages ?? undefined,
  };
}

function binding(row: typeof schema.conversationAgentBindings.$inferSelect): ConversationAgentBindingRecord {
  const { conversationId, ...binding } = row;
  if (row.runtimeOwnerId !== null && !row.runtimeOwnerId.trim()) {
    throw new Error("Stored Runtime owner scope is invalid");
  }
  return {
    ...binding,
    conversationId: conversationId,
    executionEnvironmentId: row.executionEnvironmentId ?? undefined,
    runtimeOwnerId: row.runtimeOwnerId ?? undefined,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt ?? undefined,
    lastVerifiedAt: row.lastVerifiedAt ?? undefined,
    lastActiveAt: row.lastActiveAt ?? undefined,
    sleptAt: row.sleptAt ?? undefined,
    wakeRequestedAt: row.wakeRequestedAt ?? undefined,
    managedSessionMissingAt: row.managedSessionMissingAt ?? undefined,
  };
}

function sessionHistory(
  row: typeof schema.conversationAgentSessionHistory.$inferSelect,
): RuntimeSessionHistoryRecord {
  const { authoredContext: serialized, ...fields } = row;
  let authoredContext: AuthoredContextSnapshot | undefined;
  if (serialized !== null) {
    try {
      const parsed = JSON.parse(serialized) as AuthoredContextSnapshot;
      if (typeof parsed?.channelId !== "string" || !parsed.channelId.trim()) throw new AuthoredContextUnavailableError();
      validateAuthoredContext(parsed, row.workspaceId, parsed.channelId);
      authoredContext = parsed;
    } catch {
      throw new AuthoredContextUnavailableError();
    }
  }
  return {
    ...fields,
    ...(authoredContext !== undefined ? { authoredContext } : {}),
    managedSessionId: row.managedSessionId ?? undefined,
    runtimeOwnerId: row.runtimeOwnerId ?? undefined,
    legacyRuntimeSessionRef: row.legacyRuntimeSessionRef ?? undefined,
    conversationSequenceAtActivation: row.conversationSequenceAtActivation ?? undefined,
    conversationSequenceAtRetirement: row.conversationSequenceAtRetirement ?? undefined,
    retiredAt: row.retiredAt ?? undefined,
    retirementReason: row.retirementReason ?? undefined,
    lastCleanupAttemptAt: row.lastCleanupAttemptAt ?? undefined,
    lastObservedRuntimeStatus: row.lastObservedRuntimeStatus ?? undefined,
    lastVerifiedAt: row.lastVerifiedAt ?? undefined,
    lastCleanupErrorCategory: row.lastCleanupErrorCategory ?? undefined,
  };
}

type RelayStorageTransaction = SQLiteTransaction<
  "async",
  ResultSet,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

async function advanceRecoveryCursor(
  transaction: RelayStorageTransaction,
  conversationId: string, participantId: string, sequence: number, updatedAt: string,
): Promise<void> {
  await transaction.insert(schema.agentHostCursors).values({
    conversationId, participantId, lastProcessedSequence: sequence, updatedAt,
  }).onConflictDoUpdate({
    target: [schema.agentHostCursors.conversationId, schema.agentHostCursors.participantId],
    set: { lastProcessedSequence: sql`max(${schema.agentHostCursors.lastProcessedSequence}, ${sequence})`, updatedAt },
  });
}

async function assertManagedSessionReusable(
  transaction: RelayStorageTransaction,
  record: ConversationAgentBindingRecord,
): Promise<void> {
  if (!record.runtimeOwnerId) return;
  const blocked = await transaction.select({ id: schema.conversationAgentSessionHistory.id })
    .from(schema.conversationAgentSessionHistory)
    .where(and(
      eq(schema.conversationAgentSessionHistory.runtimeAdapter, record.runtimeAdapter),
      eq(schema.conversationAgentSessionHistory.runtimeOwnerId, record.runtimeOwnerId),
      eq(schema.conversationAgentSessionHistory.managedSessionId, record.runtimeSessionId),
      eq(schema.conversationAgentSessionHistory.mapping, "managed"),
      eq(schema.conversationAgentSessionHistory.state, "retired"),
      or(
        ne(schema.conversationAgentSessionHistory.retentionStatus, "retained"),
        eq(schema.conversationAgentSessionHistory.cleanupStatus, "pending"),
        eq(schema.conversationAgentSessionHistory.cleanupStatus, "failed"),
      ),
    ))
    .limit(1);
  if (blocked.length > 0) throw new Error("Managed session cleanup is still pending");
}

async function insertSessionActivation(
  transaction: RelayStorageTransaction,
  record: ConversationAgentBindingRecord,
  activation?: RuntimeSessionActivation,
): Promise<void> {
  if (record.runtimeOwnerId !== undefined && !record.runtimeOwnerId.trim()) {
    throw new Error("Runtime owner scope must not be empty");
  }
  await assertManagedSessionReusable(transaction, record);
  const managed = record.runtimeOwnerId !== undefined;
  await transaction.insert(schema.conversationAgentSessionHistory).values({
    id: randomUUID(),
    workspaceId: record.workspaceId,
    conversationId: record.conversationId,
    agentIdentityId: record.agentIdentityId,
    workspaceAgentConfigId: record.workspaceAgentConfigId,
    bindingId: record.id,
    bindingGeneration: record.generation,
    runtimeAdapter: record.runtimeAdapter,
    managedSessionId: managed ? record.runtimeSessionId : null,
    runtimeOwnerId: managed ? record.runtimeOwnerId! : null,
    legacyRuntimeSessionRef: managed ? null : record.runtimeSessionId,
    mapping: managed ? "managed" : "legacy_unmapped",
    state: "active",
    origin: activation?.origin ?? (managed ? "started" : "migrated"),
    contextMode: activation?.contextMode ?? "with_context",
    authoredContext: activation?.authoredContext === undefined ? null : JSON.stringify(activation.authoredContext),
    conversationSequenceAtActivation: activation?.conversationSequence ?? null,
    activatedAt: record.updatedAt,
    retirementReason: null,
    cleanupAction: "none",
    cleanupStatus: managed ? "not_required" : "unknown",
    retentionStatus: "retained",
    cleanupAttemptCount: 0,
    lastCleanupAttemptAt: null,
    lastObservedRuntimeStatus: null,
    lastVerifiedAt: null,
    lastCleanupErrorCategory: null,
    createdAt: record.updatedAt,
    updatedAt: record.updatedAt,
  });
}

async function retireSessionActivation(
  transaction: RelayStorageTransaction,
  bindingId: string,
  generation: number,
  timestamp: string,
  reason: RuntimeSessionRetirementReason,
): Promise<void> {
  await transaction.update(schema.conversationAgentSessionHistory).set({
    state: "retired",
    retiredAt: timestamp,
    retirementReason: reason,
    cleanupAction: sql`CASE WHEN ${schema.conversationAgentSessionHistory.mapping} = 'managed' THEN 'suspend' ELSE 'none' END`,
    cleanupStatus: sql`CASE WHEN ${schema.conversationAgentSessionHistory.mapping} = 'managed' THEN 'pending' ELSE 'unknown' END`,
    updatedAt: timestamp,
  }).where(and(
    eq(schema.conversationAgentSessionHistory.bindingId, bindingId),
    eq(schema.conversationAgentSessionHistory.bindingGeneration, generation),
    eq(schema.conversationAgentSessionHistory.state, "active"),
  ));
}

function conversationWorkingFolder(
  row: typeof schema.conversationWorkingFolders.$inferSelect,
): ConversationWorkingFolder {
  return {
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    relativePath: row.relativePath,
    position: row.position,
    primary: row.isPrimary === 1,
  };
}

function authoredDocument(row: typeof schema.authoredDocuments.$inferSelect): AuthoredDocument {
  return { ...row, conversationId: row.conversationId ?? undefined, publishedRevision: row.publishedRevision ?? undefined };
}

export class DrizzleLibSqlRelayStorage implements RelayBindingStore {
  async listConversationPresets(workspaceId: string): Promise<ConversationPreset[]> {
    const rows = await this.database.select().from(schema.conversationPresets)
      .where(eq(schema.conversationPresets.workspaceId, workspaceId));
    return rows.map((row) => JSON.parse(row.definition) as ConversationPreset);
  }

  async putConversationPreset(preset: ConversationPreset, expectedRevision: number | null): Promise<boolean> {
    const table = schema.conversationPresets;
    if (expectedRevision === null) {
      const rows = await this.database.insert(table).values({
        workspaceId: preset.workspaceId, id: preset.id, revision: preset.revision, definition: JSON.stringify(preset),
      }).onConflictDoNothing().returning({ id: table.id });
      return rows.length === 1;
    }
    const rows = await this.database.update(table).set({ revision: preset.revision, definition: JSON.stringify(preset) })
      .where(and(eq(table.workspaceId, preset.workspaceId), eq(table.id, preset.id), eq(table.revision, expectedRevision)))
      .returning({ id: table.id });
    return rows.length === 1;
  }

  async deleteConversationPreset(workspaceId: string, presetId: string, expectedRevision: number): Promise<boolean> {
    const table = schema.conversationPresets;
    const rows = await this.database.delete(table)
      .where(and(eq(table.workspaceId, workspaceId), eq(table.id, presetId), eq(table.revision, expectedRevision)))
      .returning({ id: table.id });
    return rows.length === 1;
  }

  async getConversationCreationSetup(workspaceId: string, conversationId: string): Promise<ConversationCreationSetup | undefined> {
    const table = schema.conversationCreationSetups;
    const rows = await this.database.select().from(table)
      .where(and(eq(table.workspaceId, workspaceId), eq(table.conversationId, conversationId)));
    return rows[0] ? JSON.parse(rows[0].definition) as ConversationCreationSetup : undefined;
  }

  async putConversationCreationSetup(setup: ConversationCreationSetup): Promise<ConversationCreationSetup> {
    await this.database.insert(schema.conversationCreationSetups).values({
      workspaceId: setup.workspaceId, conversationId: setup.conversationId, definition: JSON.stringify(setup),
    }).onConflictDoNothing();
    return (await this.getConversationCreationSetup(setup.workspaceId, setup.conversationId))!;
  }

  private constructor(
    private readonly client: Client,
    private readonly database: LibSQLDatabase<typeof schema>,
  ) {}

  static async open(options: DrizzleLibSqlRelayStorageOptions): Promise<DrizzleLibSqlRelayStorage> {
    if (!options.url.startsWith("file:")) {
      throw new Error("Private Relay storage requires a local file: URL");
    }
    const client = createClient({ url: options.url });
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA busy_timeout = 5000");
    await client.execute("PRAGMA foreign_keys = ON");
    const database = drizzle(client, { schema });
    await migrate(database, {
      migrationsFolder: options.migrationsFolder ?? defaultRelayMigrationsFolder(),
    });
    return new DrizzleLibSqlRelayStorage(client, database);
  }

  async getAuthoredInvocationMessageLink(invocationId: string): Promise<AuthoredInvocationMessageLink | undefined> {
    const [row] = await this.database.select().from(schema.authoredInvocationMessageLinks)
      .where(eq(schema.authoredInvocationMessageLinks.invocationId, invocationId)).limit(1);
    return row;
  }

  async reserveAuthoredInvocationMessageLink(link: AuthoredInvocationMessageLink): Promise<AuthoredInvocationMessageLink | undefined> {
    const existing = await this.getAuthoredInvocationMessageLink(link.invocationId);
    if (existing) return existing;
    const [invocation] = await this.database.select({ id: schema.authoredSkillInvocations.id }).from(schema.authoredSkillInvocations)
      .where(eq(schema.authoredSkillInvocations.id, link.invocationId)).limit(1);
    if (!invocation) return undefined;
    // One insert is the CAS: both invocation and message IDs are independently unique.
    await this.database.insert(schema.authoredInvocationMessageLinks).values(link).onConflictDoNothing();
    return this.getAuthoredInvocationMessageLink(link.invocationId);
  }

  async getAuthoredSkillInvocationForMessage(conversationId: string, messageId: string): Promise<AuthoredSkillInvocation | undefined> {
    const [row] = await this.database.select({ invocation: schema.authoredSkillInvocations }).from(schema.authoredInvocationMessageLinks)
      .innerJoin(schema.authoredSkillInvocations, eq(schema.authoredSkillInvocations.id, schema.authoredInvocationMessageLinks.invocationId))
      .where(and(eq(schema.authoredSkillInvocations.conversationId, conversationId), eq(schema.authoredInvocationMessageLinks.messageId, messageId))).limit(1);
    return row?.invocation;
  }

  async getAuthoredSkillInvocation(conversationId: string, actorIdentityId: string, requestId: string): Promise<AuthoredSkillInvocation | undefined> {
    const [row] = await this.database.select().from(schema.authoredSkillInvocations).where(and(
      eq(schema.authoredSkillInvocations.conversationId, conversationId), eq(schema.authoredSkillInvocations.actorIdentityId, actorIdentityId),
      eq(schema.authoredSkillInvocations.requestId, requestId),
    )).limit(1);
    return row;
  }

  async reserveAuthoredSkillInvocation(invocation: AuthoredSkillInvocation): Promise<AuthoredSkillInvocation | undefined> {
    // Resolving immutable intent needs no write transaction (or write lock).
    const prior = await this.getAuthoredSkillInvocation(invocation.conversationId, invocation.actorIdentityId, invocation.requestId);
    if (prior) return prior;
    try {
      return await this.database.transaction(async transaction => {
        const [existing] = await transaction.select().from(schema.authoredSkillInvocations).where(and(
          eq(schema.authoredSkillInvocations.conversationId, invocation.conversationId),
          eq(schema.authoredSkillInvocations.actorIdentityId, invocation.actorIdentityId),
          eq(schema.authoredSkillInvocations.requestId, invocation.requestId),
        )).limit(1);
        if (existing) return existing;
        if (!invocation.targets.length || new Set(invocation.targets.map(target => target.identityId)).size !== invocation.targets.length) return undefined;
        const [document] = await transaction.select().from(schema.authoredDocuments).where(and(
          eq(schema.authoredDocuments.id, invocation.documentId), eq(schema.authoredDocuments.workspaceId, invocation.workspaceId),
        )).limit(1);
        if (!invocationDocumentMatches(invocation, document ? authoredDocument(document) : undefined)) return undefined;
        const [publication] = await transaction.select().from(schema.authoredDocumentRevisions).where(and(
          eq(schema.authoredDocumentRevisions.documentId, invocation.documentId), eq(schema.authoredDocumentRevisions.workspaceId, invocation.workspaceId),
          eq(schema.authoredDocumentRevisions.revision, invocation.revision), eq(schema.authoredDocumentRevisions.contentHash, invocation.contentHash),
        )).limit(1);
        if (!publication) return undefined;
        for (const target of invocation.targets) {
          const [record] = await transaction.select().from(schema.conversationAgentBindings)
            .where(eq(schema.conversationAgentBindings.id, target.bindingId)).limit(1);
          const [activation] = await transaction.select().from(schema.conversationAgentSessionHistory).where(and(
            eq(schema.conversationAgentSessionHistory.bindingId, target.bindingId),
            eq(schema.conversationAgentSessionHistory.bindingGeneration, target.generation),
          )).limit(1);
          if (!invocationTargetMatches(invocation, target, record ? binding(record) : undefined, activation ? sessionHistory(activation) : undefined)) return undefined;
        }
        const [created] = await transaction.insert(schema.authoredSkillInvocations).values(invocation).onConflictDoNothing().returning();
        return created;
      });
    } catch (error) {
      const failure = error as { code?: string; cause?: { code?: string } };
      if (failure.code === "SQLITE_BUSY" || failure.cause?.code === "SQLITE_BUSY") return undefined;
      throw error;
    }
  }

  async createAuthoredDocument(document: AuthoredDocument): Promise<AuthoredDocument | undefined> {
    const rows = await this.database.insert(schema.authoredDocuments).values({
      ...document,
      conversationId: document.conversationId ?? null,
      publishedRevision: document.publishedRevision ?? null,
    }).onConflictDoNothing().returning();
    return rows[0] ? authoredDocument(rows[0]) : undefined;
  }

  async getAuthoredDocument(workspaceId: string, documentId: string): Promise<AuthoredDocument | undefined> {
    const [row] = await this.database.select().from(schema.authoredDocuments).where(and(
      eq(schema.authoredDocuments.workspaceId, workspaceId), eq(schema.authoredDocuments.id, documentId),
    )).limit(1);
    return row ? authoredDocument(row) : undefined;
  }

  async listAuthoredDocuments(workspaceId: string): Promise<AuthoredDocument[]> {
    const rows = await this.database.select().from(schema.authoredDocuments)
      .where(eq(schema.authoredDocuments.workspaceId, workspaceId)).orderBy(asc(schema.authoredDocuments.id));
    return rows.map(authoredDocument);
  }

  async mutateAuthoredDocument(
    workspaceId: string,
    documentId: string,
    mutation: AuthoredDocumentMutation,
  ): Promise<AuthoredDocument | undefined> {
    try {
      return await this.database.transaction(async (transaction) => {
        const [row] = await transaction.select().from(schema.authoredDocuments).where(and(
          eq(schema.authoredDocuments.workspaceId, workspaceId), eq(schema.authoredDocuments.id, documentId),
        )).limit(1);
        if (!row) return undefined;
        const next = reviseAuthoredDocument(authoredDocument(row), mutation);
        if (!next) return undefined;
        const updated = await transaction.update(schema.authoredDocuments).set({
          name: next.document.name, description: next.document.description, content: next.document.content,
          version: next.document.version, publishedRevision: next.document.publishedRevision ?? null,
          state: next.document.state, updatedBy: next.document.updatedBy, updatedAt: next.document.updatedAt,
        }).where(and(
          eq(schema.authoredDocuments.workspaceId, workspaceId), eq(schema.authoredDocuments.id, documentId),
          eq(schema.authoredDocuments.version, mutation.expectedVersion), eq(schema.authoredDocuments.state, "active"),
        )).returning();
        if (!updated[0]) return undefined;
        if (next.publication) await transaction.insert(schema.authoredDocumentRevisions).values(next.publication);
        return authoredDocument(updated[0]);
      });
    } catch (error) {
      const failure = error as { code?: string; cause?: { code?: string } };
      // A competing SQLite writer is a conflict, never a reason to replay a publication automatically.
      if (failure.code === "SQLITE_BUSY" || failure.cause?.code === "SQLITE_BUSY") return undefined;
      throw error;
    }
  }

  async listAuthoredDocumentRevisions(workspaceId: string, documentId: string): Promise<AuthoredDocumentRevision[]> {
    return this.database.select().from(schema.authoredDocumentRevisions).where(and(
      eq(schema.authoredDocumentRevisions.workspaceId, workspaceId),
      eq(schema.authoredDocumentRevisions.documentId, documentId),
    )).orderBy(asc(schema.authoredDocumentRevisions.revision));
  }

  async putWorkspaceConfig(config: LocalWorkspaceConfig): Promise<LocalWorkspaceConfig> {
    await this.database.insert(schema.localWorkspaceConfigs).values({
      ...config,
      idleSleepTimeoutMs: config.idleSleepTimeoutMs ?? null,
      runtimeModelPolicies: config.runtimeModelPolicies
        ? JSON.stringify(config.runtimeModelPolicies)
        : null,
    }).onConflictDoUpdate({
      target: schema.localWorkspaceConfigs.workspaceId,
      set: {
        rootUri: config.rootUri,
        notesFolderId: config.notesFolderId ?? null,
        idleSleepTimeoutMs: config.idleSleepTimeoutMs ?? null,
        runtimeModelPolicies: config.runtimeModelPolicies
          ? JSON.stringify(config.runtimeModelPolicies)
          : null,
        updatedAt: config.updatedAt,
      },
    });
    return (await this.getWorkspaceConfig(config.workspaceId))!;
  }

  async getWorkspaceConfig(workspaceId: string): Promise<LocalWorkspaceConfig | undefined> {
    const row = await this.database.query.localWorkspaceConfigs.findFirst({
      where: eq(schema.localWorkspaceConfigs.workspaceId, workspaceId),
    });
    return row ? workspaceConfig(row) : undefined;
  }

  async getConversationWorkingFolders(
    workspaceId: string,
    conversationId: string,
  ): Promise<ConversationWorkingFolder[]> {
    const rows = await this.database.select().from(schema.conversationWorkingFolders)
      .where(and(
        eq(schema.conversationWorkingFolders.workspaceId, workspaceId),
        eq(schema.conversationWorkingFolders.conversationId, conversationId),
      ))
      .orderBy(asc(schema.conversationWorkingFolders.position));
    return rows.map(conversationWorkingFolder);
  }

  async replaceConversationWorkingFolders(
    workspaceId: string,
    conversationId: string,
    folders: readonly ConversationWorkingFolder[],
  ): Promise<ConversationWorkingFolder[]> {
    validateConversationWorkingFolders(workspaceId, conversationId, folders);
    const replacement = folders.map((folder) => ({ ...folder }))
      .sort((left, right) => left.position - right.position);
    const timestamp = new Date().toISOString();
    await this.database.transaction(async (transaction) => {
      const existing = await transaction.select({
        relativePath: schema.conversationWorkingFolders.relativePath,
        createdAt: schema.conversationWorkingFolders.createdAt,
      }).from(schema.conversationWorkingFolders).where(and(
        eq(schema.conversationWorkingFolders.workspaceId, workspaceId),
        eq(schema.conversationWorkingFolders.conversationId, conversationId),
      ));
      const createdAtByPath = new Map(existing.map((row) => [row.relativePath, row.createdAt]));
      await transaction.delete(schema.conversationWorkingFolders).where(and(
        eq(schema.conversationWorkingFolders.workspaceId, workspaceId),
        eq(schema.conversationWorkingFolders.conversationId, conversationId),
      ));
      if (replacement.length > 0) {
        await transaction.insert(schema.conversationWorkingFolders).values(replacement.map((folder) => ({
          workspaceId,
          conversationId: conversationId,
          relativePath: folder.relativePath,
          position: folder.position,
          isPrimary: folder.primary ? 1 : 0,
          createdAt: createdAtByPath.get(folder.relativePath) ?? timestamp,
          updatedAt: timestamp,
        })));
      }
    });
    return replacement;
  }

  async putAgentConfig(config: WorkspaceAgentConfig): Promise<WorkspaceAgentConfig> {
    const values = { ...config, skillIds: config.skillIds ? JSON.stringify(config.skillIds) : null };
    await this.database.insert(schema.workspaceAgentConfigs).values(values).onConflictDoUpdate({
      target: [
        schema.workspaceAgentConfigs.workspaceId,
        schema.workspaceAgentConfigs.agentIdentityId,
      ],
      set: {
        personaRef: config.personaRef ?? null,
        personaPrompt: config.personaPrompt ?? null,
        runtimeAdapter: config.runtimeAdapter ?? null,
        modelProvider: config.modelProvider ?? null,
        modelId: config.modelId ?? null,
        reasoningLevel: config.reasoningLevel ?? null,
        skillIds: config.skillIds ? JSON.stringify(config.skillIds) : null,
        handoffSummaryTokens: config.handoffSummaryTokens ?? null,
        recentContextTokens: config.recentContextTokens ?? null,
        recentContextMessages: config.recentContextMessages ?? null,
        status: config.status,
        updatedAt: config.updatedAt,
      },
    });
    return (await this.getWorkspaceAgentConfig(config.workspaceId, config.agentIdentityId))!;
  }

  async getAgentConfig(configId: string): Promise<WorkspaceAgentConfig | undefined> {
    const row = await this.database.query.workspaceAgentConfigs.findFirst({
      where: eq(schema.workspaceAgentConfigs.id, configId),
    });
    return row ? agentConfig(row) : undefined;
  }

  async getWorkspaceAgentConfig(
    workspaceId: string,
    agentIdentityId: string,
  ): Promise<WorkspaceAgentConfig | undefined> {
    const row = await this.database.query.workspaceAgentConfigs.findFirst({
      where: and(
        eq(schema.workspaceAgentConfigs.workspaceId, workspaceId),
        eq(schema.workspaceAgentConfigs.agentIdentityId, agentIdentityId),
      ),
    });
    return row ? agentConfig(row) : undefined;
  }

  async listWorkspaceAgentConfigs(workspaceId: string): Promise<WorkspaceAgentConfig[]> {
    const rows = await this.database.select().from(schema.workspaceAgentConfigs)
      .where(eq(schema.workspaceAgentConfigs.workspaceId, workspaceId))
      .orderBy(asc(schema.workspaceAgentConfigs.createdAt));
    return rows.map(agentConfig);
  }

  async getOrCreateRuntimeOwnerId(): Promise<string> {
    await this.database.insert(schema.localRuntimeOwners).values({
      id: "local",
      ownerId: randomUUID(),
      createdAt: new Date().toISOString(),
    }).onConflictDoNothing({ target: schema.localRuntimeOwners.id });
    const row = await this.database.query.localRuntimeOwners.findFirst({
      where: eq(schema.localRuntimeOwners.id, "local"),
    });
    if (!row) throw new Error("Could not initialize the local Runtime owner scope");
    return row.ownerId;
  }

  async putBinding(
    record: ConversationAgentBindingRecord,
    activation?: RuntimeSessionActivation,
  ): Promise<ConversationAgentBindingRecord> {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(schema.conversationAgentBindings).values({
        ...record,
        runtimeOwnerId: record.runtimeOwnerId ?? null,
        conversationId: record.conversationId,
      });
      await insertSessionActivation(transaction, record, activation);
    });
    return { ...record };
  }

  async getBinding(bindingId: string): Promise<ConversationAgentBindingRecord | undefined> {
    const row = await this.database.query.conversationAgentBindings.findFirst({
      where: eq(schema.conversationAgentBindings.id, bindingId),
    });
    return row ? binding(row) : undefined;
  }

  async deleteBinding(bindingId: string): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.database.transaction(async (transaction) => {
      const existing = await transaction.query.conversationAgentBindings.findFirst({
        where: eq(schema.conversationAgentBindings.id, bindingId),
      });
      if (existing) {
        await retireSessionActivation(
          transaction,
          bindingId,
          existing.generation,
          timestamp,
          "recovered",
        );
      }
      await transaction.delete(schema.conversationAgentBindings)
        .where(eq(schema.conversationAgentBindings.id, bindingId));
    });
  }

  async getSessionInspectionRecords(workspaceId: string, conversationId: string, agentIdentityId: string) {
    const rows = await this.database.select().from(schema.conversationAgentBindings).where(and(
      eq(schema.conversationAgentBindings.workspaceId, workspaceId), eq(schema.conversationAgentBindings.conversationId, conversationId),
      eq(schema.conversationAgentBindings.agentIdentityId, agentIdentityId),
    )).limit(2);
    const bindings = rows.map(binding);
    if (bindings.length !== 1) return { bindings };
    const current = bindings[0]!;
    const history = await this.database.select().from(schema.conversationAgentSessionHistory).where(and(
      eq(schema.conversationAgentSessionHistory.bindingId, current.id), eq(schema.conversationAgentSessionHistory.bindingGeneration, current.generation),
      eq(schema.conversationAgentSessionHistory.workspaceId, workspaceId), eq(schema.conversationAgentSessionHistory.conversationId, conversationId),
      eq(schema.conversationAgentSessionHistory.agentIdentityId, agentIdentityId),
    )).limit(2);
    if (history.length > 1) throw new Error("Session activation is ambiguous");
    return { bindings, ...(history[0] ? { activation: sessionHistory(history[0]) } : {}) };
  }

  async listSessionHistory(
    conversationId: string,
    agentIdentityId?: string,
  ): Promise<RuntimeSessionHistoryRecord[]> {
    const rows = await this.database.select().from(schema.conversationAgentSessionHistory)
      .where(and(
        eq(schema.conversationAgentSessionHistory.conversationId, conversationId),
        ...(agentIdentityId ? [eq(schema.conversationAgentSessionHistory.agentIdentityId, agentIdentityId)] : []),
      ))
      .orderBy(asc(schema.conversationAgentSessionHistory.activatedAt));
    return rows.map(sessionHistory);
  }

  async listPendingSessionCleanups(limit: number): Promise<RuntimeSessionHistoryRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Session cleanup limit must be between 1 and 100");
    }
    const rows = await this.database.select().from(schema.conversationAgentSessionHistory)
      .where(and(
        ne(schema.conversationAgentSessionHistory.cleanupAction, "none"),
        or(
          eq(schema.conversationAgentSessionHistory.cleanupStatus, "pending"),
          and(
            eq(schema.conversationAgentSessionHistory.cleanupStatus, "failed"),
            lt(schema.conversationAgentSessionHistory.cleanupAttemptCount, 5),
          ),
        ),
      ))
      .orderBy(asc(schema.conversationAgentSessionHistory.updatedAt))
      .limit(limit);
    return rows.map(sessionHistory);
  }

  async recordSessionCleanupAttempt(input: RuntimeSessionCleanupAttempt): Promise<void> {
    await this.database.update(schema.conversationAgentSessionHistory).set({
      cleanupAttemptCount: sql`${schema.conversationAgentSessionHistory.cleanupAttemptCount} + 1`,
      lastCleanupAttemptAt: input.attemptedAt,
      lastObservedRuntimeStatus: input.observedRuntimeStatus,
      cleanupStatus: input.outcome,
      ...(input.cleanupAction ? { cleanupAction: input.cleanupAction } : {}),
      ...(input.retentionOutcome ? { retentionStatus: input.retentionOutcome } : {}),
      lastVerifiedAt: input.attemptedAt,
      lastCleanupErrorCategory: input.outcome === "failed" ? input.errorCategory ?? "operation_failed" : null,
      updatedAt: input.attemptedAt,
    }).where(and(
      eq(schema.conversationAgentSessionHistory.bindingId, input.bindingId),
      eq(schema.conversationAgentSessionHistory.bindingGeneration, input.bindingGeneration),
      eq(schema.conversationAgentSessionHistory.state, "retired"),
      ne(schema.conversationAgentSessionHistory.cleanupAction, "none"),
    ));
  }

  async listConversationBindings(conversationId: string): Promise<ConversationAgentBindingRecord[]> {
    const rows = await this.database.select().from(schema.conversationAgentBindings)
      .where(eq(schema.conversationAgentBindings.conversationId, conversationId))
      .orderBy(asc(schema.conversationAgentBindings.createdAt));
    return rows.map(binding);
  }

  async listWorkspaceBindings(workspaceId: string): Promise<ConversationAgentBindingRecord[]> {
    const rows = await this.database.select().from(schema.conversationAgentBindings)
      .where(eq(schema.conversationAgentBindings.workspaceId, workspaceId))
      .orderBy(asc(schema.conversationAgentBindings.createdAt));
    return rows.map(binding);
  }

  async acquireBindingLease(
    bindingId: string,
    leaseOwner: string,
    now: string,
    leaseExpiresAt: string,
    expected?: Pick<ConversationAgentBindingRecord, "generation" | "state">,
  ): Promise<ConversationAgentBindingRecord | undefined> {
    const rows = await this.database.update(schema.conversationAgentBindings).set({
      leaseOwner,
      leaseExpiresAt,
      updatedAt: now,
    }).where(and(
      eq(schema.conversationAgentBindings.id, bindingId),
      ne(schema.conversationAgentBindings.state, "disabled"),
      ne(schema.conversationAgentBindings.state, "stopping"),
      ...(expected ? [
        eq(schema.conversationAgentBindings.generation, expected.generation),
        eq(schema.conversationAgentBindings.state, expected.state),
      ] : []),
      or(
        isNull(schema.conversationAgentBindings.leaseOwner),
        eq(schema.conversationAgentBindings.leaseOwner, leaseOwner),
        isNull(schema.conversationAgentBindings.leaseExpiresAt),
        lte(schema.conversationAgentBindings.leaseExpiresAt, now),
      ),
    )).returning();
    return rows[0] ? binding(rows[0]) : undefined;
  }

  async renewBindingLease(
    bindingId: string,
    generation: number,
    leaseOwner: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean> {
    const rows = await this.database.update(schema.conversationAgentBindings).set({
      leaseExpiresAt,
      updatedAt: now,
    }).where(and(
      eq(schema.conversationAgentBindings.id, bindingId),
      eq(schema.conversationAgentBindings.generation, generation),
      eq(schema.conversationAgentBindings.leaseOwner, leaseOwner),
      gt(schema.conversationAgentBindings.leaseExpiresAt, now),
    )).returning({ id: schema.conversationAgentBindings.id });
    return rows.length === 1;
  }

  async releaseBindingLease(
    bindingId: string,
    generation: number,
    leaseOwner: string,
  ): Promise<void> {
    await this.database.update(schema.conversationAgentBindings).set({
      leaseOwner: null,
      leaseExpiresAt: null,
    }).where(and(
      eq(schema.conversationAgentBindings.id, bindingId),
      eq(schema.conversationAgentBindings.generation, generation),
      eq(schema.conversationAgentBindings.leaseOwner, leaseOwner),
    ));
  }

  async updateBindingState(
    bindingId: string,
    generation: number,
    leaseOwner: string,
    state: ConversationAgentBindingState,
    lastVerifiedAt: string | undefined,
    updatedAt: string,
    expectedState?: ConversationAgentBindingState,
    lifecycle?: {
      lastActiveAt?: string | null;
      sleptAt?: string | null;
      wakeRequestedAt?: string | null;
      managedSessionMissingAt?: string | null;
    },
  ): Promise<ConversationAgentBindingRecord | undefined> {
    const rows = await this.database.update(schema.conversationAgentBindings).set({
      state,
      lastVerifiedAt,
      updatedAt,
      ...(lifecycle?.lastActiveAt !== undefined ? { lastActiveAt: lifecycle.lastActiveAt } : {}),
      ...(lifecycle?.sleptAt !== undefined ? { sleptAt: lifecycle.sleptAt } : {}),
      ...(lifecycle?.wakeRequestedAt !== undefined ? { wakeRequestedAt: lifecycle.wakeRequestedAt } : {}),
      ...(lifecycle?.managedSessionMissingAt !== undefined
        ? { managedSessionMissingAt: lifecycle.managedSessionMissingAt }
        : {}),
      ...(state === "connected" ? { managedSessionMissingAt: null } : {}),
    }).where(and(
      eq(schema.conversationAgentBindings.id, bindingId),
      eq(schema.conversationAgentBindings.generation, generation),
      eq(schema.conversationAgentBindings.leaseOwner, leaseOwner),
      ...(expectedState ? [eq(schema.conversationAgentBindings.state, expectedState)] : []),
      gt(schema.conversationAgentBindings.leaseExpiresAt, updatedAt),
    )).returning();
    return rows[0] ? binding(rows[0]) : undefined;
  }

  async replaceBindingSession(
    bindingId: string,
    expectedGeneration: number,
    runtimeAdapter: string,
    runtimeSessionId: string,
    updatedAt: string,
    runtimeOwnerId?: string,
    activation?: RuntimeSessionActivation,
    recoveryLeaseOwner?: string,
  ): Promise<ConversationAgentBindingRecord | undefined> {
    if (recoveryLeaseOwner !== undefined
      && (!Number.isSafeInteger(activation?.conversationSequence) || activation!.conversationSequence! < 0)) {
      throw new Error("Recovery requires a valid no-replay boundary");
    }
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.update(schema.conversationAgentBindings).set({
        runtimeAdapter,
        runtimeSessionId,
        runtimeOwnerId: runtimeOwnerId ?? null,
        generation: expectedGeneration + 1,
        // Reconciliation marks it connected only after the new Runtime is verified and leased.
        state: "replacing",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastVerifiedAt: null,
        lastActiveAt: updatedAt,
        sleptAt: null,
        wakeRequestedAt: null,
        managedSessionMissingAt: null,
        updatedAt,
      }).where(and(
        eq(schema.conversationAgentBindings.id, bindingId),
        eq(schema.conversationAgentBindings.generation, expectedGeneration),
        ...(recoveryLeaseOwner !== undefined ? [
          eq(schema.conversationAgentBindings.state, "stopping"),
          eq(schema.conversationAgentBindings.leaseOwner, recoveryLeaseOwner),
          gt(schema.conversationAgentBindings.leaseExpiresAt, updatedAt),
        ] : [or(ne(schema.conversationAgentBindings.state, "stopping"), isNull(schema.conversationAgentBindings.leaseOwner))]),
      )).returning();
      if (!rows[0]) return undefined;
      await retireSessionActivation(transaction, bindingId, expectedGeneration, updatedAt, "replaced");
      const replacement = binding(rows[0]);
      await insertSessionActivation(transaction, replacement, activation);
      if (recoveryLeaseOwner !== undefined) {
        await advanceRecoveryCursor(transaction, replacement.conversationId, replacement.agentIdentityId,
          activation!.conversationSequence!, updatedAt);
      }
      return replacement;
    });
  }

  async beginBindingRecovery(
    bindingId: string, expectedGeneration: number,
    expectedState: Exclude<ConversationAgentBindingState, "disabled">,
    leaseOwner: string, now: string, leaseExpiresAt: string,
  ): Promise<ConversationAgentBindingRecord | undefined> {
    const rows = await this.database.update(schema.conversationAgentBindings).set({
      state: "stopping", leaseOwner, leaseExpiresAt, lastVerifiedAt: null, wakeRequestedAt: null, updatedAt: now,
    }).where(and(
      eq(schema.conversationAgentBindings.id, bindingId),
      eq(schema.conversationAgentBindings.generation, expectedGeneration),
      eq(schema.conversationAgentBindings.state, expectedState),
      or(ne(schema.conversationAgentBindings.state, "stopping"), isNull(schema.conversationAgentBindings.leaseOwner),
        lte(schema.conversationAgentBindings.leaseExpiresAt, now)),
    )).returning();
    return rows[0] ? binding(rows[0]) : undefined;
  }

  async completeBindingRecovery(
    bindingId: string, expectedGeneration: number, leaseOwner: string,
    conversationSequence: number, state: "paused" | "replacing", now: string,
  ): Promise<ConversationAgentBindingRecord | undefined> {
    return this.database.transaction(async transaction => {
      const rows = await transaction.update(schema.conversationAgentBindings).set({
        state, updatedAt: now, leaseOwner: null, leaseExpiresAt: null,
      }).where(and(
        eq(schema.conversationAgentBindings.id, bindingId),
        eq(schema.conversationAgentBindings.generation, expectedGeneration),
        eq(schema.conversationAgentBindings.state, "stopping"),
        eq(schema.conversationAgentBindings.leaseOwner, leaseOwner),
        gt(schema.conversationAgentBindings.leaseExpiresAt, now),
      )).returning();
      if (!rows[0]) return undefined;
      await advanceRecoveryCursor(transaction, rows[0].conversationId, rows[0].agentIdentityId, conversationSequence, now);
      return binding(rows[0]);
    });
  }

  async beginStopBinding(
    bindingId: string,
    expectedGeneration: number,
    expectedState: Extract<ConversationAgentBindingState, "connected" | "sleeping" | "waking" | "offline" | "replacing" | "paused">,
    updatedAt: string,
  ): Promise<ConversationAgentBindingRecord | undefined> {
    const rows = await this.database.update(schema.conversationAgentBindings).set({
      state: "stopping",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastVerifiedAt: null,
      wakeRequestedAt: null,
      updatedAt,
    }).where(and(
      eq(schema.conversationAgentBindings.id, bindingId),
      eq(schema.conversationAgentBindings.generation, expectedGeneration),
      eq(schema.conversationAgentBindings.state, expectedState),
    )).returning();
    return rows[0] ? binding(rows[0]) : undefined;
  }

  async pauseBinding(
    bindingId: string,
    expectedGeneration: number,
    conversationSequence: number,
    updatedAt: string,
  ): Promise<ConversationAgentBindingRecord | undefined> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.update(schema.conversationAgentBindings).set({
        state: "paused",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastVerifiedAt: null,
        wakeRequestedAt: null,
        updatedAt,
      }).where(and(
        eq(schema.conversationAgentBindings.id, bindingId),
        eq(schema.conversationAgentBindings.generation, expectedGeneration),
        ne(schema.conversationAgentBindings.state, "disabled"),
        or(ne(schema.conversationAgentBindings.state, "stopping"), isNull(schema.conversationAgentBindings.leaseOwner)),
      )).returning();
      if (!rows[0]) return undefined;
      await transaction.insert(schema.agentHostCursors).values({
        conversationId: rows[0].conversationId,
        participantId: rows[0].agentIdentityId,
        lastProcessedSequence: conversationSequence,
        updatedAt,
      }).onConflictDoUpdate({
        target: [schema.agentHostCursors.conversationId, schema.agentHostCursors.participantId],
        set: {
          lastProcessedSequence: sql`max(${schema.agentHostCursors.lastProcessedSequence}, ${conversationSequence})`,
          updatedAt,
        },
      });
      return binding(rows[0]);
    });
  }

  async disableBinding(
    bindingId: string,
    expectedGeneration: number,
    updatedAt: string,
  ): Promise<ConversationAgentBindingRecord | undefined> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.update(schema.conversationAgentBindings).set({
        generation: expectedGeneration + 1,
        state: "disabled",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastVerifiedAt: null,
        wakeRequestedAt: null,
        managedSessionMissingAt: null,
        updatedAt,
      }).where(and(
        eq(schema.conversationAgentBindings.id, bindingId),
        eq(schema.conversationAgentBindings.generation, expectedGeneration),
      )).returning();
      if (!rows[0]) return undefined;
      await retireSessionActivation(transaction, bindingId, expectedGeneration, updatedAt, "stopped");
      return binding(rows[0]);
    });
  }

  async getCursor(conversationId: string, participantId: string): Promise<number> {
    const row = await this.database.query.agentHostCursors.findFirst({
      where: and(
        eq(schema.agentHostCursors.conversationId, conversationId),
        eq(schema.agentHostCursors.participantId, participantId),
      ),
    });
    return row?.lastProcessedSequence ?? 0;
  }

  async setCursor(conversationId: string, participantId: string, sequence: number): Promise<void> {
    await this.database.insert(schema.agentHostCursors).values({
      conversationId: conversationId,
      participantId,
      lastProcessedSequence: sequence,
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: [schema.agentHostCursors.conversationId, schema.agentHostCursors.participantId],
      set: {
        lastProcessedSequence: sql`max(${schema.agentHostCursors.lastProcessedSequence}, ${sequence})`,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  async recordTurnFailure(input: TurnFailureDiagnosticInput): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(schema.turnFailureDiagnostics).values({
        ...input,
        bindingId: input.bindingId ?? null,
        bindingGeneration: input.bindingGeneration ?? null,
        deliveryOutcome: "pending",
        createdAt: input.failedAt,
        updatedAt: input.failedAt,
      }).onConflictDoNothing({
        target: [
          schema.turnFailureDiagnostics.conversationId,
          schema.turnFailureDiagnostics.participantId,
          schema.turnFailureDiagnostics.triggerMessageId,
        ],
      });
      await transaction.run(sql`
        INSERT INTO ${schema.turnFailureFinalizationTombstones} (
          conversation_id, participant_id, trigger_message_id, created_at
        )
        SELECT conversation_id, participant_id, trigger_message_id, ${input.failedAt}
        FROM ${schema.turnFailureDiagnostics}
        WHERE ${schema.turnFailureDiagnostics.conversationId} = ${input.conversationId}
          AND ${schema.turnFailureDiagnostics.deliveryOutcome} = 'pending'
          AND rowid NOT IN (
            SELECT rowid FROM ${schema.turnFailureDiagnostics}
            WHERE ${schema.turnFailureDiagnostics.conversationId} = ${input.conversationId}
            ORDER BY ${schema.turnFailureDiagnostics.failedAt} DESC,
              ${schema.turnFailureDiagnostics.triggerSequence} DESC,
              ${schema.turnFailureDiagnostics.participantId} ASC
            LIMIT 100
          )
        ON CONFLICT(conversation_id, participant_id, trigger_message_id) DO NOTHING
      `);
      await transaction.run(sql`
        DELETE FROM ${schema.turnFailureDiagnostics}
        WHERE ${schema.turnFailureDiagnostics.conversationId} = ${input.conversationId}
          AND rowid NOT IN (
            SELECT rowid FROM ${schema.turnFailureDiagnostics}
            WHERE ${schema.turnFailureDiagnostics.conversationId} = ${input.conversationId}
            ORDER BY ${schema.turnFailureDiagnostics.failedAt} DESC,
              ${schema.turnFailureDiagnostics.triggerSequence} DESC,
              ${schema.turnFailureDiagnostics.participantId} ASC
            LIMIT 100
          )
      `);
    });
  }

  async commitTurnFailureDelivery(input: TurnFailureDeliveryInput): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const matching = await transaction.select({
        deliveryOutcome: schema.turnFailureDiagnostics.deliveryOutcome,
      }).from(schema.turnFailureDiagnostics).where(and(
        eq(schema.turnFailureDiagnostics.conversationId, input.conversationId),
        eq(schema.turnFailureDiagnostics.participantId, input.participantId),
        eq(schema.turnFailureDiagnostics.triggerMessageId, input.triggerMessageId),
      )).limit(1);
      const tombstone = matching[0] ? [] : await transaction.select({
        createdAt: schema.turnFailureFinalizationTombstones.createdAt,
      }).from(schema.turnFailureFinalizationTombstones).where(and(
        eq(schema.turnFailureFinalizationTombstones.conversationId, input.conversationId),
        eq(schema.turnFailureFinalizationTombstones.participantId, input.participantId),
        eq(schema.turnFailureFinalizationTombstones.triggerMessageId, input.triggerMessageId),
      )).limit(1);
      const cursor = await transaction.select({
        lastProcessedSequence: schema.agentHostCursors.lastProcessedSequence,
      }).from(schema.agentHostCursors).where(and(
        eq(schema.agentHostCursors.conversationId, input.conversationId),
        eq(schema.agentHostCursors.participantId, input.participantId),
      )).limit(1);
      if (!matching[0] && !tombstone[0] && (cursor[0]?.lastProcessedSequence ?? 0) < input.triggerSequence) {
        throw new Error("Matching turn-failure diagnostic is unavailable");
      }
      await transaction.update(schema.turnFailureDiagnostics).set({
        deliveryOutcome: input.outcome,
        updatedAt: input.recordedAt,
      }).where(and(
        eq(schema.turnFailureDiagnostics.conversationId, input.conversationId),
        eq(schema.turnFailureDiagnostics.participantId, input.participantId),
        eq(schema.turnFailureDiagnostics.triggerMessageId, input.triggerMessageId),
        eq(schema.turnFailureDiagnostics.deliveryOutcome, "pending"),
      ));
      await transaction.insert(schema.agentHostCursors).values({
        conversationId: input.conversationId,
        participantId: input.participantId,
        lastProcessedSequence: input.triggerSequence,
        updatedAt: input.recordedAt,
      }).onConflictDoUpdate({
        target: [schema.agentHostCursors.conversationId, schema.agentHostCursors.participantId],
        set: {
          lastProcessedSequence: sql`max(${schema.agentHostCursors.lastProcessedSequence}, ${input.triggerSequence})`,
          updatedAt: input.recordedAt,
        },
      });
      if (tombstone[0]) {
        await transaction.delete(schema.turnFailureFinalizationTombstones).where(and(
          eq(schema.turnFailureFinalizationTombstones.conversationId, input.conversationId),
          eq(schema.turnFailureFinalizationTombstones.participantId, input.participantId),
          eq(schema.turnFailureFinalizationTombstones.triggerMessageId, input.triggerMessageId),
        ));
      }
    });
  }

  async listTurnFailures(conversationId: string, limit: number): Promise<TurnFailureDiagnosticRecord[]> {
    const rows = await this.database.select().from(schema.turnFailureDiagnostics)
      .where(eq(schema.turnFailureDiagnostics.conversationId, conversationId))
      .orderBy(
        desc(schema.turnFailureDiagnostics.failedAt),
        desc(schema.turnFailureDiagnostics.triggerSequence),
        asc(schema.turnFailureDiagnostics.participantId),
      )
      .limit(limit);
    return rows.map((row) => ({
      ...row,
      bindingId: row.bindingId ?? undefined,
      bindingGeneration: row.bindingGeneration ?? undefined,
    }));
  }

  async commitDeliveryDeadLetter(input: DeliveryDeadLetterInput): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(schema.deliveryDeadLetters).values({
        conversationId: input.conversationId,
        participantId: input.participantId,
        triggerMessageId: input.triggerMessageId,
        triggerSequence: input.triggerSequence,
        reason: input.reason,
        createdAt: input.recordedAt,
        updatedAt: input.recordedAt,
      }).onConflictDoNothing({
        target: [
          schema.deliveryDeadLetters.conversationId,
          schema.deliveryDeadLetters.participantId,
          schema.deliveryDeadLetters.triggerMessageId,
        ],
      });
      const matching = input.requiresTurnFailure ? await transaction.select({
        deliveryOutcome: schema.turnFailureDiagnostics.deliveryOutcome,
      }).from(schema.turnFailureDiagnostics).where(and(
        eq(schema.turnFailureDiagnostics.conversationId, input.conversationId),
        eq(schema.turnFailureDiagnostics.participantId, input.participantId),
        eq(schema.turnFailureDiagnostics.triggerMessageId, input.triggerMessageId),
      )).limit(1) : [];
      const tombstone = input.requiresTurnFailure && !matching[0] ? await transaction.select({
        createdAt: schema.turnFailureFinalizationTombstones.createdAt,
      }).from(schema.turnFailureFinalizationTombstones).where(and(
        eq(schema.turnFailureFinalizationTombstones.conversationId, input.conversationId),
        eq(schema.turnFailureFinalizationTombstones.participantId, input.participantId),
        eq(schema.turnFailureFinalizationTombstones.triggerMessageId, input.triggerMessageId),
      )).limit(1) : [];
      const cursor = await transaction.select({
        lastProcessedSequence: schema.agentHostCursors.lastProcessedSequence,
      }).from(schema.agentHostCursors).where(and(
        eq(schema.agentHostCursors.conversationId, input.conversationId),
        eq(schema.agentHostCursors.participantId, input.participantId),
      )).limit(1);
      if (input.requiresTurnFailure && !matching[0] && !tombstone[0]
        && (cursor[0]?.lastProcessedSequence ?? 0) < input.triggerSequence) {
        throw new Error("Matching turn-failure diagnostic is unavailable");
      }
      await transaction.update(schema.turnFailureDiagnostics).set({
        deliveryOutcome: input.reason,
        updatedAt: input.recordedAt,
      }).where(and(
        eq(schema.turnFailureDiagnostics.conversationId, input.conversationId),
        eq(schema.turnFailureDiagnostics.participantId, input.participantId),
        eq(schema.turnFailureDiagnostics.triggerMessageId, input.triggerMessageId),
        eq(schema.turnFailureDiagnostics.deliveryOutcome, "pending"),
      ));
      await transaction.insert(schema.agentHostCursors).values({
        conversationId: input.conversationId,
        participantId: input.participantId,
        lastProcessedSequence: input.triggerSequence,
        updatedAt: input.recordedAt,
      }).onConflictDoUpdate({
        target: [schema.agentHostCursors.conversationId, schema.agentHostCursors.participantId],
        set: {
          lastProcessedSequence: sql`max(${schema.agentHostCursors.lastProcessedSequence}, ${input.triggerSequence})`,
          updatedAt: input.recordedAt,
        },
      });
      if (tombstone[0]) {
        await transaction.delete(schema.turnFailureFinalizationTombstones).where(and(
          eq(schema.turnFailureFinalizationTombstones.conversationId, input.conversationId),
          eq(schema.turnFailureFinalizationTombstones.participantId, input.participantId),
          eq(schema.turnFailureFinalizationTombstones.triggerMessageId, input.triggerMessageId),
        ));
      }
    });
  }

  async listDeliveryDeadLetters(
    conversationId: string,
    participantId: string,
  ): Promise<DeliveryDeadLetterRecord[]> {
    const rows = await this.database.select().from(schema.deliveryDeadLetters)
      .where(and(
        eq(schema.deliveryDeadLetters.conversationId, conversationId),
        eq(schema.deliveryDeadLetters.participantId, participantId),
      ))
      .orderBy(asc(schema.deliveryDeadLetters.triggerSequence));
    return rows.map(({ conversationId, ...row }) => ({ ...row, conversationId: conversationId }));
  }

  async close(): Promise<void> {
    this.client.close();
  }
}
