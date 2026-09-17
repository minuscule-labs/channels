import { assertConversationLifecycle } from "./types.ts";
import type {
  Conversation,
  ConversationCursorStore,
  ConversationLifecycle,
  ConversationMessage,
  ConversationMetadata,
  Identity,
  Participant,
  ResponseResult,
  Workspace,
  WorkspaceMember,
} from "./types.ts";

export type NewConversationMessage = Omit<ConversationMessage, "sequence">;
export type NewResponseMessage = NewConversationMessage & { replyTo: string };

export interface MessageListOptions {
  afterSequence?: number;
  beforeSequence?: number;
  limit?: number;
}

export interface MessageCommitResult {
  message: ConversationMessage;
  outcome: "created" | "replayed" | "conflict";
}

export interface IdentityUpdateResult {
  identity: Identity;
  rosters: Array<{ conversationId: string; rosterRevision: number }>;
}

export interface WorkspaceMemberUpdateResult {
  member: WorkspaceMember;
  rosters: Array<{ conversationId: string; rosterRevision: number }>;
}

export interface ConversationRosterUpdateResult {
  conversation: ConversationMetadata;
  removedParticipantIds: string[];
}

export interface ConversationStorage extends ConversationCursorStore {
  createIdentity(identity: Identity): Promise<Identity>;
  updateIdentity(identity: Identity): Promise<IdentityUpdateResult | undefined>;
  getIdentity(identityId: string): Promise<Identity | undefined>;
  listIdentities(): Promise<Identity[]>;
  createWorkspace(workspace: Workspace): Promise<Workspace>;
  updateWorkspace(workspace: Workspace): Promise<Workspace | undefined>;
  getWorkspace(workspaceId: string): Promise<Workspace | undefined>;
  listWorkspaces(): Promise<Workspace[]>;
  addWorkspaceMember(member: WorkspaceMember): Promise<WorkspaceMember>;
  updateWorkspaceMember(
    member: WorkspaceMember,
    participant: Participant,
    expectedUpdatedAt: string,
  ): Promise<WorkspaceMemberUpdateResult | undefined>;
  getWorkspaceMember(workspaceId: string, identityId: string): Promise<WorkspaceMember | undefined>;
  listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  createConversation(conversation: Conversation): Promise<Conversation>;
  listWorkspaceConversations(workspaceId: string): Promise<ConversationMetadata[]>;
  getConversation(conversationId: string): Promise<Conversation | undefined>;
  getConversationMetadata(conversationId: string): Promise<ConversationMetadata | undefined>;
  getConversationLifecycle(conversationId: string): Promise<ConversationLifecycle | undefined>;
  putConversationLifecycle(lifecycle: ConversationLifecycle): Promise<ConversationLifecycle>;
  listMessages(conversationId: string, options?: MessageListOptions): Promise<ConversationMessage[] | undefined>;
  updateConversationName(conversationId: string, name: string): Promise<ConversationMetadata | undefined>;
  replaceConversationParticipants(
    conversationId: string,
    participants: Participant[],
    expectedRosterRevision: number,
    updatedAt: string,
  ): Promise<ConversationRosterUpdateResult | undefined>;
  appendMessage(message: NewConversationMessage): Promise<ConversationMessage>;
  commitMessage(
    message: NewConversationMessage,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<MessageCommitResult>;
  commitResponse(
    message: NewResponseMessage,
    triggerSequence: number,
  ): Promise<ResponseResult>;
  close?(): Promise<void> | void;
}

function copyConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    participants: conversation.participants.map((participant) => ({ ...participant })),
    messages: conversation.messages.map((message) => ({ ...message, to: [...message.to] })),
  };
}

export class InMemoryConversationStorage implements ConversationStorage, ConversationCursorStore {
  private readonly identities = new Map<string, Identity>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly workspaceMembers = new Map<string, WorkspaceMember>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly lifecycles = new Map<string, ConversationLifecycle>();
  private readonly cursors = new Map<string, number>();
  private readonly responses = new Map<string, ConversationMessage>();
  private readonly messageRequests = new Map<
    string,
    { requestFingerprint: string; message: ConversationMessage }
  >();
  private readonly pendingMessages = new Map<string, Promise<MessageCommitResult>>();
  private readonly pendingResponses = new Map<string, Promise<ResponseResult>>();

  async createIdentity(identity: Identity): Promise<Identity> {
    if (this.identities.has(identity.id)) throw new Error(`Identity id already exists: ${identity.id}`);
    this.identities.set(identity.id, { ...identity });
    return { ...identity };
  }

