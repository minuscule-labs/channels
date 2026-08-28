import { createHash, randomUUID } from "node:crypto";
import { InMemoryChannelStorage, type ChannelStorage, type NewChannelMessage } from "./storage.js";
import type {
  Channel,
  ChannelEvent,
  ChannelMessage,
  ChannelMetadata,
  CreateChannelInput,
  CreateMessageInput,
  CreateResponseInput,
  Participant,
  ResponseResult,
} from "./types.js";

export class ChannelNotFoundError extends Error {}
export class ChannelValidationError extends Error {}
export class ChannelConflictError extends Error {}

type EventListener = (event: ChannelEvent) => void;

function validateParticipant(participant: Participant): Participant {
  if (!participant || typeof participant !== "object") {
    throw new ChannelValidationError("participants must contain objects");
  }
  if (typeof participant.id !== "string" || !participant.id.trim() || participant.id.length > 200) {
    throw new ChannelValidationError("participant id must be a non-empty string up to 200 characters");
  }
  if (!["human", "agent", "service"].includes(participant.type)) {
    throw new ChannelValidationError("participant type must be human, agent, or service");
  }
  if (participant.displayName !== undefined && typeof participant.displayName !== "string") {
    throw new ChannelValidationError("participant displayName must be a string");
  }
  if (participant.role !== undefined && typeof participant.role !== "string") {
    throw new ChannelValidationError("participant role must be a string");
  }
  if (participant.profile !== undefined && typeof participant.profile !== "string") {
    throw new ChannelValidationError("participant profile must be a string");
  }
  const displayName = participant.displayName?.trim() || undefined;
  const role = participant.role?.trim() || undefined;
  const profile = participant.profile?.trim() || undefined;
  if (displayName && displayName.length > 200) {
    throw new ChannelValidationError("participant displayName must be at most 200 characters");
  }
  if (role && role.length > 100) {
    throw new ChannelValidationError("participant role must be at most 100 characters");
  }
  if (profile && profile.length > 1_000) {
    throw new ChannelValidationError("participant profile must be at most 1000 characters");
  }
  return {
    id: participant.id.trim(),
    type: participant.type,
    displayName,
    role,
    profile,
  };
}

function validateIdempotencyKey(idempotencyKey: string | undefined): string | undefined {
  if (idempotencyKey === undefined) return undefined;
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw new ChannelValidationError("idempotency key must be a non-empty string");
  }
  if (Buffer.byteLength(idempotencyKey, "utf8") > 255) {
    throw new ChannelValidationError("idempotency key exceeds 255 UTF-8 bytes");
  }
  return idempotencyKey;
}

function requestFingerprint(input: {
  participantId: string;
  body: string;
  to: string[];
  replyTo?: string;
}): string {
  const canonicalPayload = JSON.stringify({
    participantId: input.participantId,
    body: input.body,
    to: [...input.to].sort(),
    replyTo: input.replyTo ?? null,
  });
  return createHash("sha256").update(canonicalPayload).digest("hex");
}

function messageTargets(channel: Channel, input: CreateMessageInput): string[] {
  if (input.to !== undefined && !Array.isArray(input.to)) {
    throw new ChannelValidationError("to must be an array of participant ids");
  }
  const mentioned = [...input.body.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)\b/g)].map((match) =>
    match[1] === "channel" ? "@channel" : match[1]!,
  );
  const targets = [...new Set([...(input.to ?? []), ...mentioned])];
  for (const target of targets) {
    if (typeof target !== "string" || !target.trim()) {
      throw new ChannelValidationError("to must contain non-empty participant ids");
    }
    if (target !== "@channel" && !channel.participants.some((participant) => participant.id === target)) {
      throw new ChannelValidationError(`Target participant is not in channel: ${target}`);
    }
  }
  return targets;
}

export class ChannelService {
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(readonly storage: ChannelStorage = new InMemoryChannelStorage()) {}

  async createChannel(input: CreateChannelInput): Promise<Channel> {
    if (!input || !Array.isArray(input.participants)) {
      throw new ChannelValidationError("participants must be an array");
    }
    const participants = input.participants.map(validateParticipant);
    if (new Set(participants.map((participant) => participant.id)).size !== participants.length) {
      throw new ChannelValidationError("participant ids must be unique within a channel");
    }
    return await this.storage.createChannel({
      id: randomUUID(),
      participants,
      messages: [],
      createdAt: new Date().toISOString(),
    });
  }

  async getChannel(channelId: string): Promise<Channel> {
    const channel = await this.storage.getChannel(channelId);
    if (!channel) throw new ChannelNotFoundError(`Channel not found: ${channelId}`);
    return channel;
  }

  async getChannelMetadata(channelId: string): Promise<ChannelMetadata> {
    const channel = await this.storage.getChannelMetadata(channelId);
    if (!channel) throw new ChannelNotFoundError(`Channel not found: ${channelId}`);
    return channel;
  }

  async listMessages(channelId: string): Promise<ChannelMessage[]> {
    return (await this.getChannel(channelId)).messages;
  }

