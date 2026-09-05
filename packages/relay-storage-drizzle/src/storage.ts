import { createClient, type Client } from "@libsql/client";
import type {
  ChannelAgentBindingRecord,
  ChannelAgentBindingState,
  LocalWorkspaceConfig,
  RelayBindingStore,
  RuntimeModelRef,
  WorkspaceAgentConfig,
} from "@minu/channels-relay";
import { and, asc, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm";
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

function defaultMigrationsFolder(): string {
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
  return {
    ...row,
    personaRef: row.personaRef ?? undefined,
    personaPrompt: row.personaPrompt ?? undefined,
    runtimeAdapter: row.runtimeAdapter ?? undefined,
    modelProvider: row.modelProvider ?? undefined,
    modelId: row.modelId ?? undefined,
    reasoningLevel: row.reasoningLevel ?? undefined,
  };
}

function binding(row: typeof schema.channelAgentBindings.$inferSelect): ChannelAgentBindingRecord {
  return {
    ...row,
    executionEnvironmentId: row.executionEnvironmentId ?? undefined,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt ?? undefined,
    lastVerifiedAt: row.lastVerifiedAt ?? undefined,
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
      migrationsFolder: options.migrationsFolder ?? defaultMigrationsFolder(),
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

  async putAgentConfig(config: WorkspaceAgentConfig): Promise<WorkspaceAgentConfig> {
    await this.database.insert(schema.workspaceAgentConfigs).values(config).onConflictDoUpdate({
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

  async putBinding(record: ChannelAgentBindingRecord): Promise<ChannelAgentBindingRecord> {
    await this.database.insert(schema.channelAgentBindings).values(record);
    return { ...record };
  }

  async getBinding(bindingId: string): Promise<ChannelAgentBindingRecord | undefined> {
    const row = await this.database.query.channelAgentBindings.findFirst({
      where: eq(schema.channelAgentBindings.id, bindingId),
    });
    return row ? binding(row) : undefined;
  }

  async deleteBinding(bindingId: string): Promise<void> {
    await this.database.delete(schema.channelAgentBindings)
      .where(eq(schema.channelAgentBindings.id, bindingId));
  }

  async listChannelBindings(channelId: string): Promise<ChannelAgentBindingRecord[]> {
    const rows = await this.database.select().from(schema.channelAgentBindings)
      .where(eq(schema.channelAgentBindings.channelId, channelId))
      .orderBy(asc(schema.channelAgentBindings.createdAt));
    return rows.map(binding);
  }

  async listWorkspaceBindings(workspaceId: string): Promise<ChannelAgentBindingRecord[]> {
    const rows = await this.database.select().from(schema.channelAgentBindings)
      .where(eq(schema.channelAgentBindings.workspaceId, workspaceId))
      .orderBy(asc(schema.channelAgentBindings.createdAt));
    return rows.map(binding);
  }

  async acquireBindingLease(
    bindingId: string,
    leaseOwner: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<ChannelAgentBindingRecord | undefined> {
    const rows = await this.database.update(schema.channelAgentBindings).set({
      leaseOwner,
      leaseExpiresAt,
      updatedAt: now,
    }).where(and(
      eq(schema.channelAgentBindings.id, bindingId),
      ne(schema.channelAgentBindings.state, "disabled"),
      or(
        isNull(schema.channelAgentBindings.leaseOwner),
        eq(schema.channelAgentBindings.leaseOwner, leaseOwner),
        isNull(schema.channelAgentBindings.leaseExpiresAt),
        lte(schema.channelAgentBindings.leaseExpiresAt, now),
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
    const rows = await this.database.update(schema.channelAgentBindings).set({
      leaseExpiresAt,
      updatedAt: now,
    }).where(and(
      eq(schema.channelAgentBindings.id, bindingId),
      eq(schema.channelAgentBindings.generation, generation),
      eq(schema.channelAgentBindings.leaseOwner, leaseOwner),
      gt(schema.channelAgentBindings.leaseExpiresAt, now),
    )).returning({ id: schema.channelAgentBindings.id });
    return rows.length === 1;
  }

  async releaseBindingLease(
    bindingId: string,
    generation: number,
    leaseOwner: string,
  ): Promise<void> {
    await this.database.update(schema.channelAgentBindings).set({
      leaseOwner: null,
      leaseExpiresAt: null,
    }).where(and(
      eq(schema.channelAgentBindings.id, bindingId),
      eq(schema.channelAgentBindings.generation, generation),
      eq(schema.channelAgentBindings.leaseOwner, leaseOwner),
    ));
  }

  async updateBindingState(
    bindingId: string,
    generation: number,
    leaseOwner: string,
    state: ChannelAgentBindingState,
    lastVerifiedAt: string | undefined,
    updatedAt: string,
  ): Promise<ChannelAgentBindingRecord | undefined> {
    const rows = await this.database.update(schema.channelAgentBindings).set({
      state,
      lastVerifiedAt,
      updatedAt,
    }).where(and(
      eq(schema.channelAgentBindings.id, bindingId),
      eq(schema.channelAgentBindings.generation, generation),
      eq(schema.channelAgentBindings.leaseOwner, leaseOwner),
      gt(schema.channelAgentBindings.leaseExpiresAt, updatedAt),
    )).returning();
    return rows[0] ? binding(rows[0]) : undefined;
  }

  async replaceBindingSession(
    bindingId: string,
    expectedGeneration: number,
    runtimeAdapter: string,
    runtimeSessionId: string,
    updatedAt: string,
  ): Promise<ChannelAgentBindingRecord | undefined> {
    const rows = await this.database.update(schema.channelAgentBindings).set({
      runtimeAdapter,
      runtimeSessionId,
      generation: expectedGeneration + 1,
      state: "connected",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastVerifiedAt: null,
      updatedAt,
    }).where(and(
      eq(schema.channelAgentBindings.id, bindingId),
      eq(schema.channelAgentBindings.generation, expectedGeneration),
    )).returning();
    return rows[0] ? binding(rows[0]) : undefined;
  }

  async disableBinding(
    bindingId: string,
    expectedGeneration: number,
    updatedAt: string,
  ): Promise<ChannelAgentBindingRecord | undefined> {
    const rows = await this.database.update(schema.channelAgentBindings).set({
      generation: expectedGeneration + 1,
      state: "disabled",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastVerifiedAt: null,
      updatedAt,
    }).where(and(
      eq(schema.channelAgentBindings.id, bindingId),
      eq(schema.channelAgentBindings.generation, expectedGeneration),
    )).returning();
    return rows[0] ? binding(rows[0]) : undefined;
  }

  async getCursor(channelId: string, participantId: string): Promise<number> {
    const row = await this.database.query.agentHostCursors.findFirst({
      where: and(
        eq(schema.agentHostCursors.channelId, channelId),
        eq(schema.agentHostCursors.participantId, participantId),
      ),
    });
    return row?.lastProcessedSequence ?? 0;
  }

  async setCursor(channelId: string, participantId: string, sequence: number): Promise<void> {
    await this.database.insert(schema.agentHostCursors).values({
      channelId,
      participantId,
      lastProcessedSequence: sequence,
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: [schema.agentHostCursors.channelId, schema.agentHostCursors.participantId],
      set: {
        lastProcessedSequence: sql`max(${schema.agentHostCursors.lastProcessedSequence}, ${sequence})`,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  async close(): Promise<void> {
    this.client.close();
  }
}
