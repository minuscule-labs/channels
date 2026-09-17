import type {
  Conversation,
  ConversationEvent,
  ConversationMessage,
  ConversationMetadata,
  CreateConversationInput,
  CreateIdentityInput,
  CreateMessageInput,
  CreateResponseInput,
  CreateWorkspaceInput,
  AddWorkspaceMemberInput,
  Identity,
  ResponseResult,
  Workspace,
  WorkspaceMember,
  UpdateConversationInput,
  UpdateConversationParticipantsInput,
  UpdateIdentityInput,
  UpdateWorkspaceInput,
  UpdateWorkspaceMemberInput,
} from "./types.ts";
import type { MessageListOptions } from "./storage.ts";

export interface ConversationEventOptions {
  signal?: AbortSignal;
  onReady?(): void;
}

export interface PostMessageOptions {
  idempotencyKey?: string;
}

export interface ClientMessageListOptions extends MessageListOptions {
  signal?: AbortSignal;
}

export interface ConversationClientOptions {
  serviceToken?: string;
  actorIdentityId?: string;
}

/** HTTP failures retain their status without exposing response internals to callers. */
export class ConversationClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ConversationClientError";
  }
}

function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

export class ConversationClient {
  constructor(readonly endpoint: string, private readonly options: ConversationClientOptions = {}) {}

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

  async listWorkspaceConversations(workspaceId: string): Promise<ConversationMetadata[]> {
    const response = await this.request(`/workspaces/${workspaceId}/conversations`);
    return ((await response.json()) as { conversations: ConversationMetadata[] }).conversations;
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const response = await this.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { conversation: Conversation }).conversation;
  }

  async updateConversation(conversationId: string, input: UpdateConversationInput): Promise<ConversationMetadata> {
    const response = await this.request(`/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { conversation: ConversationMetadata }).conversation;
  }

  async updateConversationParticipants(
    conversationId: string,
    input: UpdateConversationParticipantsInput,
  ): Promise<ConversationMetadata> {
    const response = await this.request(`/conversations/${conversationId}/participants`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { conversation: ConversationMetadata }).conversation;
  }

  async getConversation(conversationId: string): Promise<ConversationMetadata> {
    const response = await this.request(`/conversations/${conversationId}`);
    return ((await response.json()) as { conversation: ConversationMetadata }).conversation;
  }

  async postMessage(
    conversationId: string,
    input: CreateMessageInput,
    options: PostMessageOptions = {},
  ): Promise<ConversationMessage> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey;
    }
    const response = await this.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    return ((await response.json()) as { message: ConversationMessage }).message;
  }

  async postResponse(
    conversationId: string,
    input: CreateResponseInput,
  ): Promise<ResponseResult> {
    const response = await this.request(`/conversations/${conversationId}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return (await response.json()) as ResponseResult;
  }

  async listMessages(conversationId: string, options: ClientMessageListOptions = {}): Promise<ConversationMessage[]> {
    const query = new URLSearchParams();
    if (options.afterSequence !== undefined) query.set("afterSequence", String(options.afterSequence));
    if (options.beforeSequence !== undefined) query.set("beforeSequence", String(options.beforeSequence));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size > 0 ? `?${query}` : "";
    const response = await this.request(`/conversations/${conversationId}/messages${suffix}`, {
      signal: options.signal,
    });
    return ((await response.json()) as { messages: ConversationMessage[] }).messages;
  }

  events(conversationId: string, options: ConversationEventOptions = {}): AsyncIterable<ConversationEvent> {
    return this.eventStream(`/conversations/${conversationId}/events`, options);
  }

  eventsMany(conversationIds: readonly string[], options: ConversationEventOptions = {}): AsyncIterable<ConversationEvent> {
    if (conversationIds.length === 0) throw new RangeError("eventsMany requires at least one Conversation");
    const query = new URLSearchParams();
    for (const conversationId of [...new Set(conversationIds)]) query.append("conversationId", conversationId);
    return this.eventStream(`/conversations/events?${query}`, options);
  }

  private async *eventStream(path: string, options: ConversationEventOptions): AsyncIterable<ConversationEvent> {
    const response = await this.request(path, { signal: options.signal });
    if (!response.body) throw new Error("Conversation event response has no body");
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
          yield JSON.parse(data) as ConversationEvent;
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
      throw new ConversationClientError(
        body.error ?? `Conversation request failed (${response.status})`,
        response.status,
        retryAfterMilliseconds(response.headers.get("retry-after")),
      );
    }
    return response;
  }
}