  async createMessage(
    channelId: string,
    input: CreateMessageInput,
    idempotencyKey?: string,
  ): Promise<ChannelMessage> {
    const validatedKey = validateIdempotencyKey(idempotencyKey);
    const channel = await this.storage.getChannel(channelId);
    if (!channel) throw new ChannelNotFoundError(`Channel not found: ${channelId}`);
    if (!input || typeof input.participantId !== "string" || !input.participantId.trim()) {
      throw new ChannelValidationError("participantId must be a non-empty string");
    }
    const participantId = input.participantId.trim();
    if (!channel.participants.some((participant) => participant.id === participantId)) {
      throw new ChannelValidationError(`Participant is not in channel: ${participantId}`);
    }
    if (typeof input.body !== "string" || !input.body.trim()) {
      throw new ChannelValidationError("body must be a non-empty string");
    }
    if (Buffer.byteLength(input.body, "utf8") > 64 * 1024) {
      throw new ChannelValidationError("body exceeds 64 KiB");
    }
    if (input.replyTo !== undefined && !channel.messages.some((message) => message.id === input.replyTo)) {
      throw new ChannelValidationError(`Reply message is not in channel: ${input.replyTo}`);
    }

    const to = messageTargets(channel, input);
    const pendingMessage: NewChannelMessage = {
      id: randomUUID(),
      channelId,
      participantId,
      to,
      body: input.body,
      replyTo: input.replyTo,
      createdAt: new Date().toISOString(),
    };
    const result = validatedKey === undefined
      ? { message: await this.storage.appendMessage(pendingMessage), outcome: "created" as const }
      : await this.storage.commitMessage(
          pendingMessage,
          validatedKey,
          requestFingerprint({ participantId, body: input.body, to, replyTo: input.replyTo }),
        );
    if (result.outcome === "conflict") {
      throw new ChannelConflictError("idempotency key was already used with a different payload");
    }
    const message = result.message;
    if (result.outcome === "created") {
      const event: ChannelEvent = {
        id: randomUUID(),
        type: "message.created",
        channelId,
        message: { ...message, to: [...message.to] },
        createdAt: new Date().toISOString(),
      };
      for (const listener of this.listeners.get(channelId) ?? []) listener(event);
    }
    return { ...message, to: [...message.to] };
  }

  async createResponse(
    channelId: string,
    input: CreateResponseInput,
  ): Promise<ResponseResult> {
    const channel = await this.storage.getChannel(channelId);
    if (!channel) throw new ChannelNotFoundError(`Channel not found: ${channelId}`);
    if (!input || typeof input.participantId !== "string" || !input.participantId.trim()) {
      throw new ChannelValidationError("participantId must be a non-empty string");
    }
    const participant = channel.participants.find((candidate) => candidate.id === input.participantId);
    if (!participant) {
      throw new ChannelValidationError(`Participant is not in channel: ${input.participantId}`);
    }
    if (participant.type !== "agent" && participant.type !== "service") {
      throw new ChannelValidationError("responses must be authored by an agent or service");
    }
    if (typeof input.body !== "string" || !input.body.trim()) {
      throw new ChannelValidationError("body must be a non-empty string");
    }
    if (Buffer.byteLength(input.body, "utf8") > 64 * 1024) {
      throw new ChannelValidationError("body exceeds 64 KiB");
    }
    if (typeof input.triggerMessageId !== "string" || !input.triggerMessageId.trim()) {
      throw new ChannelValidationError("triggerMessageId must be a non-empty string");
    }
    if (!Number.isInteger(input.triggerSequence) || input.triggerSequence < 1) {
      throw new ChannelValidationError("triggerSequence must be a positive integer");
    }
    const trigger = channel.messages.find((message) => message.id === input.triggerMessageId);
    if (!trigger || trigger.sequence !== input.triggerSequence) {
      throw new ChannelValidationError("trigger message and sequence do not match this channel");
    }

    const result = await this.storage.commitResponse(
      {
        id: randomUUID(),
        channelId,
        participantId: input.participantId,
        to: messageTargets(channel, { participantId: input.participantId, body: input.body }),
        body: input.body,
        replyTo: trigger.id,
        createdAt: new Date().toISOString(),
      },
      trigger.sequence,
    );
    if (result.created) {
      const event: ChannelEvent = {
        id: randomUUID(),
        type: "message.created",
        channelId,
        message: { ...result.message, to: [...result.message.to] },
        createdAt: new Date().toISOString(),
      };
      for (const listener of this.listeners.get(channelId) ?? []) listener(event);
    }
    return { message: { ...result.message, to: [...result.message.to] }, created: result.created };
  }

  async subscribe(channelId: string, listener: EventListener): Promise<() => void> {
    if (!(await this.storage.getChannel(channelId))) {
      throw new ChannelNotFoundError(`Channel not found: ${channelId}`);
    }
    const channelListeners = this.listeners.get(channelId) ?? new Set<EventListener>();
    channelListeners.add(listener);
    this.listeners.set(channelId, channelListeners);
    return () => {
      channelListeners.delete(listener);
      if (channelListeners.size === 0) this.listeners.delete(channelId);
    };
  }

  async close(): Promise<void> {
    await this.storage.close?.();
  }
}
