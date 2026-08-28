import type {
  Channel,
  ChannelCursorStore,
  ChannelMessage,
  ChannelMetadata,
  RelayResponseResult,
} from "./types.js";

export type NewChannelMessage = Omit<ChannelMessage, "sequence">;
export type NewRelayResponseMessage = NewChannelMessage & { replyTo: string };

export interface ChannelStorage extends ChannelCursorStore {
  createChannel(channel: Channel): Promise<Channel>;
  getChannel(channelId: string): Promise<Channel | undefined>;
  getChannelMetadata(channelId: string): Promise<ChannelMetadata | undefined>;
  appendMessage(message: NewChannelMessage): Promise<ChannelMessage>;
  commitRelayResponse(
    message: NewRelayResponseMessage,
    triggerSequence: number,
  ): Promise<RelayResponseResult>;
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
  private readonly relayResponses = new Map<string, ChannelMessage>();

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

  async commitRelayResponse(
    message: NewRelayResponseMessage,
    triggerSequence: number,
  ): Promise<RelayResponseResult> {
    const deliveryKey = `${message.channelId}:${message.participantId}:${message.replyTo}`;
    const existing = this.relayResponses.get(deliveryKey);
    if (existing) return { message: { ...existing, to: [...existing.to] }, created: false };
    const stored = await this.appendMessage(message);
    this.relayResponses.set(deliveryKey, stored);
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
