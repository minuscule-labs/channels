import { createClient, type Client } from "@libsql/client";
import type {
  Channel,
  ChannelCursorStore,
  ChannelMessage,
  ChannelMetadata,
  ChannelStorage,
  NewChannelMessage,
  NewRelayResponseMessage,
  RelayResponseResult,
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

export class DrizzleLibSqlChannelStorage implements ChannelStorage, ChannelCursorStore {
  private constructor(
    private readonly client: Client,
    private readonly database: LibSQLDatabase<typeof schema>,
  ) {}

  static async open(options: DrizzleLibSqlStorageOptions): Promise<DrizzleLibSqlChannelStorage> {
    const client = createClient({ url: options.url, authToken: options.authToken });
    const database = drizzle(client, { schema });
    await migrate(database, {
      migrationsFolder: options.migrationsFolder ?? defaultMigrationsFolder(),
    });
    return new DrizzleLibSqlChannelStorage(client, database);
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

  async commitRelayResponse(
    message: NewRelayResponseMessage,
    triggerSequence: number,
  ): Promise<RelayResponseResult> {
    return await this.database.transaction(async (transaction) => {
      const [existingDelivery] = await transaction
        .select({ responseMessageId: schema.relayDeliveries.responseMessageId })
        .from(schema.relayDeliveries)
        .where(
          and(
            eq(schema.relayDeliveries.channelId, message.channelId),
            eq(schema.relayDeliveries.participantId, message.participantId),
            eq(schema.relayDeliveries.triggerMessageId, message.replyTo),
          ),
        )
        .limit(1);
      if (existingDelivery) {
        const [existing] = await transaction
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.id, existingDelivery.responseMessageId))
          .limit(1);
        if (!existing) throw new Error("Relay delivery references a missing response message");
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
      await transaction.insert(schema.relayDeliveries).values({
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