  async updateIdentity(identity: Identity): Promise<IdentityUpdateResult | undefined> {
    if (!this.identities.has(identity.id)) return undefined;
    this.identities.set(identity.id, { ...identity });
    const rosters: IdentityUpdateResult["rosters"] = [];
    for (const conversation of this.conversations.values()) {
      const participant = conversation.participants.find(({ id }) => id === identity.id);
      if (!participant) continue;
      participant.displayName = identity.displayName;
      conversation.rosterRevision += 1;
      rosters.push({ conversationId: conversation.id, rosterRevision: conversation.rosterRevision });
    }
    return { identity: { ...identity }, rosters };
  }

  async getIdentity(identityId: string): Promise<Identity | undefined> {
    const identity = this.identities.get(identityId);
    return identity ? { ...identity } : undefined;
  }

  async listIdentities(): Promise<Identity[]> {
    return [...this.identities.values()].map((identity) => ({ ...identity }));
  }

  async createWorkspace(workspace: Workspace): Promise<Workspace> {
    if (this.workspaces.has(workspace.id)) throw new Error(`Workspace id already exists: ${workspace.id}`);
    this.workspaces.set(workspace.id, { ...workspace });
    return { ...workspace };
  }

  async updateWorkspace(workspace: Workspace): Promise<Workspace | undefined> {
    if (!this.workspaces.has(workspace.id)) return undefined;
    this.workspaces.set(workspace.id, { ...workspace });
    return { ...workspace };
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | undefined> {
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? { ...workspace } : undefined;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return [...this.workspaces.values()].map((workspace) => ({ ...workspace }));
  }

  async addWorkspaceMember(member: WorkspaceMember): Promise<WorkspaceMember> {
    this.workspaceMembers.set(`${member.workspaceId}:${member.identityId}`, { ...member });
    return { ...member };
  }

  async updateWorkspaceMember(
    member: WorkspaceMember,
    participant: Participant,
    expectedUpdatedAt: string,
  ): Promise<WorkspaceMemberUpdateResult | undefined> {
    const key = `${member.workspaceId}:${member.identityId}`;
    const current = this.workspaceMembers.get(key);
    if (current?.updatedAt !== expectedUpdatedAt) return undefined;
    if (current.status === "active" && current.accessRole === "owner"
      && (member.status !== "active" || member.accessRole !== "owner")
      && ![...this.workspaceMembers.values()].some((candidate) =>
        candidate.workspaceId === member.workspaceId
        && candidate.identityId !== member.identityId
        && candidate.status === "active"
        && candidate.accessRole === "owner")) {
      throw new Error("Workspace must retain an active owner");
    }
    const duplicate = [...this.workspaceMembers.values()].find(
      (candidate) => candidate.workspaceId === member.workspaceId
        && candidate.identityId !== member.identityId
        && candidate.mentionHandle === member.mentionHandle,
    );
    if (duplicate) throw new Error("Workspace mention handle already exists");
    this.workspaceMembers.set(key, { ...member });
    const rosters: WorkspaceMemberUpdateResult["rosters"] = [];
    for (const conversation of this.conversations.values()) {
      if (conversation.workspaceId !== member.workspaceId) continue;
      const index = conversation.participants.findIndex(({ id }) => id === member.identityId);
      if (index < 0) continue;
      conversation.participants[index] = { ...participant };
      conversation.rosterRevision += 1;
      if (member.status === "disabled") {
        this.cursors.set(
          `${conversation.id}:${member.identityId}`,
          conversation.messages.at(-1)?.sequence ?? 0,
        );
      }
      rosters.push({ conversationId: conversation.id, rosterRevision: conversation.rosterRevision });
    }
    return { member: { ...member }, rosters };
  }

  async getWorkspaceMember(
    workspaceId: string,
    identityId: string,
  ): Promise<WorkspaceMember | undefined> {
    const member = this.workspaceMembers.get(`${workspaceId}:${identityId}`);
    return member ? { ...member } : undefined;
  }

  async listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    return [...this.workspaceMembers.values()]
      .filter((member) => member.workspaceId === workspaceId)
      .map((member) => ({ ...member }));
  }

  async createConversation(conversation: Conversation): Promise<Conversation> {
    if (this.conversations.has(conversation.id)) throw new Error(`Conversation id already exists: ${conversation.id}`);
    this.conversations.set(conversation.id, copyConversation(conversation));
    return copyConversation(conversation);
  }

