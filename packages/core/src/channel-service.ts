import { createHash } from "node:crypto";
import { createResourceId } from "./ids.ts";
import {
  InMemoryChannelStorage,
  type ChannelStorage,
  type NewChannelMessage,
  type WorkspaceMemberUpdateResult,
} from "./storage.ts";
import type {
  Channel,
  ChannelEvent,
  ChannelMessage,
  AddWorkspaceMemberInput,
  ChannelMetadata,
  CreateChannelInput,
  CreateIdentityInput,
  CreateMessageInput,
  CreateResponseInput,
  CreateWorkspaceInput,
  Identity,
  Participant,
  ResponseResult,
  Workspace,
  WorkspaceMember,
  UpdateChannelInput,
  UpdateChannelParticipantsInput,
  UpdateWorkspaceMemberInput,
} from "./types.ts";

export class ChannelNotFoundError extends Error {}
export class ChannelValidationError extends Error {}
export class ChannelConflictError extends Error {}

type EventListener = (event: ChannelEvent) => void;

const LEGACY_WORKSPACE_ID = "legacy-default-workspace";

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
    status: participant.status ?? "active",
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
  const resolveTarget = (target: string): string => {
    if (target === "@channel" || target === "channel") return "@channel";
    const participant = channel.participants.find(
      (candidate) => candidate.id === target || candidate.handle?.toLowerCase() === target.toLowerCase(),
    );
    if (!participant) throw new ChannelValidationError(`Target participant is not in channel: ${target}`);
    if (participant.status === "disabled") {
      throw new ChannelValidationError(`Target participant is disabled: ${target}`);
    }
    return participant.id;
  };
  const mentioned = [...input.body.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)\b/g)].map(
    (match) => resolveTarget(match[1]!),
  );
  const structured = (input.to ?? []).map((target) => {
    if (typeof target !== "string" || !target.trim()) {
      throw new ChannelValidationError("to must contain non-empty participant ids");
    }
    return resolveTarget(target.trim());
  });
  return [...new Set([...structured, ...mentioned])];
}

export class ChannelService {
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(readonly storage: ChannelStorage = new InMemoryChannelStorage()) {}

