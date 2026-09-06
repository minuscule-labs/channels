import { createClient, type Client } from "@libsql/client";
import type {
  Channel,
  ChannelCursorStore,
  ChannelMessage,
  ChannelMetadata,
  ChannelRosterUpdateResult,
  ChannelStorage,
  Identity,
  MessageCommitResult,
  NewChannelMessage,
  NewResponseMessage,
  Participant,
  ResponseResult,
  Workspace,
  WorkspaceMember,
  WorkspaceMemberUpdateResult,
} from "@minu/channels-core";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.ts";

export interface DrizzleLibSqlStorageOptions {
  url: string;
  authToken?: string;
  migrationsFolder?: string;
}

function defaultMigrationsFolder(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const packageRoot = currentDirectory.endsWith("/dist/src")
    ? resolve(currentDirectory, "../..")
    : resolve(currentDirectory, "..");
  return resolve(packageRoot, "drizzle");
}

export function localLibSqlUrl(path: string): string {
  return path.startsWith("file:") ? path : `file:${resolve(path)}`;
}

const pendingMessageCommits = new Map<
  string,
  { requestFingerprint: string; commit: Promise<MessageCommitResult> }
>();
const pendingResponseCommits = new Map<string, Promise<ResponseResult>>();
const pendingWorkspaceMemberUpdates = new Map<string, Promise<unknown>>();
const pendingChannelRosterUpdates = new Map<string, Promise<unknown>>();

export class DrizzleLibSqlChannelStorage implements ChannelStorage, ChannelCursorStore {
  private constructor(
    private readonly client: Client,
    private readonly database: LibSQLDatabase<typeof schema>,
    private readonly storageKey: string,
  ) {}

  static async open(options: DrizzleLibSqlStorageOptions): Promise<DrizzleLibSqlChannelStorage> {
    const client = createClient({ url: options.url, authToken: options.authToken });
    if (options.url.startsWith("file:")) {
      await client.execute("PRAGMA journal_mode = WAL");
      await client.execute("PRAGMA busy_timeout = 5000");
    }
    const database = drizzle(client, { schema });
    await migrate(database, {
      migrationsFolder: options.migrationsFolder ?? defaultMigrationsFolder(),
    });
    return new DrizzleLibSqlChannelStorage(client, database, options.url);
  }

  async createIdentity(identity: Identity): Promise<Identity> {
    await this.database.insert(schema.identities).values(identity);
    return { ...identity };
  }

  async getIdentity(identityId: string): Promise<Identity | undefined> {
    const identity = await this.database.query.identities.findFirst({
      where: eq(schema.identities.id, identityId),
    });
    return identity ? { ...identity, displayName: identity.displayName ?? undefined, publicProfile: identity.publicProfile ?? undefined } : undefined;
  }

  async listIdentities(): Promise<Identity[]> {
    const identities = await this.database.select().from(schema.identities).orderBy(asc(schema.identities.createdAt));
    return identities.map((identity) => ({
      ...identity,
      displayName: identity.displayName ?? undefined,
      publicProfile: identity.publicProfile ?? undefined,
    }));
  }

  async createWorkspace(workspace: Workspace): Promise<Workspace> {
    await this.database.insert(schema.workspaces).values(workspace);
    return { ...workspace };
  }

