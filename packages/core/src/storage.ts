import type {
  Channel,
  ChannelCursorStore,
  ChannelMessage,
  ChannelMetadata,
  Identity,
  Participant,
  ResponseResult,
  Workspace,
  WorkspaceMember,
} from "./types.ts";

export type NewChannelMessage = Omit<ChannelMessage, "sequence">;
export type NewResponseMessage = NewChannelMessage & { replyTo: string };

export interface MessageCommitResult {
  message: ChannelMessage;
  outcome: "created" | "replayed" | "conflict";
}

export interface WorkspaceMemberUpdateResult {
  member: WorkspaceMember;
  rosters: Array<{ channelId: string; rosterRevision: number }>;
}

export interface ChannelRosterUpdateResult {
  channel: ChannelMetadata;
  removedParticipantIds: string[];
}

export interface ChannelStorage extends ChannelCursorStore {
  createIdentity(identity: Identity): Promise<Identity>;
  getIdentity(identityId: string): Promise<Identity | undefined>;
  listIdentities(): Promise<Identity[]>;
  createWorkspace(workspace: Workspace): Promise<Workspace>;
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
  createChannel(channel: Channel): Promise<Channel>;
  listWorkspaceChannels(workspaceId: string): Promise<ChannelMetadata[]>;
  getChannel(channelId: string): Promise<Channel | undefined>;
  getChannelMetadata(channelId: string): Promise<ChannelMetadata | undefined>;
  updateChannelName(channelId: string, name: string): Promise<ChannelMetadata | undefined>;
  replaceChannelParticipants(
    channelId: string,
    participants: Participant[],
    expectedRosterRevision: number,
    updatedAt: string,
  ): Promise<ChannelRosterUpdateResult | undefined>;
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
  private readonly identities = new Map<string, Identity>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly workspaceMembers = new Map<string, WorkspaceMember>();
  private readonly channels = new Map<string, Channel>();
  private readonly cursors = new Map<string, number>();
  private readonly responses = new Map<string, ChannelMessage>();
  private readonly messageRequests = new Map<
    string,
    { requestFingerprint: string; message: ChannelMessage }
  >();
  private readonly pendingMessages = new Map<string, Promise<MessageCommitResult>>();
  private readonly pendingResponses = new Map<string, Promise<ResponseResult>>();

  async createIdentity(identity: Identity): Promise<Identity> {
    this.identities.set(identity.id, { ...identity });
    return { ...identity };
  }

  async getIdentity(identityId: string): Promise<Identity | undefined> {
    const identity = this.identities.get(identityId);
    return identity ? { ...identity } : undefined;
  }

  async listIdentities(): Promise<Identity[]> {
    return [...this.identities.values()].map((identity) => ({ ...identity }));
  }

  async createWorkspace(workspace: Workspace): Promise<Workspace> {
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
    for (const channel of this.channels.values()) {
      if (channel.workspaceId !== member.workspaceId) continue;
      const index = channel.participants.findIndex(({ id }) => id === member.identityId);
      if (index < 0) continue;
      channel.participants[index] = { ...participant };
      channel.rosterRevision += 1;
      if (member.status === "disabled") {
        this.cursors.set(
          `${channel.id}:${member.identityId}`,
          channel.messages.at(-1)?.sequence ?? 0,
        );
      }
      rosters.push({ channelId: channel.id, rosterRevision: channel.rosterRevision });
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

  async createChannel(channel: Channel): Promise<Channel> {
    this.channels.set(channel.id, copyChannel(channel));
    return copyChannel(channel);
  }

  async listWorkspaceChannels(workspaceId: string): Promise<ChannelMetadata[]> {
    return [...this.channels.values()]
      .filter((channel) => channel.workspaceId === workspaceId)
      .map((channel) => ({
        id: channel.id,
        workspaceId: channel.workspaceId,
        name: channel.name,
        createdAt: channel.createdAt,
        rosterRevision: channel.rosterRevision,
        participants: channel.participants.map((participant) => ({ ...participant })),
      }));
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
      workspaceId: channel.workspaceId,
      name: channel.name,
      createdAt: channel.createdAt,
      rosterRevision: channel.rosterRevision,
      participants: channel.participants.map((participant) => ({ ...participant })),
    };
  }

  async updateChannelName(channelId: string, name: string): Promise<ChannelMetadata | undefined> {
    const channel = this.channels.get(channelId);
    if (!channel) return undefined;
    channel.name = name;
    return await this.getChannelMetadata(channelId);
  }

  async replaceChannelParticipants(
    channelId: string,
    participants: Participant[],
    expectedRosterRevision: number,
    _updatedAt: string,
  ): Promise<ChannelRosterUpdateResult | undefined> {
    const channel = this.channels.get(channelId);
    if (!channel || channel.rosterRevision !== expectedRosterRevision) return undefined;
    const nextIds = new Set(participants.map(({ id }) => id));
    const removedParticipantIds = channel.participants
      .filter(({ id }) => !nextIds.has(id))
      .map(({ id }) => id);
    channel.participants = participants.map((participant) => ({ ...participant }));
    channel.rosterRevision += 1;
    const headSequence = channel.messages.at(-1)?.sequence ?? 0;
    for (const participantId of removedParticipantIds) {
      this.cursors.set(`${channel.id}:${participantId}`, headSequence);
    }
    return {
      channel: (await this.getChannelMetadata(channelId))!,
      removedParticipantIds,
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
