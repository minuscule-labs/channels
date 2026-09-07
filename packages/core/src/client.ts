import type {
  Channel,
  ChannelEvent,
  ChannelMessage,
  ChannelMetadata,
  CreateChannelInput,
  CreateIdentityInput,
  CreateMessageInput,
  CreateResponseInput,
  CreateWorkspaceInput,
  AddWorkspaceMemberInput,
  Identity,
  ResponseResult,
  Workspace,
  WorkspaceMember,
  UpdateChannelInput,
  UpdateChannelParticipantsInput,
  UpdateIdentityInput,
  UpdateWorkspaceInput,
  UpdateWorkspaceMemberInput,
} from "./types.ts";
import type { MessageListOptions } from "./storage.ts";

export interface ChannelEventOptions {
  signal?: AbortSignal;
  onReady?(): void;
}

export interface PostMessageOptions {
  idempotencyKey?: string;
}

export interface ChannelClientOptions {
  serviceToken?: string;
  actorIdentityId?: string;
}

export class ChannelClient {
  constructor(readonly endpoint: string, private readonly options: ChannelClientOptions = {}) {}

  async createIdentity(input: CreateIdentityInput): Promise<Identity> {
    const response = await this.request("/identities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { identity: Identity }).identity;
  }

  async updateIdentity(identityId: string, input: UpdateIdentityInput): Promise<Identity> {
    const response = await this.request(`/identities/${identityId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { identity: Identity }).identity;
  }

  async getIdentity(identityId: string): Promise<Identity> {
    const response = await this.request(`/identities/${identityId}`);
    return ((await response.json()) as { identity: Identity }).identity;
  }

  async listIdentities(): Promise<Identity[]> {
    const response = await this.request("/identities");
    return ((await response.json()) as { identities: Identity[] }).identities;
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    const response = await this.request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { workspace: Workspace }).workspace;
  }

  async updateWorkspace(workspaceId: string, input: UpdateWorkspaceInput): Promise<Workspace> {
    const response = await this.request(`/workspaces/${workspaceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { workspace: Workspace }).workspace;
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    const response = await this.request(`/workspaces/${workspaceId}`);
    return ((await response.json()) as { workspace: Workspace }).workspace;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const response = await this.request("/workspaces");
    return ((await response.json()) as { workspaces: Workspace[] }).workspaces;
  }

  async addWorkspaceMember(
    workspaceId: string,
    input: AddWorkspaceMemberInput,
  ): Promise<WorkspaceMember> {
    const response = await this.request(`/workspaces/${workspaceId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { member: WorkspaceMember }).member;
  }

  async updateWorkspaceMember(
    workspaceId: string,
    identityId: string,
    input: UpdateWorkspaceMemberInput,
  ): Promise<WorkspaceMember> {
    const response = await this.request(`/workspaces/${workspaceId}/members/${identityId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { member: WorkspaceMember }).member;
  }

  async listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const response = await this.request(`/workspaces/${workspaceId}/members`);
    return ((await response.json()) as { members: WorkspaceMember[] }).members;
  }

  async listWorkspaceChannels(workspaceId: string): Promise<ChannelMetadata[]> {
    const response = await this.request(`/workspaces/${workspaceId}/channels`);
    return ((await response.json()) as { channels: ChannelMetadata[] }).channels;
  }

  async createChannel(input: CreateChannelInput): Promise<Channel> {
    const response = await this.request("/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { channel: Channel }).channel;
  }

  async updateChannel(channelId: string, input: UpdateChannelInput): Promise<ChannelMetadata> {
    const response = await this.request(`/channels/${channelId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { channel: ChannelMetadata }).channel;
  }

  async updateChannelParticipants(
    channelId: string,
    input: UpdateChannelParticipantsInput,
  ): Promise<ChannelMetadata> {
    const response = await this.request(`/channels/${channelId}/participants`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { channel: ChannelMetadata }).channel;
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

  async listMessages(channelId: string, options: MessageListOptions = {}): Promise<ChannelMessage[]> {
    const query = new URLSearchParams();
    if (options.afterSequence !== undefined) query.set("afterSequence", String(options.afterSequence));
    if (options.beforeSequence !== undefined) query.set("beforeSequence", String(options.beforeSequence));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size > 0 ? `?${query}` : "";
    const response = await this.request(`/channels/${channelId}/messages${suffix}`);
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
        if ((eventName === "message.created" || eventName === "roster.updated") && data) {
          yield JSON.parse(data) as ChannelEvent;
        }
      }
    }
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${this.endpoint}${path}`, {
      ...init,
      headers: {
        ...(this.options.serviceToken ? { authorization: `Bearer ${this.options.serviceToken}` } : {}),
        ...(this.options.actorIdentityId ? { "x-minu-actor-id": this.options.actorIdentityId } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Channel request failed (${response.status})`);
    }
    return response;
  }
}