  async updateWorkspace(workspace: Workspace): Promise<Workspace | undefined> {
    const [updated] = await this.database.update(schema.workspaces).set({
      name: workspace.name,
      description: workspace.description,
      status: workspace.status,
      updatedAt: workspace.updatedAt,
    }).where(eq(schema.workspaces.id, workspace.id)).returning();
    return updated ? { ...updated, description: updated.description ?? undefined } : undefined;
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | undefined> {
    const workspace = await this.database.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, workspaceId),
    });
    return workspace ? { ...workspace, description: workspace.description ?? undefined } : undefined;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const workspaces = await this.database.select().from(schema.workspaces).orderBy(asc(schema.workspaces.createdAt));
    return workspaces.map((workspace) => ({ ...workspace, description: workspace.description ?? undefined }));
  }

  async addWorkspaceMember(member: WorkspaceMember): Promise<WorkspaceMember> {
    await this.database.insert(schema.workspaceMembers).values(member);
    return { ...member };
  }

  async updateWorkspaceMember(
    member: WorkspaceMember,
    participant: Participant,
    expectedUpdatedAt: string,
  ): Promise<WorkspaceMemberUpdateResult | undefined> {
    const key = `${this.storageKey}:${member.workspaceId}`;
    const prior = pendingWorkspaceMemberUpdates.get(key) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(
      () => this.updateWorkspaceMemberOnce(member, participant, expectedUpdatedAt),
    );
    pendingWorkspaceMemberUpdates.set(key, operation);
    try {
      return await operation;
    } finally {
      if (pendingWorkspaceMemberUpdates.get(key) === operation) {
        pendingWorkspaceMemberUpdates.delete(key);
      }
    }
  }

  private async updateWorkspaceMemberOnce(
    member: WorkspaceMember,
    participant: Participant,
    expectedUpdatedAt: string,
  ): Promise<WorkspaceMemberUpdateResult | undefined> {
    return await this.database.transaction(async (transaction) => {
      const updated = await transaction.update(schema.workspaceMembers).set({
        mentionHandle: member.mentionHandle,
        accessRole: member.accessRole,
        roleLabel: member.roleLabel,
        profileOverride: member.profileOverride,
        status: member.status,
        updatedAt: member.updatedAt,
      }).where(and(
        eq(schema.workspaceMembers.workspaceId, member.workspaceId),
        eq(schema.workspaceMembers.identityId, member.identityId),
        eq(schema.workspaceMembers.updatedAt, expectedUpdatedAt),
      )).returning();
      if (!updated[0]) return undefined;
      const affected = await transaction.select({ channelId: schema.participants.channelId })
        .from(schema.participants)
        .innerJoin(schema.channels, eq(schema.channels.id, schema.participants.channelId))
        .where(and(
          eq(schema.channels.workspaceId, member.workspaceId),
          eq(schema.participants.id, member.identityId),
        ));
      const rosters: WorkspaceMemberUpdateResult["rosters"] = [];
      for (const { channelId } of affected) {
        await transaction.update(schema.participants).set({
          handle: participant.handle,
          displayName: participant.displayName,
          role: participant.role,
          profile: participant.profile,
          status: participant.status ?? "active",
        }).where(and(
          eq(schema.participants.channelId, channelId),
          eq(schema.participants.id, member.identityId),
        ));
        const revisions = await transaction.update(schema.channels).set({
          rosterRevision: sql`${schema.channels.rosterRevision} + 1`,
        }).where(eq(schema.channels.id, channelId)).returning({
          rosterRevision: schema.channels.rosterRevision,
        });
        if (member.status === "disabled") {
          const latest = await transaction.select({
            sequence: sql<number>`coalesce(max(${schema.messages.sequence}), 0)`,
          }).from(schema.messages).where(eq(schema.messages.channelId, channelId));
          await transaction.insert(schema.agentCursors).values({
            channelId,
            participantId: member.identityId,
            lastProcessedSequence: latest[0]?.sequence ?? 0,
            updatedAt: member.updatedAt,
          }).onConflictDoUpdate({
            target: [schema.agentCursors.channelId, schema.agentCursors.participantId],
            set: {
              lastProcessedSequence: sql`max(${schema.agentCursors.lastProcessedSequence}, ${latest[0]?.sequence ?? 0})`,
              updatedAt: member.updatedAt,
            },
          });
        }
        rosters.push({ channelId, rosterRevision: revisions[0]!.rosterRevision });
      }
      return { member: { ...member }, rosters };
    }, { behavior: "immediate" });
  }

  async getWorkspaceMember(
    workspaceId: string,
    identityId: string,
  ): Promise<WorkspaceMember | undefined> {
    const [member] = await this.database
      .select()
      .from(schema.workspaceMembers)
      .where(and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.identityId, identityId),
      ))
      .limit(1);
    return member ? {
      ...member,
      roleLabel: member.roleLabel ?? undefined,
      profileOverride: member.profileOverride ?? undefined,
    } : undefined;
  }

  async listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const members = await this.database
      .select()
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
      .orderBy(asc(schema.workspaceMembers.joinedAt));
    return members.map((member) => ({
      ...member,
      roleLabel: member.roleLabel ?? undefined,
      profileOverride: member.profileOverride ?? undefined,
    }));
  }

  async createChannel(channel: Channel): Promise<Channel> {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(schema.channels).values({
        id: channel.id,
        workspaceId: channel.workspaceId,
        name: channel.name,
        createdAt: channel.createdAt,
        nextSequence: 1,
        rosterRevision: channel.rosterRevision,
      });
      if (channel.participants.length > 0) {
        await transaction.insert(schema.participants).values(
          channel.participants.map((participant, position) => ({
            channelId: channel.id,
            id: participant.id,
            handle: participant.handle,
            type: participant.type,
            displayName: participant.displayName,
            role: participant.role,
            profile: participant.profile,
            status: participant.status ?? "active",
            position,
          })),
        );
      }
    });
    return {
      ...channel,
      participants: channel.participants.map((participant) => ({ ...participant })),
      messages: [],
    };
  }

  async listWorkspaceChannels(workspaceId: string): Promise<ChannelMetadata[]> {
    const channels = await this.database
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.workspaceId, workspaceId))
      .orderBy(asc(schema.channels.createdAt));
    const metadata = await Promise.all(channels.map((channel) => this.getChannelMetadata(channel.id)));
    return metadata.filter((channel): channel is ChannelMetadata => channel !== undefined);
  }

  async getChannelMetadata(channelId: string): Promise<ChannelMetadata | undefined> {
    const channel = await this.database.query.channels.findFirst({
      where: eq(schema.channels.id, channelId),
    });
    if (!channel) return undefined;
    const participants = await this.database
      .select()
      .from(schema.participants)
      .where(eq(schema.participants.channelId, channelId))
      .orderBy(asc(schema.participants.position));
    return {
      id: channel.id,
      workspaceId: channel.workspaceId ?? "legacy-default-workspace",
      name: channel.name,
      createdAt: channel.createdAt,
      rosterRevision: channel.rosterRevision,
      participants: participants.map((participant) => ({
        id: participant.id,
        handle: participant.handle ?? participant.id,
        type: participant.type,
        displayName: participant.displayName ?? undefined,
        role: participant.role ?? undefined,
        profile: participant.profile ?? undefined,
        status: participant.status,
      })),
    };
  }

  async updateChannelName(channelId: string, name: string): Promise<ChannelMetadata | undefined> {
    const updated = await this.database.update(schema.channels)
      .set({ name })
      .where(eq(schema.channels.id, channelId))
      .returning({ id: schema.channels.id });
    return updated[0] ? await this.getChannelMetadata(channelId) : undefined;
  }

  async replaceChannelParticipants(
    channelId: string,
    participants: Participant[],
    expectedRosterRevision: number,
    updatedAt: string,
  ): Promise<ChannelRosterUpdateResult | undefined> {
    const key = `${this.storageKey}:${channelId}`;
    const prior = pendingChannelRosterUpdates.get(key) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(
      () => this.replaceChannelParticipantsOnce(
        channelId,
        participants,
        expectedRosterRevision,
        updatedAt,
      ),
    );
    pendingChannelRosterUpdates.set(key, operation);
    try {
      return await operation;
    } finally {
      if (pendingChannelRosterUpdates.get(key) === operation) {
        pendingChannelRosterUpdates.delete(key);
      }
    }
  }

  private async replaceChannelParticipantsOnce(
    channelId: string,
    participants: Participant[],
    expectedRosterRevision: number,
    updatedAt: string,
  ): Promise<ChannelRosterUpdateResult | undefined> {
    return await this.database.transaction(async (transaction) => {
      const [channel] = await transaction.select({
        id: schema.channels.id,
        workspaceId: schema.channels.workspaceId,
        name: schema.channels.name,
        createdAt: schema.channels.createdAt,
      }).from(schema.channels).where(eq(schema.channels.id, channelId)).limit(1);
      const previous = await transaction.select({ id: schema.participants.id })
        .from(schema.participants)
        .where(eq(schema.participants.channelId, channelId));
      const revisions = await transaction.update(schema.channels).set({
        rosterRevision: sql`${schema.channels.rosterRevision} + 1`,
      }).where(and(
        eq(schema.channels.id, channelId),
        eq(schema.channels.rosterRevision, expectedRosterRevision),
      )).returning({ rosterRevision: schema.channels.rosterRevision });
      if (!revisions[0]) return undefined;

      await transaction.delete(schema.participants)
        .where(eq(schema.participants.channelId, channelId));
      if (participants.length > 0) {
        await transaction.insert(schema.participants).values(
          participants.map((participant, position) => ({
            channelId,
            id: participant.id,
            handle: participant.handle,
            type: participant.type,
            displayName: participant.displayName,
            role: participant.role,
            profile: participant.profile,
            status: participant.status ?? "active",
            position,
          })),
        );
      }

      const nextIds = new Set(participants.map(({ id }) => id));
      const removedParticipantIds = previous
        .filter(({ id }) => !nextIds.has(id))
        .map(({ id }) => id);
      if (removedParticipantIds.length > 0) {
        const latest = await transaction.select({
          sequence: sql<number>`coalesce(max(${schema.messages.sequence}), 0)`,
        }).from(schema.messages).where(eq(schema.messages.channelId, channelId));
        const headSequence = latest[0]?.sequence ?? 0;
        for (const participantId of removedParticipantIds) {
          await transaction.insert(schema.agentCursors).values({
            channelId,
            participantId,
            lastProcessedSequence: headSequence,
            updatedAt,
          }).onConflictDoUpdate({
            target: [schema.agentCursors.channelId, schema.agentCursors.participantId],
            set: {
              lastProcessedSequence: sql`max(${schema.agentCursors.lastProcessedSequence}, ${headSequence})`,
              updatedAt,
            },
          });
        }
      }
      if (!channel) throw new Error(`Channel disappeared during roster update: ${channelId}`);
      return {
        channel: {
          id: channel.id,
          workspaceId: channel.workspaceId ?? "legacy-default-workspace",
          name: channel.name,
          createdAt: channel.createdAt,
          rosterRevision: revisions[0].rosterRevision,
          participants: participants.map((participant) => ({ ...participant })),
        },
        removedParticipantIds,
      };
    }, { behavior: "immediate" });
  }

  async getChannel(channelId: string): Promise<Channel | undefined> {
    const channel = await this.database.query.channels.findFirst({
      where: eq(schema.channels.id, channelId),
    });
    if (!channel) return undefined;
    const [participants, messages] = await Promise.all([
      this.database
        .select()
        .from(schema.participants)
        .where(eq(schema.participants.channelId, channelId))
        .orderBy(asc(schema.participants.position)),
      this.database
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.channelId, channelId))
        .orderBy(asc(schema.messages.sequence)),
    ]);
    return {
      id: channel.id,
      workspaceId: channel.workspaceId ?? "legacy-default-workspace",
      name: channel.name,
      createdAt: channel.createdAt,
      rosterRevision: channel.rosterRevision,
      participants: participants.map((participant) => ({
        id: participant.id,
        handle: participant.handle ?? participant.id,
        type: participant.type,
        displayName: participant.displayName ?? undefined,
        role: participant.role ?? undefined,
        profile: participant.profile ?? undefined,
        status: participant.status,
      })),
      messages: messages.map((message) => ({
        id: message.id,
        channelId: message.channelId,
        sequence: message.sequence,
        participantId: message.participantId,
        to: [...message.targets],
        body: message.body,
        replyTo: message.replyTo ?? undefined,
        createdAt: message.createdAt,
      })),
    };
  }

  async appendMessage(message: NewChannelMessage): Promise<ChannelMessage> {
    return await this.database.transaction(async (transaction) => {
      const [allocated] = await transaction
        .update(schema.channels)
        .set({ nextSequence: sql`${schema.channels.nextSequence} + 1` })
        .where(eq(schema.channels.id, message.channelId))
        .returning({ sequence: sql<number>`${schema.channels.nextSequence} - 1` });
      if (!allocated) throw new Error(`Channel not found: ${message.channelId}`);
      await transaction.insert(schema.messages).values({
        id: message.id,
        channelId: message.channelId,
        sequence: allocated.sequence,
        participantId: message.participantId,
        targets: message.to,
        body: message.body,
        replyTo: message.replyTo,
        createdAt: message.createdAt,
      });
      return { ...message, sequence: allocated.sequence, to: [...message.to] };
    });
  }

  async commitMessage(
    message: NewChannelMessage,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<MessageCommitResult> {
    const requestKey = JSON.stringify([
      this.storageKey,
      message.channelId,
      message.participantId,
      idempotencyKey,
    ]);
    const pending = pendingMessageCommits.get(requestKey);
    if (pending) {
      const result = await pending.commit;
      if (result.outcome === "conflict" && pending.requestFingerprint !== requestFingerprint) {
        return await this.commitMessageWithRetry(message, idempotencyKey, requestFingerprint);
      }
      return {
        message: { ...result.message, to: [...result.message.to] },
        outcome: result.outcome === "conflict"
          ? "conflict"
          : pending.requestFingerprint === requestFingerprint
            ? "replayed"
            : "conflict",
      };
    }
    const commit = this.commitMessageWithRetry(message, idempotencyKey, requestFingerprint);
    pendingMessageCommits.set(requestKey, { requestFingerprint, commit });
    try {
      return await commit;
    } finally {
      pendingMessageCommits.delete(requestKey);
    }
  }

  private async commitMessageWithRetry(
    message: NewChannelMessage,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<MessageCommitResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await this.commitMessageOnce(message, idempotencyKey, requestFingerprint);
      } catch (error) {
        lastError = error;
        const code = (error as { code?: string }).code;
        if (code !== "SQLITE_BUSY" && code !== "SQLITE_CONSTRAINT") throw error;
        await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt + Math.random() * 5));
      }
    }
    throw lastError;
  }

  private async commitMessageOnce(
    message: NewChannelMessage,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<MessageCommitResult> {
    // A write transaction acquires the lock before the first read. Drizzle's libSQL
    // transaction wrapper currently always starts deferred transactions, which can
    // deadlock when two processes both read and then attempt this commit.
    const transaction = await this.client.transaction("write");
    try {
      const existingResult = await transaction.execute({
        sql: `
          SELECT i.request_fingerprint, m.id, m.channel_id, m.sequence,
                 m.participant_id, m.targets_json, m.body, m.reply_to, m.created_at
          FROM message_idempotency i
          JOIN messages m ON m.id = i.message_id
          WHERE i.channel_id = ? AND i.participant_id = ? AND i.idempotency_key = ?
          LIMIT 1
        `,
        args: [message.channelId, message.participantId, idempotencyKey],
      });
      const existing = existingResult.rows[0] as Record<string, unknown> | undefined;
      if (existing) {
        await transaction.commit();
        return {
          outcome: existing.request_fingerprint === requestFingerprint ? "replayed" : "conflict",
          message: {
            id: String(existing.id),
            channelId: String(existing.channel_id),
            sequence: Number(existing.sequence),
            participantId: String(existing.participant_id),
            to: JSON.parse(String(existing.targets_json)) as string[],
            body: String(existing.body),
            replyTo: existing.reply_to === null ? undefined : String(existing.reply_to),
            createdAt: String(existing.created_at),
          },
        };
      }

      const allocatedResult = await transaction.execute({
        sql: `
          UPDATE channels SET next_sequence = next_sequence + 1
          WHERE id = ? RETURNING next_sequence - 1 AS sequence
        `,
        args: [message.channelId],
      });
      const allocated = allocatedResult.rows[0] as Record<string, unknown> | undefined;
      if (!allocated) throw new Error(`Channel not found: ${message.channelId}`);
      const sequence = Number(allocated.sequence);
      await transaction.execute({
        sql: `
          INSERT INTO messages
            (id, channel_id, sequence, participant_id, targets_json, body, reply_to, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          message.id,
          message.channelId,
          sequence,
          message.participantId,
          JSON.stringify(message.to),
          message.body,
          message.replyTo ?? null,
          message.createdAt,
        ],
      });
      await transaction.execute({
        sql: `
          INSERT INTO message_idempotency
            (channel_id, participant_id, idempotency_key, request_fingerprint, message_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        args: [
          message.channelId,
          message.participantId,
          idempotencyKey,
          requestFingerprint,
          message.id,
          message.createdAt,
        ],
      });
      await transaction.commit();
      return {
        outcome: "created",
        message: { ...message, sequence, to: [...message.to] },
      };
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }

  async commitResponse(
    message: NewResponseMessage,
    triggerSequence: number,
  ): Promise<ResponseResult> {
    const deliveryKey = `${this.storageKey}:${message.channelId}:${message.participantId}:${message.replyTo}`;
    const pending = pendingResponseCommits.get(deliveryKey);
    if (pending) {
      const result = await pending;
      return { message: { ...result.message, to: [...result.message.to] }, created: false };
    }
    const commit = this.commitResponseWithRetry(message, triggerSequence);
    pendingResponseCommits.set(deliveryKey, commit);
    try {
      return await commit;
    } finally {
      pendingResponseCommits.delete(deliveryKey);
    }
  }

  private async commitResponseWithRetry(
    message: NewResponseMessage,
    triggerSequence: number,
  ): Promise<ResponseResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.commitResponseOnce(message, triggerSequence);
      } catch (error) {
        lastError = error;
        const code = (error as { code?: string }).code;
        if (code !== "SQLITE_BUSY" && code !== "SQLITE_CONSTRAINT") throw error;
        await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  private async commitResponseOnce(
    message: NewResponseMessage,
    triggerSequence: number,
  ): Promise<ResponseResult> {
    return await this.database.transaction(async (transaction) => {
      const [lockedChannel] = await transaction
        .update(schema.channels)
        .set({ nextSequence: sql`${schema.channels.nextSequence}` })
        .where(eq(schema.channels.id, message.channelId))
        .returning({ id: schema.channels.id });
      if (!lockedChannel) throw new Error(`Channel not found: ${message.channelId}`);
      const [existingDelivery] = await transaction
        .select({ responseMessageId: schema.responseDeliveries.responseMessageId })
        .from(schema.responseDeliveries)
        .where(
          and(
            eq(schema.responseDeliveries.channelId, message.channelId),
            eq(schema.responseDeliveries.participantId, message.participantId),
            eq(schema.responseDeliveries.triggerMessageId, message.replyTo),
          ),
        )
        .limit(1);
      if (existingDelivery) {
        const [existing] = await transaction
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.id, existingDelivery.responseMessageId))
          .limit(1);
        if (!existing) throw new Error("Response delivery references a missing response message");
        return {
          created: false,
          message: {
            id: existing.id,
            channelId: existing.channelId,
            sequence: existing.sequence,
            participantId: existing.participantId,
            to: [...existing.targets],
            body: existing.body,
            replyTo: existing.replyTo ?? undefined,
            createdAt: existing.createdAt,
          },
        };
      }

      const [allocated] = await transaction
        .update(schema.channels)
        .set({ nextSequence: sql`${schema.channels.nextSequence} + 1` })
        .where(eq(schema.channels.id, message.channelId))
        .returning({ sequence: sql<number>`${schema.channels.nextSequence} - 1` });
      if (!allocated) throw new Error(`Channel not found: ${message.channelId}`);
      await transaction.insert(schema.messages).values({
        id: message.id,
        channelId: message.channelId,
        sequence: allocated.sequence,
        participantId: message.participantId,
        targets: message.to,
        body: message.body,
        replyTo: message.replyTo,
        createdAt: message.createdAt,
      });
      const updatedAt = new Date().toISOString();
      await transaction
        .insert(schema.agentCursors)
        .values({
          channelId: message.channelId,
          participantId: message.participantId,
          lastProcessedSequence: triggerSequence,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [schema.agentCursors.channelId, schema.agentCursors.participantId],
          set: {
            lastProcessedSequence: sql`max(${schema.agentCursors.lastProcessedSequence}, ${triggerSequence})`,
            updatedAt,
          },
        });
      await transaction.insert(schema.responseDeliveries).values({
        channelId: message.channelId,
        participantId: message.participantId,
        triggerMessageId: message.replyTo,
        triggerSequence,
        responseMessageId: message.id,
        createdAt: updatedAt,
      });
      return {
        created: true,
        message: { ...message, sequence: allocated.sequence, to: [...message.to] },
      };
    });
  }

  async getCursor(channelId: string, participantId: string): Promise<number> {
    const [cursor] = await this.database
      .select({ lastProcessedSequence: schema.agentCursors.lastProcessedSequence })
      .from(schema.agentCursors)
      .where(
        and(
          eq(schema.agentCursors.channelId, channelId),
          eq(schema.agentCursors.participantId, participantId),
        ),
      )
      .limit(1);
    return cursor?.lastProcessedSequence ?? 0;
  }

  async setCursor(channelId: string, participantId: string, sequence: number): Promise<void> {
    await this.database
      .insert(schema.agentCursors)
      .values({
        channelId,
        participantId,
        lastProcessedSequence: sequence,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [schema.agentCursors.channelId, schema.agentCursors.participantId],
        set: {
          lastProcessedSequence: sequence,
          updatedAt: new Date().toISOString(),
        },
      });
  }

  async close(): Promise<void> {
    this.client.close();
  }
}
