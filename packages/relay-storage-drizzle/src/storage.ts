import { createClient, type Client } from "@libsql/client";
import type {
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
  WorkspaceAgentConfig,
} from "@minu/channels-relay";
import { validateConversationWorkingFolders } from "@minu/channels-relay";
import { and, asc, desc, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
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
  return {
    ...binding,
    conversationId: conversationId,
    executionEnvironmentId: row.executionEnvironmentId ?? undefined,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt ?? undefined,
    lastVerifiedAt: row.lastVerifiedAt ?? undefined,
  };
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

export class DrizzleLibSqlRelayStorage implements RelayBindingStore {
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

  async putWorkspaceConfig(config: LocalWorkspaceConfig): Promise<LocalWorkspaceConfig> {
    await this.database.insert(schema.localWorkspaceConfigs).values({
      ...config,
      runtimeModelPolicies: config.runtimeModelPolicies
        ? JSON.stringify(config.runtimeModelPolicies)
        : null,
    }).onConflictDoUpdate({
      target: schema.localWorkspaceConfigs.workspaceId,
      set: {
        rootUri: config.rootUri,
        notesFolderId: config.notesFolderId ?? null,
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

  async putBinding(record: ConversationAgentBindingRecord): Promise<ConversationAgentBindingRecord> {
    await this.database.insert(schema.conversationAgentBindings).values({ ...record, conversationId: record.conversationId });
    return { ...record };
  }

  async getBinding(bindingId: string): Promise<ConversationAgentBindingRecord | undefined> {
    const row = await this.database.query.conversationAgentBindings.findFirst({
      where: eq(schema.conversationAgentBindings.id, bindingId),
    });
    return row ? binding(row) : undefined;
  }

  async deleteBinding(bindingId: string): Promise<void> {
    await this.database.delete(schema.conversationAgentBindings)
      .where(eq(schema.conversationAgentBindings.id, bindingId));
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
  ): Promise<ConversationAgentBindingRecord | undefined> {
    const rows = await this.database.update(schema.conversationAgentBindings).set({
      leaseOwner,
      leaseExpiresAt,
      updatedAt: now,
    }).where(and(
      eq(schema.conversationAgentBindings.id, bindingId),
      ne(schema.conversationAgentBindings.state, "disabled"),
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
  ): Promise<ConversationAgentBindingRecord | undefined> {
    const rows = await this.database.update(schema.conversationAgentBindings).set({
      state,
      lastVerifiedAt,
      updatedAt,
    }).where(and(
      eq(schema.conversationAgentBindings.id, bindingId),
      eq(schema.conversationAgentBindings.generation, generation),
      eq(schema.conversationAgentBindings.leaseOwner, leaseOwner),
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
  ): Promise<ConversationAgentBindingRecord | undefined> {
    const rows = await this.database.update(schema.conversationAgentBindings).set({
      runtimeAdapter,
      runtimeSessionId,
      generation: expectedGeneration + 1,
      // Reconciliation marks it connected only after the new Runtime is verified and leased.
      state: "replacing",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastVerifiedAt: null,
      updatedAt,
    }).where(and(
      eq(schema.conversationAgentBindings.id, bindingId),
      eq(schema.conversationAgentBindings.generation, expectedGeneration),
    )).returning();
    return rows[0] ? binding(rows[0]) : undefined;
  }

  async disableBinding(
    bindingId: string,
    expectedGeneration: number,
    updatedAt: string,
  ): Promise<ConversationAgentBindingRecord | undefined> {
    const rows = await this.database.update(schema.conversationAgentBindings).set({
      generation: expectedGeneration + 1,
      state: "disabled",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastVerifiedAt: null,
      updatedAt,
    }).where(and(
      eq(schema.conversationAgentBindings.id, bindingId),
      eq(schema.conversationAgentBindings.generation, expectedGeneration),
    )).returning();
    return rows[0] ? binding(rows[0]) : undefined;
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