  async listWorkspaceConversations(workspaceId: string): Promise<ConversationMetadata[]> {
    return [...this.conversations.values()]
      .filter((conversation) => conversation.workspaceId === workspaceId)
      .map((conversation) => ({
        id: conversation.id,
        workspaceId: conversation.workspaceId,
        name: conversation.name,
        createdAt: conversation.createdAt,
        rosterRevision: conversation.rosterRevision,
        participants: conversation.participants.map((participant) => ({ ...participant })),
      }));
  }

  async getConversation(conversationId: string): Promise<Conversation | undefined> {
    const conversation = this.conversations.get(conversationId);
    return conversation ? copyConversation(conversation) : undefined;
  }

  async listMessages(
    conversationId: string,
    options: MessageListOptions = {},
  ): Promise<ConversationMessage[] | undefined> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return undefined;
    let messages = conversation.messages.filter((message) =>
      (options.afterSequence === undefined || message.sequence > options.afterSequence)
      && (options.beforeSequence === undefined || message.sequence < options.beforeSequence));
    if (options.limit !== undefined) {
      messages = options.beforeSequence === undefined
        ? messages.slice(0, options.limit)
        : messages.slice(-options.limit);
    }
    return messages.map((message) => ({ ...message, to: [...message.to] }));
  }

  async getConversationMetadata(conversationId: string): Promise<ConversationMetadata | undefined> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return undefined;
    return {
      id: conversation.id,
      workspaceId: conversation.workspaceId,
      name: conversation.name,
      createdAt: conversation.createdAt,
      rosterRevision: conversation.rosterRevision,
      participants: conversation.participants.map((participant) => ({ ...participant })),
    };
  }

  async getConversationLifecycle(conversationId: string): Promise<ConversationLifecycle | undefined> {
    const lifecycle = this.lifecycles.get(conversationId);
    return lifecycle ? { ...lifecycle } : undefined;
  }

  async putConversationLifecycle(lifecycle: ConversationLifecycle): Promise<ConversationLifecycle> {
    assertConversationLifecycle(lifecycle);
    const conversation = this.conversations.get(lifecycle.conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${lifecycle.conversationId}`);
    if (conversation.workspaceId !== lifecycle.workspaceId) {
      throw new Error(`Conversation Workspace does not match: ${lifecycle.conversationId}`);
    }
    this.lifecycles.set(lifecycle.conversationId, { ...lifecycle });
    return { ...lifecycle };
  }

  async updateConversationName(conversationId: string, name: string): Promise<ConversationMetadata | undefined> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return undefined;
    conversation.name = name;
    return await this.getConversationMetadata(conversationId);
  }

  async replaceConversationParticipants(
    conversationId: string,
    participants: Participant[],
    expectedRosterRevision: number,
    _updatedAt: string,
  ): Promise<ConversationRosterUpdateResult | undefined> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.rosterRevision !== expectedRosterRevision) return undefined;
    const nextIds = new Set(participants.map(({ id }) => id));
    const removedParticipantIds = conversation.participants
      .filter(({ id }) => !nextIds.has(id))
      .map(({ id }) => id);
    conversation.participants = participants.map((participant) => ({ ...participant }));
    conversation.rosterRevision += 1;
    const headSequence = conversation.messages.at(-1)?.sequence ?? 0;
    for (const participantId of removedParticipantIds) {
      this.cursors.set(`${conversation.id}:${participantId}`, headSequence);
    }
    return {
      conversation: (await this.getConversationMetadata(conversationId))!,
      removedParticipantIds,
    };
  }

  async appendMessage(message: NewConversationMessage): Promise<ConversationMessage> {
    const conversation = this.conversations.get(message.conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${message.conversationId}`);
    const stored = { ...message, sequence: conversation.messages.length + 1, to: [...message.to] };
    conversation.messages.push(stored);
    return { ...stored, to: [...stored.to] };
  }

  async commitMessage(
    message: NewConversationMessage,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<MessageCommitResult> {
    const requestKey = JSON.stringify([message.conversationId, message.participantId, idempotencyKey]);
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
    message: NewConversationMessage,
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
    const deliveryKey = `${message.conversationId}:${message.participantId}:${message.replyTo}`;
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
    const cursorKey = `${message.conversationId}:${message.participantId}`;
    this.cursors.set(cursorKey, Math.max(this.cursors.get(cursorKey) ?? 0, triggerSequence));
    return { message: stored, created: true };
  }

  async getCursor(conversationId: string, participantId: string): Promise<number> {
    return this.cursors.get(`${conversationId}:${participantId}`) ?? 0;
  }

  async setCursor(conversationId: string, participantId: string, sequence: number): Promise<void> {
    this.cursors.set(`${conversationId}:${participantId}`, sequence);
  }
}