  async createIdentity(input: CreateIdentityInput): Promise<Identity> {
    if (!input || !["human", "agent", "service"].includes(input.type)) {
      throw new ChannelValidationError("identity type must be human, agent, or service");
    }
    const displayName = input.displayName?.trim() || undefined;
    const publicProfile = input.publicProfile?.trim() || undefined;
    if (displayName && displayName.length > 200) {
      throw new ChannelValidationError("identity displayName must be at most 200 characters");
    }
    if (publicProfile && publicProfile.length > 1_000) {
      throw new ChannelValidationError("identity publicProfile must be at most 1000 characters");
    }
    const timestamp = new Date().toISOString();
    return await this.storage.createIdentity({
      id: createResourceId("identity"),
      type: input.type,
      displayName,
      publicProfile,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async getIdentity(identityId: string): Promise<Identity> {
    const identity = await this.storage.getIdentity(identityId);
    if (!identity) throw new ChannelNotFoundError(`Identity not found: ${identityId}`);
    return identity;
  }

  async listIdentities(): Promise<Identity[]> {
    return await this.storage.listIdentities();
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    if (!input || typeof input.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug)) {
      throw new ChannelValidationError("workspace slug must use lowercase letters, digits, and hyphens");
    }
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 200) {
      throw new ChannelValidationError("workspace name must be a non-empty string up to 200 characters");
    }
    if ((await this.storage.listWorkspaces()).some((workspace) => workspace.slug === input.slug)) {
      throw new ChannelConflictError(`Workspace slug already exists: ${input.slug}`);
    }
    const description = input.description?.trim() || undefined;
    if (description && description.length > 1_000) {
      throw new ChannelValidationError("workspace description must be at most 1000 characters");
    }
    const timestamp = new Date().toISOString();
    return await this.storage.createWorkspace({
      id: createResourceId("workspace"),
      slug: input.slug,
      name: input.name.trim(),
      description,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = await this.storage.getWorkspace(workspaceId);
    if (!workspace) throw new ChannelNotFoundError(`Workspace not found: ${workspaceId}`);
    return workspace;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return await this.storage.listWorkspaces();
  }

  async addWorkspaceMember(
    workspaceId: string,
    input: AddWorkspaceMemberInput,
  ): Promise<WorkspaceMember> {
    const workspace = await this.getWorkspace(workspaceId);
    if (workspace.status !== "active") throw new ChannelValidationError("Workspace is archived");
    const identity = await this.getIdentity(input.identityId);
    if (identity.status !== "active") throw new ChannelValidationError("Identity is disabled");
    if (typeof input.mentionHandle !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(input.mentionHandle)) {
      throw new ChannelValidationError("mentionHandle must be mention-safe and at most 63 characters");
    }
    if ((await this.storage.getWorkspaceMember(workspaceId, identity.id))) {
      throw new ChannelConflictError("Identity is already a Workspace member");
    }
    if ((await this.storage.listWorkspaceMembers(workspaceId)).some(
      (member) => member.mentionHandle.toLowerCase() === input.mentionHandle.toLowerCase(),
    )) {
      throw new ChannelConflictError(`Workspace mention handle already exists: ${input.mentionHandle}`);
    }
    const accessRole = input.accessRole ?? "member";
    if (!["owner", "admin", "member"].includes(accessRole)) {
      throw new ChannelValidationError("accessRole must be owner, admin, or member");
    }
    if (identity.type !== "human" && accessRole !== "member") {
      throw new ChannelValidationError("Agents and services must use member access");
    }
    const roleLabel = input.roleLabel?.trim() || undefined;
    const profileOverride = input.profileOverride?.trim() || undefined;
    if (roleLabel && roleLabel.length > 100) throw new ChannelValidationError("roleLabel is too long");
    if (profileOverride && profileOverride.length > 1_000) {
      throw new ChannelValidationError("profileOverride is too long");
    }
    const timestamp = new Date().toISOString();
    return await this.storage.addWorkspaceMember({
      workspaceId,
      identityId: identity.id,
      mentionHandle: input.mentionHandle.toLowerCase(),
      accessRole,
      roleLabel,
      profileOverride,
      status: "active",
      joinedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    await this.getWorkspace(workspaceId);
    return await this.storage.listWorkspaceMembers(workspaceId);
  }

  async updateWorkspaceMember(
    workspaceId: string,
    identityId: string,
    input: UpdateWorkspaceMemberInput,
  ): Promise<WorkspaceMember> {
    const workspace = await this.getWorkspace(workspaceId);
    if (workspace.status !== "active") throw new ChannelValidationError("Workspace is archived");
    if (!input || typeof input.actorIdentityId !== "string" || !input.actorIdentityId.trim()) {
      throw new ChannelValidationError("actorIdentityId is required");
    }
    if (input.mentionHandle === undefined && input.accessRole === undefined
      && input.roleLabel === undefined && input.profileOverride === undefined
      && input.status === undefined) {
      throw new ChannelValidationError("At least one membership field must be updated");
    }
    const [identity, target, actor, members] = await Promise.all([
      this.getIdentity(identityId),
      this.storage.getWorkspaceMember(workspaceId, identityId),
      this.storage.getWorkspaceMember(workspaceId, input.actorIdentityId),
      this.storage.listWorkspaceMembers(workspaceId),
    ]);
    if (!target) throw new ChannelNotFoundError(`Workspace member not found: ${identityId}`);
    if (!actor || actor.status !== "active" || !["owner", "admin"].includes(actor.accessRole)) {
      throw new ChannelValidationError("An active Workspace owner or admin is required");
    }
    if (target.accessRole === "owner" && actor.accessRole !== "owner") {
      throw new ChannelValidationError("Only an owner may update another owner");
    }
    if (input.mentionHandle !== undefined && typeof input.mentionHandle !== "string") {
      throw new ChannelValidationError("mentionHandle must be a string");
    }
    if (input.roleLabel !== undefined && input.roleLabel !== null
      && typeof input.roleLabel !== "string") {
      throw new ChannelValidationError("roleLabel must be a string or null");
    }
    if (input.profileOverride !== undefined && input.profileOverride !== null
      && typeof input.profileOverride !== "string") {
      throw new ChannelValidationError("profileOverride must be a string or null");
    }
    const mentionHandle = input.mentionHandle === undefined
      ? target.mentionHandle
      : input.mentionHandle.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(mentionHandle)) {
      throw new ChannelValidationError("mentionHandle must be mention-safe and at most 63 characters");
    }
    if (members.some((member) => member.identityId !== identityId
      && member.mentionHandle.toLowerCase() === mentionHandle)) {
      throw new ChannelConflictError(`Workspace mention handle already exists: ${mentionHandle}`);
    }
    const accessRole = input.accessRole ?? target.accessRole;
    if (!["owner", "admin", "member"].includes(accessRole)) {
      throw new ChannelValidationError("accessRole must be owner, admin, or member");
    }
    if (accessRole !== target.accessRole && actor.accessRole !== "owner") {
      throw new ChannelValidationError("Only an owner may change access roles");
    }
    if (identity.type !== "human" && accessRole !== "member") {
      throw new ChannelValidationError("Agents and services must use member access");
    }
    const status = input.status ?? target.status;
    if (!["active", "disabled"].includes(status)) {
      throw new ChannelValidationError("status must be active or disabled");
    }
    if (target.accessRole === "owner" && (status === "disabled" || accessRole !== "owner")
      && members.filter((member) => member.status === "active" && member.accessRole === "owner").length <= 1) {
      throw new ChannelValidationError("A Workspace must retain an active owner");
    }
    const roleLabel = input.roleLabel === undefined
      ? target.roleLabel
      : input.roleLabel?.trim() || undefined;
    const profileOverride = input.profileOverride === undefined
      ? target.profileOverride
      : input.profileOverride?.trim() || undefined;
    if (roleLabel && roleLabel.length > 100) throw new ChannelValidationError("roleLabel is too long");
    if (profileOverride && profileOverride.length > 1_000) {
      throw new ChannelValidationError("profileOverride is too long");
    }
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(target.updatedAt) + 1)).toISOString();
    const member: WorkspaceMember = {
      ...target,
      mentionHandle,
      accessRole,
      roleLabel,
      profileOverride,
      status,
      updatedAt,
    };
    let result: WorkspaceMemberUpdateResult | undefined;
    try {
      result = await this.storage.updateWorkspaceMember(member, {
        id: identity.id,
        handle: member.mentionHandle,
        type: identity.type,
        displayName: identity.displayName,
        role: member.roleLabel,
        profile: member.profileOverride ?? identity.publicProfile,
        status: member.status,
      }, target.updatedAt);
    } catch (error) {
      if (error instanceof Error && error.message.includes("retain an active owner")) {
        throw new ChannelValidationError("A Workspace must retain an active owner");
      }
      throw error;
    }
    if (!result) throw new ChannelConflictError("Workspace membership changed; reload and retry");
    for (const roster of result.rosters) {
      const event: ChannelEvent = {
        id: createResourceId("event"),
        type: "roster.updated",
        channelId: roster.channelId,
        rosterRevision: roster.rosterRevision,
        createdAt: updatedAt,
      };
      for (const listener of this.listeners.get(roster.channelId) ?? []) listener(event);
    }
    return result.member;
  }

  async listWorkspaceChannels(workspaceId: string): Promise<ChannelMetadata[]> {
    await this.getWorkspace(workspaceId);
    return await this.storage.listWorkspaceChannels(workspaceId);
  }

  private async assertWorkspaceAdministrator(
    workspaceId: string,
    actorIdentityId: string,
  ): Promise<void> {
    const actor = await this.storage.getWorkspaceMember(workspaceId, actorIdentityId);
    if (!actor || actor.status !== "active" || !["owner", "admin"].includes(actor.accessRole)) {
      throw new ChannelValidationError("An active Workspace owner or admin is required");
    }
  }

  private async resolveActiveParticipants(
    workspaceId: string,
    participantIds: string[],
  ): Promise<Participant[]> {
    if (participantIds.length === 0) {
      throw new ChannelValidationError("A Channel must have at least one participant");
    }
    if (new Set(participantIds).size !== participantIds.length) {
      throw new ChannelValidationError("participantIds must be unique within a Channel");
    }
    if (participantIds.some((identityId) => typeof identityId !== "string" || !identityId.trim())) {
      throw new ChannelValidationError("participantIds must contain non-empty identity ids");
    }
    return await Promise.all(participantIds.map(async (identityId) => {
      const [identity, member] = await Promise.all([
        this.getIdentity(identityId),
        this.storage.getWorkspaceMember(workspaceId, identityId),
      ]);
      if (identity.status !== "active" || !member || member.status !== "active") {
        throw new ChannelValidationError(`Identity is not an active Workspace member: ${identityId}`);
      }
      return {
        id: identity.id,
        handle: member.mentionHandle,
        type: identity.type,
        displayName: identity.displayName,
        role: member.roleLabel,
        profile: member.profileOverride ?? identity.publicProfile,
        status: "active",
      };
    }));
  }

  async createChannel(input: CreateChannelInput): Promise<Channel> {
    if (!input || (input.participantIds === undefined && input.participants === undefined)) {
      throw new ChannelValidationError("participantIds must be an array");
    }
    if (input.participantIds !== undefined && input.participants !== undefined) {
      throw new ChannelValidationError("participantIds and legacy participants are mutually exclusive");
    }
    if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim())) {
      throw new ChannelValidationError("Channel name must be a non-empty string");
    }
    const requestedName = input.name?.trim();
    if (requestedName && requestedName.length > 100) {
      throw new ChannelValidationError("Channel name must be at most 100 characters");
    }
    let workspaceId = input.workspaceId;
    let participants: Participant[];
    if (input.participantIds !== undefined) {
      if (!Array.isArray(input.participantIds) || !workspaceId) {
        throw new ChannelValidationError("workspaceId and participantIds are required");
      }
      const workspace = await this.getWorkspace(workspaceId);
      if (workspace.status !== "active") throw new ChannelValidationError("Workspace is archived");
      if (input.actorIdentityId !== undefined) {
        if (typeof input.actorIdentityId !== "string" || !input.actorIdentityId.trim()) {
          throw new ChannelValidationError("actorIdentityId must be a non-empty string");
        }
        await this.assertWorkspaceAdministrator(workspaceId, input.actorIdentityId);
      }
      participants = await this.resolveActiveParticipants(workspaceId, input.participantIds);
    } else {
      if (input.workspaceId && input.workspaceId !== LEGACY_WORKSPACE_ID) {
        throw new ChannelValidationError("legacy participants cannot be used with an explicit Workspace");
      }
      const legacy = input.participants!.map(validateParticipant);
      if (new Set(legacy.map((participant) => participant.id)).size !== legacy.length) {
        throw new ChannelValidationError("participant ids must be unique within a channel");
      }
      workspaceId = workspaceId ?? LEGACY_WORKSPACE_ID;
      if (!(await this.storage.getWorkspace(workspaceId))) {
        const timestamp = new Date().toISOString();
        await this.storage.createWorkspace({
          id: workspaceId,
          slug: "legacy-default",
          name: "Legacy Default Workspace",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      participants = [];
      for (const participant of legacy) {
        let identity = await this.storage.getIdentity(participant.id);
        if (!identity) {
          const timestamp = new Date().toISOString();
          identity = await this.storage.createIdentity({
            id: participant.id,
            type: participant.type,
            displayName: participant.displayName,
            publicProfile: participant.profile,
            status: "active",
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        } else if (identity.type !== participant.type) {
          throw new ChannelConflictError(`Legacy participant id has another identity type: ${participant.id}`);
        }
        const mentionHandle = (participant.handle ?? participant.id).toLowerCase();
        if (!(await this.storage.getWorkspaceMember(workspaceId, identity.id))) {
          const timestamp = new Date().toISOString();
          await this.storage.addWorkspaceMember({
            workspaceId,
            identityId: identity.id,
            mentionHandle,
            accessRole: "member",
            roleLabel: participant.role,
            profileOverride: participant.profile,
            status: "active",
            joinedAt: timestamp,
            updatedAt: timestamp,
          });
        }
        participants.push({ ...participant, handle: mentionHandle });
      }
    }
    const channelId = createResourceId("channel");
    return await this.storage.createChannel({
      id: channelId,
      workspaceId: workspaceId!,
      name: requestedName ?? `Channel ${channelId.slice("channel_".length, "channel_".length + 8)}`,
      participants,
      messages: [],
      rosterRevision: 1,
      createdAt: new Date().toISOString(),
    });
  }

  async updateChannel(channelId: string, input: UpdateChannelInput): Promise<ChannelMetadata> {
    if (!input || typeof input.actorIdentityId !== "string" || !input.actorIdentityId.trim()) {
      throw new ChannelValidationError("actorIdentityId is required");
    }
    if (typeof input.name !== "string" || !input.name.trim()) {
      throw new ChannelValidationError("Channel name must be a non-empty string");
    }
    const name = input.name.trim();
    if (name.length > 100) {
      throw new ChannelValidationError("Channel name must be at most 100 characters");
    }
    const channel = await this.getChannelMetadata(channelId);
    const workspace = await this.getWorkspace(channel.workspaceId);
    if (workspace.status !== "active") throw new ChannelValidationError("Workspace is archived");
    await this.assertWorkspaceAdministrator(channel.workspaceId, input.actorIdentityId);
    const updated = await this.storage.updateChannelName(channelId, name);
    if (!updated) throw new ChannelNotFoundError(`Channel not found: ${channelId}`);
    const event: ChannelEvent = {
      id: createResourceId("event"),
      type: "channel.updated",
      channelId,
      createdAt: new Date().toISOString(),
    };
    for (const listener of this.listeners.get(channelId) ?? []) listener(event);
    return updated;
  }

  async updateChannelParticipants(
    channelId: string,
    input: UpdateChannelParticipantsInput,
  ): Promise<ChannelMetadata> {
    if (!input || typeof input.actorIdentityId !== "string" || !input.actorIdentityId.trim()) {
      throw new ChannelValidationError("actorIdentityId is required");
    }
    if (!Array.isArray(input.participantIds)) {
      throw new ChannelValidationError("participantIds must be an array");
    }
    if (!Number.isSafeInteger(input.expectedRosterRevision) || input.expectedRosterRevision < 1) {
      throw new ChannelValidationError("expectedRosterRevision must be a positive integer");
    }
    const channel = await this.getChannelMetadata(channelId);
    const workspace = await this.getWorkspace(channel.workspaceId);
    if (workspace.status !== "active") throw new ChannelValidationError("Workspace is archived");
    await this.assertWorkspaceAdministrator(channel.workspaceId, input.actorIdentityId);
    const participants = await this.resolveActiveParticipants(
      channel.workspaceId,
      input.participantIds,
    );
    const updatedAt = new Date().toISOString();
    const result = await this.storage.replaceChannelParticipants(
      channelId,
      participants,
      input.expectedRosterRevision,
      updatedAt,
    );
    if (!result) throw new ChannelConflictError("Channel roster changed; reload and retry");
    const event: ChannelEvent = {
      id: createResourceId("event"),
      type: "roster.updated",
      channelId,
      rosterRevision: result.channel.rosterRevision,
      createdAt: updatedAt,
    };
    for (const listener of this.listeners.get(channelId) ?? []) listener(event);
    return result.channel;
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

  private async assertActiveWorkspaceIdentity(channel: Channel, identityId: string): Promise<void> {
    const [identity, member] = await Promise.all([
      this.storage.getIdentity(identityId),
      this.storage.getWorkspaceMember(channel.workspaceId, identityId),
    ]);
    if (!identity || identity.status !== "active" || !member || member.status !== "active") {
      throw new ChannelValidationError(`Identity is not active in the Channel Workspace: ${identityId}`);
    }
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
    await this.assertActiveWorkspaceIdentity(channel, participantId);
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
    await Promise.all(to.filter((target) => target !== "@channel").map(
      (target) => this.assertActiveWorkspaceIdentity(channel, target),
    ));
    const pendingMessage: NewChannelMessage = {
      id: createResourceId("message"),
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
        id: createResourceId("event"),
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
    await this.assertActiveWorkspaceIdentity(channel, participant.id);
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

    const to = messageTargets(channel, { participantId: input.participantId, body: input.body });
    await Promise.all(to.filter((target) => target !== "@channel").map(
      (target) => this.assertActiveWorkspaceIdentity(channel, target),
    ));
    const result = await this.storage.commitResponse(
      {
        id: createResourceId("message"),
        channelId,
        participantId: input.participantId,
        to,
        body: input.body,
        replyTo: trigger.id,
        createdAt: new Date().toISOString(),
      },
      trigger.sequence,
    );
    if (result.created) {
      const event: ChannelEvent = {
        id: createResourceId("event"),
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
