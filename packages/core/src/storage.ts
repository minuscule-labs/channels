import type {
  Channel,
  ChannelCursorStore,
  ChannelMessage,
  ChannelMetadata,
  ResponseResult,
} from "./types.js";

export type NewChannelMessage = Omit<ChannelMessage, "sequence">;
export type NewResponseMessage = NewChannelMessage & { replyTo: string };

export interface MessageCommitResult {
  message: ChannelMessage;
  outcome: "created" | "replayed" | "conflict";
}

export interface ChannelStorage extends ChannelCursorStore {
  createChannel(channel: Channel): Promise<Channel>;
  getChannel(channelId: string): Promise<Channel | undefined>;
  getChannelMetadata(channelId: string): Promise<ChannelMetadata | undefined>;
  appendMessage(message: NewChannelMessage): Promise<ChannelMessage>;
  commitMessage(
    message: NewChannelMessage,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<MessageCommitResult>;
  commitResponse(
    message: NewResponseMessage,
    triggerSequence: number,
  ): Promise<ResponseResult>;
  close?(): Promise<void> | void;
}

function copyChannel(channel: Channel): Channel {
  return {
    ...channel,
    participants: channel.participants.map((participant) => ({ ...participant })),
    messages: channel.messages.map((message) => ({ ...message, to: [...message.to] })),
  };
}

export class InMemoryChannelStorage implements ChannelStorage, ChannelCursorStore {
  private readonly channels = new Map<string, Channel>();
  private readonly cursors = new Map<string, number>();
  private readonly responses = new Map<string, ChannelMessage>();
  private readonly messageRequests = new Map<
    string,
    { requestFingerprint: string; message: ChannelMessage }
  >();
  private readonly pendingMessages = new Map<string, Promise<MessageCommitResult>>();
  private readonly pendingResponses = new Map<string, Promise<ResponseResult>>();

  async createChannel(channel: Channel): Promise<Channel> {
    this.channels.set(channel.id, copyChannel(channel));
    return copyChannel(channel);
  }

  async getChannel(channelId: string): Promise<Channel | undefined> {
    const channel = this.channels.get(channelId);
    return channel ? copyChannel(channel) : undefined;
  }

  async getChannelMetadata(channelId: string): Promise<ChannelMetadata | undefined> {
    const channel = this.channels.get(channelId);
    if (!channel) return undefined;
    return {
      id: channel.id,
      createdAt: channel.createdAt,
      participants: channel.participants.map((participant) => ({ ...participant })),
    };
  }

  async appendMessage(message: NewChannelMessage): Promise<ChannelMessage> {
    const channel = this.channels.get(message.channelId);
    if (!channel) throw new Error(`Channel not found: ${message.channelId}`);
    const stored = { ...message, sequence: channel.messages.length + 1, to: [...message.to] };
    channel.messages.push(stored);
    return { ...stored, to: [...stored.to] };
  }

  async commitMessage(
    message: NewChannelMessage,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<MessageCommitResult> {
    const requestKey = JSON.stringify([message.channelId, message.participantId, idempotencyKey]);
    const pending = this.pendingMessages.get(requestKey);
    if (pending) {
      await pending;
      return this.resolveMessageRequest(requestKey, requestFingerprint);
    }
    const commit = this.commitMessageOnce(requestKey, message, requestFingerprint);
    this.pendingMessages.set(requestKey, commit);
    try {
      return await commit;
    } finally {
      this.pendingMessages.delete(requestKey);
    }
  }

  private resolveMessageRequest(
    requestKey: string,
    requestFingerprint: string,
  ): MessageCommitResult {
    const existing = this.messageRequests.get(requestKey);
    if (!existing) throw new Error("Idempotency record is missing its message");
    return {
      message: { ...existing.message, to: [...existing.message.to] },
      outcome: existing.requestFingerprint === requestFingerprint ? "replayed" : "conflict",
    };
  }

  private async commitMessageOnce(
    requestKey: string,
    message: NewChannelMessage,
    requestFingerprint: string,
  ): Promise<MessageCommitResult> {
    if (this.messageRequests.has(requestKey)) {
      return this.resolveMessageRequest(requestKey, requestFingerprint);
    }
    const stored = await this.appendMessage(message);
    this.messageRequests.set(requestKey, { requestFingerprint, message: stored });
    return { message: stored, outcome: "created" };
  }

  async commitResponse(
    message: NewResponseMessage,
    triggerSequence: number,
  ): Promise<ResponseResult> {
    const deliveryKey = `${message.channelId}:${message.participantId}:${message.replyTo}`;
    const pending = this.pendingResponses.get(deliveryKey);
    if (pending) {
      const result = await pending;
      return { message: { ...result.message, to: [...result.message.to] }, created: false };
    }
    const commit = this.commitResponseOnce(deliveryKey, message, triggerSequence);
    this.pendingResponses.set(deliveryKey, commit);
    try {
      return await commit;
    } finally {
      this.pendingResponses.delete(deliveryKey);
    }
  }

  private async commitResponseOnce(
    deliveryKey: string,
    message: NewResponseMessage,
    triggerSequence: number,
  ): Promise<ResponseResult> {
    const existing = this.responses.get(deliveryKey);
    if (existing) return { message: { ...existing, to: [...existing.to] }, created: false };
    const stored = await this.appendMessage(message);
    this.responses.set(deliveryKey, stored);
    const cursorKey = `${message.channelId}:${message.participantId}`;
    this.cursors.set(cursorKey, Math.max(this.cursors.get(cursorKey) ?? 0, triggerSequence));
    return { message: stored, created: true };
  }

  async getCursor(channelId: string, participantId: string): Promise<number> {
    return this.cursors.get(`${channelId}:${participantId}`) ?? 0;
  }

  async setCursor(channelId: string, participantId: string, sequence: number): Promise<void> {
    this.cursors.set(`${channelId}:${participantId}`, sequence);
  }
}
