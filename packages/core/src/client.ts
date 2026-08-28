import type {
  Channel,
  ChannelEvent,
  ChannelMessage,
  ChannelMetadata,
  CreateChannelInput,
  CreateMessageInput,
  CreateResponseInput,
  ResponseResult,
} from "./types.js";

export interface ChannelEventOptions {
  signal?: AbortSignal;
  onReady?(): void;
}

export interface PostMessageOptions {
  idempotencyKey?: string;
}

export class ChannelClient {
  constructor(readonly endpoint: string) {}

  async createChannel(input: CreateChannelInput): Promise<Channel> {
    const response = await this.request("/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { channel: Channel }).channel;
  }

  async getChannel(channelId: string): Promise<ChannelMetadata> {
    const response = await this.request(`/channels/${channelId}`);
    return ((await response.json()) as { channel: ChannelMetadata }).channel;
  }

  async postMessage(
    channelId: string,
    input: CreateMessageInput,
    options: PostMessageOptions = {},
  ): Promise<ChannelMessage> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey;
    }
    const response = await this.request(`/channels/${channelId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { message: ChannelMessage }).message;
  }

  async postResponse(
    channelId: string,
    input: CreateResponseInput,
  ): Promise<ResponseResult> {
    const response = await this.request(`/channels/${channelId}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return (await response.json()) as ResponseResult;
  }

  async listMessages(channelId: string): Promise<ChannelMessage[]> {
    const response = await this.request(`/channels/${channelId}/messages`);
    return ((await response.json()) as { messages: ChannelMessage[] }).messages;
  }

  async *events(channelId: string, options: ChannelEventOptions = {}): AsyncIterable<ChannelEvent> {
    const response = await this.request(`/channels/${channelId}/events`, { signal: options.signal });
    if (!response.body) throw new Error("Channel event response has no body");
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const eventName = frame
          .split("\n")
          .find((line) => line.startsWith("event: "))
          ?.slice(7);
        if (eventName === "ready") {
          options.onReady?.();
          continue;
        }
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (eventName === "message.created" && data) yield JSON.parse(data) as ChannelEvent;
      }
    }
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${this.endpoint}${path}`, init);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Channel request failed (${response.status})`);
    }
    return response;
  }
}
