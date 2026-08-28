import { createClient, type Client } from "@libsql/client";
import type {
  Channel,
  ChannelCursorStore,
  ChannelMessage,
  ChannelMetadata,
  ChannelStorage,
  MessageCommitResult,
  NewChannelMessage,
  NewResponseMessage,
  ResponseResult,
} from "@minu/channels-core";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

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

  async createChannel(channel: Channel): Promise<Channel> {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(schema.channels).values({
        id: channel.id,
        createdAt: channel.createdAt,
        nextSequence: 1,
      });
      if (channel.participants.length > 0) {
        await transaction.insert(schema.participants).values(
          channel.participants.map((participant, position) => ({
            channelId: channel.id,
            id: participant.id,
            type: participant.type,
            displayName: participant.displayName,
            role: participant.role,
            profile: participant.profile,
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
      createdAt: channel.createdAt,
      participants: participants.map((participant) => ({
        id: participant.id,
        type: participant.type,
        displayName: participant.displayName ?? undefined,
        role: participant.role ?? undefined,
        profile: participant.profile ?? undefined,
      })),
    };
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
      createdAt: channel.createdAt,
      participants: participants.map((participant) => ({
        id: participant.id,
        type: participant.type,
        displayName: participant.displayName ?? undefined,
        role: participant.role ?? undefined,
        profile: participant.profile ?? undefined,
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
