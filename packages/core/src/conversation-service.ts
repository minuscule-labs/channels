import { createHash } from "node:crypto";
import { createResourceId, isResourceId } from "./ids.ts";
import {
  InMemoryConversationStorage,
  type ConversationStorage,
  type MessageListOptions,
  type NewConversationMessage,
  type WorkspaceMemberUpdateResult,
} from "./storage.ts";
import type {
  Conversation,
  ConversationEvent,
  ConversationLifecycle,
  ConversationMessage,
  EffectiveConversationLifecycle,
  AddWorkspaceMemberInput,
  ConversationMetadata,
  CreateConversationInput,
  CreateIdentityInput,
  CreateMessageInput,
  CreateResponseInput,
  CreateWorkspaceInput,
  Identity,
  Participant,
  ResponseResult,
  Workspace,
  WorkspaceMember,
  UpdateConversationInput,
  UpdateConversationLifecycleInput,
  UpdateConversationParticipantsInput,
  UpdateIdentityInput,
  UpdateWorkspaceInput,
  UpdateWorkspaceMemberInput,
} from "./types.ts";

export class ConversationNotFoundError extends Error {}
export class ConversationValidationError extends Error {}
export class ConversationConflictError extends Error {}

type EventListener = (event: ConversationEvent) => void;

const LEGACY_WORKSPACE_ID = "legacy-default-workspace";

function validateParticipant(participant: Participant): Participant {
  if (!participant || typeof participant !== "object") {
    throw new ConversationValidationError("participants must contain objects");
  }
  if (typeof participant.id !== "string" || !participant.id.trim() || participant.id.length > 200) {
    throw new ConversationValidationError("participant id must be a non-empty string up to 200 characters");
  }
  if (!["human", "agent", "service"].includes(participant.type)) {
    throw new ConversationValidationError("participant type must be human, agent, or service");
  }
  if (participant.displayName !== undefined && typeof participant.displayName !== "string") {
    throw new ConversationValidationError("participant displayName must be a string");
  }
  if (participant.role !== undefined && typeof participant.role !== "string") {
    throw new ConversationValidationError("participant role must be a string");
  }
  if (participant.profile !== undefined && typeof participant.profile !== "string") {
    throw new ConversationValidationError("participant profile must be a string");
  }
  const displayName = participant.displayName?.trim() || undefined;
  const role = participant.role?.trim() || undefined;
  const profile = participant.profile?.trim() || undefined;
  if (displayName && displayName.length > 200) {
    throw new ConversationValidationError("participant displayName must be at most 200 characters");
  }
  if (role && role.length > 100) {
    throw new ConversationValidationError("participant role must be at most 100 characters");
  }
  if (profile && profile.length > 1_000) {
    throw new ConversationValidationError("participant profile must be at most 1000 characters");
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
    throw new ConversationValidationError("idempotency key must be a non-empty string");
  }
  if (Buffer.byteLength(idempotencyKey, "utf8") > 255) {
    throw new ConversationValidationError("idempotency key exceeds 255 UTF-8 bytes");
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

function messageTargets(conversation: Conversation, input: CreateMessageInput): string[] {
  if (input.to !== undefined && !Array.isArray(input.to)) {
    throw new ConversationValidationError("to must be an array of participant ids");
  }
  const resolveTarget = (target: string): string => {
    if (target === "@conversation" || target === "conversation") return "@conversation";
    const participant = conversation.participants.find(
      (candidate) => candidate.id === target || candidate.handle?.toLowerCase() === target.toLowerCase(),
    );
    if (!participant) throw new ConversationValidationError(`Target participant is not in conversation: ${target}`);
    if (participant.status === "disabled") {
      throw new ConversationValidationError(`Target participant is disabled: ${target}`);
    }
    return participant.id;
  };
  const mentioned = [...input.body.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)\b/g)].map(
    (match) => resolveTarget(match[1]!),
  );
  const structured = (input.to ?? []).map((target) => {
    if (typeof target !== "string" || !target.trim()) {
      throw new ConversationValidationError("to must contain non-empty participant ids");
    }
    return resolveTarget(target.trim());
  });
  return [...new Set([...structured, ...mentioned])];
}

export class ConversationService {
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(readonly storage: ConversationStorage = new InMemoryConversationStorage()) {}

  async createIdentity(input: CreateIdentityInput): Promise<Identity> {
    if (!input || !["human", "agent", "service"].includes(input.type)) {
      throw new ConversationValidationError("identity type must be human, agent, or service");
    }
    if (input.id !== undefined && !isResourceId(input.id, "identity")) {
      throw new ConversationValidationError("identity id must be a typed identity resource id");
    }
    if (input.id !== undefined && await this.storage.getIdentity(input.id)) {
      throw new ConversationConflictError(`Identity id already exists: ${input.id}`);
    }
    const displayName = input.displayName?.trim() || undefined;
    const publicProfile = input.publicProfile?.trim() || undefined;
    if (displayName && displayName.length > 200) {
      throw new ConversationValidationError("identity displayName must be at most 200 characters");
    }
    if (publicProfile && publicProfile.length > 1_000) {
      throw new ConversationValidationError("identity publicProfile must be at most 1000 characters");
    }
    const timestamp = new Date().toISOString();
    return await this.storage.createIdentity({
      id: input.id ?? createResourceId("identity"),
      type: input.type,
      displayName,
      publicProfile,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async updateIdentity(identityId: string, input: UpdateIdentityInput): Promise<Identity> {
    const identity = await this.getIdentity(identityId);
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId.trim()) {
      throw new ConversationValidationError("workspaceId is required");
    }
    if (typeof input.actorIdentityId !== "string" || !input.actorIdentityId.trim()) {
      throw new ConversationValidationError("actorIdentityId is required");
    }
    if (typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.trim().length > 200) {
      throw new ConversationValidationError("identity displayName must be a non-empty string up to 200 characters");
    }
    if (identity.type !== "agent" && identity.type !== "service") {
      throw new ConversationValidationError("Only agent and service names may be updated");
    }
    const target = await this.storage.getWorkspaceMember(input.workspaceId, identityId);
    if (!target) throw new ConversationNotFoundError(`Workspace member not found: ${identityId}`);
    await this.assertWorkspaceAdministrator(input.workspaceId, input.actorIdentityId);
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(identity.updatedAt) + 1)).toISOString();
    const result = await this.storage.updateIdentity({
      ...identity,
      displayName: input.displayName.trim(),
      updatedAt,
    });
    if (!result) throw new ConversationNotFoundError(`Identity not found: ${identityId}`);
    for (const roster of result.rosters) {
      const event: ConversationEvent = {
        id: createResourceId("event"),
        type: "roster.updated",
        conversationId: roster.conversationId,
        rosterRevision: roster.rosterRevision,
        createdAt: updatedAt,
      };
      for (const listener of this.listeners.get(roster.conversationId) ?? []) listener(event);
    }
    return result.identity;
  }

  async getIdentity(identityId: string): Promise<Identity> {
    const identity = await this.storage.getIdentity(identityId);
    if (!identity) throw new ConversationNotFoundError(`Identity not found: ${identityId}`);
    return identity;
  }

  async listIdentities(): Promise<Identity[]> {
    return await this.storage.listIdentities();
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    if (!input || typeof input.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug)) {
      throw new ConversationValidationError("workspace slug must use lowercase letters, digits, and hyphens");
    }
    if (input.id !== undefined && !isResourceId(input.id, "workspace")) {
      throw new ConversationValidationError("workspace id must be a typed Workspace resource id");
    }
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 200) {
      throw new ConversationValidationError("workspace name must be a non-empty string up to 200 characters");
    }
    const existingWorkspaces = await this.storage.listWorkspaces();
    if (existingWorkspaces.some((workspace) => workspace.slug === input.slug)) {
      throw new ConversationConflictError(`Workspace slug already exists: ${input.slug}`);
    }
    if (input.id !== undefined && existingWorkspaces.some((workspace) => workspace.id === input.id)) {
      throw new ConversationConflictError(`Workspace id already exists: ${input.id}`);
    }
    const description = input.description?.trim() || undefined;
    if (description && description.length > 1_000) {
      throw new ConversationValidationError("workspace description must be at most 1000 characters");
    }
    const timestamp = new Date().toISOString();
    return await this.storage.createWorkspace({
      id: input.id ?? createResourceId("workspace"),
      slug: input.slug,
      name: input.name.trim(),
      description,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async updateWorkspace(workspaceId: string, input: UpdateWorkspaceInput): Promise<Workspace> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!input || typeof input.actorIdentityId !== "string" || !input.actorIdentityId.trim()) {
      throw new ConversationValidationError("actorIdentityId is required");
    }
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 200) {
      throw new ConversationValidationError("workspace name must be a non-empty string up to 200 characters");
    }
    await this.assertWorkspaceAdministrator(workspaceId, input.actorIdentityId);
    const updated = await this.storage.updateWorkspace({
      ...workspace,
      name: input.name.trim(),
      updatedAt: new Date(Math.max(Date.now(), Date.parse(workspace.updatedAt) + 1)).toISOString(),
    });
    if (!updated) throw new ConversationNotFoundError(`Workspace not found: ${workspaceId}`);
    return updated;
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = await this.storage.getWorkspace(workspaceId);
    if (!workspace) throw new ConversationNotFoundError(`Workspace not found: ${workspaceId}`);
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
    if (workspace.status !== "active") throw new ConversationValidationError("Workspace is archived");
    const identity = await this.getIdentity(input.identityId);
    if (identity.status !== "active") throw new ConversationValidationError("Identity is disabled");
    if (typeof input.mentionHandle !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(input.mentionHandle)) {
      throw new ConversationValidationError("mentionHandle must be mention-safe and at most 63 characters");
    }
    if ((await this.storage.getWorkspaceMember(workspaceId, identity.id))) {
      throw new ConversationConflictError("Identity is already a Workspace member");
    }
    if ((await this.storage.listWorkspaceMembers(workspaceId)).some(
      (member) => member.mentionHandle.toLowerCase() === input.mentionHandle.toLowerCase(),
    )) {
      throw new ConversationConflictError(`Workspace mention handle already exists: ${input.mentionHandle}`);
    }
    const accessRole = input.accessRole ?? "member";
    if (!["owner", "admin", "member"].includes(accessRole)) {
      throw new ConversationValidationError("accessRole must be owner, admin, or member");
    }
    if (identity.type !== "human" && accessRole !== "member") {
      throw new ConversationValidationError("Agents and services must use member access");
    }
    const roleLabel = input.roleLabel?.trim() || undefined;
    const profileOverride = input.profileOverride?.trim() || undefined;
    if (roleLabel && roleLabel.length > 100) throw new ConversationValidationError("roleLabel is too long");
    if (profileOverride && profileOverride.length > 1_000) {
      throw new ConversationValidationError("profileOverride is too long");
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
    if (workspace.status !== "active") throw new ConversationValidationError("Workspace is archived");
    if (!input || typeof input.actorIdentityId !== "string" || !input.actorIdentityId.trim()) {
      throw new ConversationValidationError("actorIdentityId is required");
    }
    if (input.mentionHandle === undefined && input.accessRole === undefined
      && input.roleLabel === undefined && input.profileOverride === undefined
      && input.status === undefined) {
      throw new ConversationValidationError("At least one membership field must be updated");
    }
    const [identity, target, actor, members] = await Promise.all([
      this.getIdentity(identityId),
      this.storage.getWorkspaceMember(workspaceId, identityId),
      this.storage.getWorkspaceMember(workspaceId, input.actorIdentityId),
      this.storage.listWorkspaceMembers(workspaceId),
    ]);
    if (!target) throw new ConversationNotFoundError(`Workspace member not found: ${identityId}`);
    if (!actor || actor.status !== "active" || !["owner", "admin"].includes(actor.accessRole)) {
      throw new ConversationValidationError("An active Workspace owner or admin is required");
    }
    if (target.accessRole === "owner" && actor.accessRole !== "owner") {
      throw new ConversationValidationError("Only an owner may update another owner");
    }
    if (input.mentionHandle !== undefined && typeof input.mentionHandle !== "string") {
      throw new ConversationValidationError("mentionHandle must be a string");
    }
    if (input.roleLabel !== undefined && input.roleLabel !== null
      && typeof input.roleLabel !== "string") {
      throw new ConversationValidationError("roleLabel must be a string or null");
    }
    if (input.profileOverride !== undefined && input.profileOverride !== null
      && typeof input.profileOverride !== "string") {
      throw new ConversationValidationError("profileOverride must be a string or null");
    }
    const mentionHandle = input.mentionHandle === undefined
      ? target.mentionHandle
      : input.mentionHandle.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(mentionHandle)) {
      throw new ConversationValidationError("mentionHandle must be mention-safe and at most 63 characters");
    }
    if (members.some((member) => member.identityId !== identityId
      && member.mentionHandle.toLowerCase() === mentionHandle)) {
      throw new ConversationConflictError(`Workspace mention handle already exists: ${mentionHandle}`);
    }
    const accessRole = input.accessRole ?? target.accessRole;
    if (!["owner", "admin", "member"].includes(accessRole)) {
      throw new ConversationValidationError("accessRole must be owner, admin, or member");
    }
    if (accessRole !== target.accessRole && actor.accessRole !== "owner") {
      throw new ConversationValidationError("Only an owner may change access roles");
    }
    if (identity.type !== "human" && accessRole !== "member") {
      throw new ConversationValidationError("Agents and services must use member access");
    }
    const status = input.status ?? target.status;
    if (!["active", "disabled"].includes(status)) {
      throw new ConversationValidationError("status must be active or disabled");
    }
    if (target.accessRole === "owner" && (status === "disabled" || accessRole !== "owner")
      && members.filter((member) => member.status === "active" && member.accessRole === "owner").length <= 1) {
      throw new ConversationValidationError("A Workspace must retain an active owner");
    }
    const roleLabel = input.roleLabel === undefined
      ? target.roleLabel
      : input.roleLabel?.trim() || undefined;
    const profileOverride = input.profileOverride === undefined
      ? target.profileOverride
      : input.profileOverride?.trim() || undefined;
    if (roleLabel && roleLabel.length > 100) throw new ConversationValidationError("roleLabel is too long");
    if (profileOverride && profileOverride.length > 1_000) {
      throw new ConversationValidationError("profileOverride is too long");
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
        throw new ConversationValidationError("A Workspace must retain an active owner");
      }
      throw error;
    }
    if (!result) throw new ConversationConflictError("Workspace membership changed; reload and retry");
    for (const roster of result.rosters) {
      const event: ConversationEvent = {
        id: createResourceId("event"),
        type: "roster.updated",
        conversationId: roster.conversationId,
        rosterRevision: roster.rosterRevision,
        createdAt: updatedAt,
      };
      for (const listener of this.listeners.get(roster.conversationId) ?? []) listener(event);
    }
    return result.member;
  }

  async listWorkspaceConversations(workspaceId: string): Promise<ConversationMetadata[]> {
    await this.getWorkspace(workspaceId);
    return await this.storage.listWorkspaceConversations(workspaceId);
  }

  async getConversationLifecycle(conversationId: string): Promise<EffectiveConversationLifecycle> {
    await this.getConversationMetadata(conversationId);
    return this.effectiveLifecycle(await this.storage.getConversationLifecycle(conversationId));
  }

  async updateConversationLifecycle(
    conversationId: string,
    input: UpdateConversationLifecycleInput,
  ): Promise<EffectiveConversationLifecycle> {
    const conversation = await this.getConversationMetadata(conversationId);
    if (!input || !["active", "snoozed", "settled"].includes(input.state)) {
      throw new ConversationValidationError("Conversation lifecycle state must be active, snoozed, or settled");
    }
    if (typeof input.actorIdentityId !== "string" || !input.actorIdentityId.trim()) {
      throw new ConversationValidationError("actorIdentityId is required");
    }
    await this.assertWorkspaceAdministrator(conversation.workspaceId, input.actorIdentityId);
    const prior = await this.storage.getConversationLifecycle(conversationId);
    if (prior?.state === "settled" && input.state !== "active") {
      throw new ConversationValidationError("A settled Conversation must be reopened before changing lifecycle");
    }
    const now = new Date(Math.max(Date.now(), prior ? Date.parse(prior.updatedAt) + 1 : 0)).toISOString();
    let lifecycle: ConversationLifecycle;
    if (input.state === "snoozed") {
      if (typeof input.snoozedUntil !== "string" || Number.isNaN(Date.parse(input.snoozedUntil))
        || Date.parse(input.snoozedUntil) <= Date.now()) {
        throw new ConversationValidationError("snoozedUntil must be a future ISO-8601 date");
      }
      lifecycle = {
        workspaceId: conversation.workspaceId,
        conversationId,
        state: "snoozed",
        snoozedUntil: new Date(input.snoozedUntil).toISOString(),
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      };
    } else if (input.state === "settled") {
      lifecycle = {
        workspaceId: conversation.workspaceId,
        conversationId,
        state: "settled",
        settledAt: now,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      };
    } else {
      lifecycle = {
        workspaceId: conversation.workspaceId,
        conversationId,
        state: "active",
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      };
    }
    const saved = await this.storage.putConversationLifecycle(lifecycle);
    const event: ConversationEvent = {
      id: createResourceId("event"),
      type: "conversation.updated",
      conversationId,
      createdAt: saved.updatedAt,
    };
    for (const listener of this.listeners.get(conversationId) ?? []) listener(event);
    return this.effectiveLifecycle(saved);
  }

  private effectiveLifecycle(lifecycle: ConversationLifecycle | undefined): EffectiveConversationLifecycle {
    if (!lifecycle || lifecycle.state === "active") return { state: "active" };
    if (lifecycle.state === "snoozed" && Date.parse(lifecycle.snoozedUntil!) <= Date.now()) {
      return { state: "active" };
    }
    return lifecycle.state === "snoozed"
      ? { state: "snoozed", snoozedUntil: lifecycle.snoozedUntil }
      : { state: "settled", settledAt: lifecycle.settledAt };
  }

  private async assertWorkspaceAdministrator(
    workspaceId: string,
    actorIdentityId: string,
  ): Promise<void> {
    const actor = await this.storage.getWorkspaceMember(workspaceId, actorIdentityId);
    if (!actor || actor.status !== "active" || !["owner", "admin"].includes(actor.accessRole)) {
      throw new ConversationValidationError("An active Workspace owner or admin is required");
    }
  }

  private async resolveActiveParticipants(
    workspaceId: string,
    participantIds: string[],
  ): Promise<Participant[]> {
    if (participantIds.length === 0) {
      throw new ConversationValidationError("A Conversation must have at least one participant");
    }
    if (new Set(participantIds).size !== participantIds.length) {
      throw new ConversationValidationError("participantIds must be unique within a Conversation");
    }
    if (participantIds.some((identityId) => typeof identityId !== "string" || !identityId.trim())) {
      throw new ConversationValidationError("participantIds must contain non-empty identity ids");
    }
    return await Promise.all(participantIds.map(async (identityId) => {
      const [identity, member] = await Promise.all([
        this.getIdentity(identityId),
        this.storage.getWorkspaceMember(workspaceId, identityId),
      ]);
      if (identity.status !== "active" || !member || member.status !== "active") {
        throw new ConversationValidationError(`Identity is not an active Workspace member: ${identityId}`);
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

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    if (!input || (input.participantIds === undefined && input.participants === undefined)) {
      throw new ConversationValidationError("participantIds must be an array");
    }
    if (input.id !== undefined && !isResourceId(input.id, "conversation")) {
      throw new ConversationValidationError("conversation id must be a typed Conversation resource id");
    }
    if (input.participantIds !== undefined && input.participants !== undefined) {
      throw new ConversationValidationError("participantIds and legacy participants are mutually exclusive");
    }
    if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim())) {
      throw new ConversationValidationError("Conversation name must be a non-empty string");
    }
    const requestedName = input.name?.trim();
    if (requestedName && requestedName.length > 100) {
      throw new ConversationValidationError("Conversation name must be at most 100 characters");
    }
    let workspaceId = input.workspaceId;
    let participants: Participant[];
    if (input.participantIds !== undefined) {
      if (!Array.isArray(input.participantIds) || !workspaceId) {
        throw new ConversationValidationError("workspaceId and participantIds are required");
      }
      const workspace = await this.getWorkspace(workspaceId);
      if (workspace.status !== "active") throw new ConversationValidationError("Workspace is archived");
      if (input.actorIdentityId !== undefined) {
        if (typeof input.actorIdentityId !== "string" || !input.actorIdentityId.trim()) {
          throw new ConversationValidationError("actorIdentityId must be a non-empty string");
        }
        await this.assertWorkspaceAdministrator(workspaceId, input.actorIdentityId);
        if (!input.participantIds.includes(input.actorIdentityId)) {
          throw new ConversationValidationError("Conversation participants must include the acting human");
        }
      }
      participants = await this.resolveActiveParticipants(workspaceId, input.participantIds);
    } else {
      if (input.workspaceId && input.workspaceId !== LEGACY_WORKSPACE_ID) {
        throw new ConversationValidationError("legacy participants cannot be used with an explicit Workspace");
      }
      const legacy = input.participants!.map(validateParticipant);
      if (new Set(legacy.map((participant) => participant.id)).size !== legacy.length) {
        throw new ConversationValidationError("participant ids must be unique within a conversation");
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
          throw new ConversationConflictError(`Legacy participant id has another identity type: ${participant.id}`);
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
    const conversationId = input.id ?? createResourceId("conversation");
    if (input.id !== undefined && await this.storage.getConversationMetadata(input.id)) {
      throw new ConversationConflictError(`Conversation id already exists: ${input.id}`);
    }
    return await this.storage.createConversation({
      id: conversationId,
      workspaceId: workspaceId!,
      name: requestedName ?? `Conversation ${conversationId.slice("conversation_".length, "conversation_".length + 8)}`,
      participants,
      messages: [],
      rosterRevision: 1,
      createdAt: new Date().toISOString(),
    });
  }

  async updateConversation(conversationId: string, input: UpdateConversationInput): Promise<ConversationMetadata> {
    if (!input || typeof input.actorIdentityId !== "string" || !input.actorIdentityId.trim()) {
      throw new ConversationValidationError("actorIdentityId is required");
    }
    if (typeof input.name !== "string" || !input.name.trim()) {
      throw new ConversationValidationError("Conversation name must be a non-empty string");
    }
    const name = input.name.trim();
    if (name.length > 100) {
      throw new ConversationValidationError("Conversation name must be at most 100 characters");
    }
    const conversation = await this.getConversationMetadata(conversationId);
    const workspace = await this.getWorkspace(conversation.workspaceId);
    if (workspace.status !== "active") throw new ConversationValidationError("Workspace is archived");
    await this.assertWorkspaceAdministrator(conversation.workspaceId, input.actorIdentityId);
    const updated = await this.storage.updateConversationName(conversationId, name);
    if (!updated) throw new ConversationNotFoundError(`Conversation not found: ${conversationId}`);
    const event: ConversationEvent = {
      id: createResourceId("event"),
      type: "conversation.updated",
      conversationId,
      createdAt: new Date().toISOString(),
    };
    for (const listener of this.listeners.get(conversationId) ?? []) listener(event);
    return updated;
  }

  async updateConversationParticipants(
    conversationId: string,
    input: UpdateConversationParticipantsInput,
  ): Promise<ConversationMetadata> {
    if (!input || typeof input.actorIdentityId !== "string" || !input.actorIdentityId.trim()) {
      throw new ConversationValidationError("actorIdentityId is required");
    }
    if (!Array.isArray(input.participantIds)) {
      throw new ConversationValidationError("participantIds must be an array");
    }
    if (!Number.isSafeInteger(input.expectedRosterRevision) || input.expectedRosterRevision < 1) {
      throw new ConversationValidationError("expectedRosterRevision must be a positive integer");
    }
    const conversation = await this.getConversationMetadata(conversationId);
    const workspace = await this.getWorkspace(conversation.workspaceId);
    if (workspace.status !== "active") throw new ConversationValidationError("Workspace is archived");
    await this.assertWorkspaceAdministrator(conversation.workspaceId, input.actorIdentityId);
    if (!input.participantIds.includes(input.actorIdentityId)) {
      throw new ConversationValidationError("Conversation participants must include the acting human");
    }
    const participants = await this.resolveActiveParticipants(
      conversation.workspaceId,
      input.participantIds,
    );
    const updatedAt = new Date().toISOString();
    const result = await this.storage.replaceConversationParticipants(
      conversationId,
      participants,
      input.expectedRosterRevision,
      updatedAt,
    );
    if (!result) throw new ConversationConflictError("Conversation roster changed; reload and retry");
    const event: ConversationEvent = {
      id: createResourceId("event"),
      type: "roster.updated",
      conversationId,
      rosterRevision: result.conversation.rosterRevision,
      createdAt: updatedAt,
    };
    for (const listener of this.listeners.get(conversationId) ?? []) listener(event);
    return result.conversation;
  }

  async getConversation(conversationId: string): Promise<Conversation> {
    const conversation = await this.storage.getConversation(conversationId);
    if (!conversation) throw new ConversationNotFoundError(`Conversation not found: ${conversationId}`);
    return conversation;
  }

  async getConversationMetadata(conversationId: string): Promise<ConversationMetadata> {
    const conversation = await this.storage.getConversationMetadata(conversationId);
    if (!conversation) throw new ConversationNotFoundError(`Conversation not found: ${conversationId}`);
    return conversation;
  }

  async listMessages(conversationId: string, options: MessageListOptions = {}): Promise<ConversationMessage[]> {
    if (options.afterSequence !== undefined && options.beforeSequence !== undefined) {
      throw new ConversationValidationError("afterSequence and beforeSequence cannot be combined");
    }
    for (const [name, value] of Object.entries(options)) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < (name === "limit" ? 1 : 0))) {
        throw new ConversationValidationError(`${name} must be a ${name === "limit" ? "positive" : "non-negative"} integer`);
      }
    }
    if (options.limit !== undefined && options.limit > 1_000) {
      throw new ConversationValidationError("limit must not exceed 1000");
    }
    const messages = await this.storage.listMessages(conversationId, options);
    if (!messages) throw new ConversationNotFoundError(`Conversation not found: ${conversationId}`);
    return messages;
  }

  private async assertActiveWorkspaceIdentity(conversation: Conversation, identityId: string): Promise<void> {
    const [identity, member] = await Promise.all([
      this.storage.getIdentity(identityId),
      this.storage.getWorkspaceMember(conversation.workspaceId, identityId),
    ]);
    if (!identity || identity.status !== "active" || !member || member.status !== "active") {
      throw new ConversationValidationError(`Identity is not active in the Conversation Workspace: ${identityId}`);
    }
  }

  async createMessage(
    conversationId: string,
    input: CreateMessageInput,
    idempotencyKey?: string,
  ): Promise<ConversationMessage> {
    const validatedKey = validateIdempotencyKey(idempotencyKey);
    const conversation = await this.storage.getConversation(conversationId);
    if (!conversation) throw new ConversationNotFoundError(`Conversation not found: ${conversationId}`);
    if (!input || typeof input.participantId !== "string" || !input.participantId.trim()) {
      throw new ConversationValidationError("participantId must be a non-empty string");
    }
    const participantId = input.participantId.trim();
    if (!conversation.participants.some((participant) => participant.id === participantId)) {
      throw new ConversationValidationError(`Participant is not in conversation: ${participantId}`);
    }
    await this.assertActiveWorkspaceIdentity(conversation, participantId);
    if (typeof input.body !== "string" || !input.body.trim()) {
      throw new ConversationValidationError("body must be a non-empty string");
    }
    if (Buffer.byteLength(input.body, "utf8") > 64 * 1024) {
      throw new ConversationValidationError("body exceeds 64 KiB");
    }
    if (input.replyTo !== undefined && !conversation.messages.some((message) => message.id === input.replyTo)) {
      throw new ConversationValidationError(`Reply message is not in conversation: ${input.replyTo}`);
    }

    const to = messageTargets(conversation, input);
    await Promise.all(to.filter((target) => target !== "@conversation").map(
      (target) => this.assertActiveWorkspaceIdentity(conversation, target),
    ));
    const pendingMessage: NewConversationMessage = {
      id: createResourceId("message"),
      conversationId,
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
      throw new ConversationConflictError("idempotency key was already used with a different payload");
    }
    const message = result.message;
    if (result.outcome === "created") {
      const event: ConversationEvent = {
        id: createResourceId("event"),
        type: "message.created",
        conversationId,
        message: { ...message, to: [...message.to] },
        createdAt: new Date().toISOString(),
      };
      for (const listener of this.listeners.get(conversationId) ?? []) listener(event);
    }
    return { ...message, to: [...message.to] };
  }

  async createResponse(
    conversationId: string,
    input: CreateResponseInput,
  ): Promise<ResponseResult> {
    const conversation = await this.storage.getConversation(conversationId);
    if (!conversation) throw new ConversationNotFoundError(`Conversation not found: ${conversationId}`);
    if (!input || typeof input.participantId !== "string" || !input.participantId.trim()) {
      throw new ConversationValidationError("participantId must be a non-empty string");
    }
    const participant = conversation.participants.find((candidate) => candidate.id === input.participantId);
    if (!participant) {
      throw new ConversationValidationError(`Participant is not in conversation: ${input.participantId}`);
    }
    await this.assertActiveWorkspaceIdentity(conversation, participant.id);
    if (participant.type !== "agent" && participant.type !== "service") {
      throw new ConversationValidationError("responses must be authored by an agent or service");
    }
    if (typeof input.body !== "string" || !input.body.trim()) {
      throw new ConversationValidationError("body must be a non-empty string");
    }
    if (Buffer.byteLength(input.body, "utf8") > 64 * 1024) {
      throw new ConversationValidationError("body exceeds 64 KiB");
    }
    if (typeof input.triggerMessageId !== "string" || !input.triggerMessageId.trim()) {
      throw new ConversationValidationError("triggerMessageId must be a non-empty string");
    }
    if (!Number.isInteger(input.triggerSequence) || input.triggerSequence < 1) {
      throw new ConversationValidationError("triggerSequence must be a positive integer");
    }
    const trigger = conversation.messages.find((message) => message.id === input.triggerMessageId);
    if (!trigger || trigger.sequence !== input.triggerSequence) {
      throw new ConversationValidationError("trigger message and sequence do not match this conversation");
    }

    const to = messageTargets(conversation, { participantId: input.participantId, body: input.body });
    await Promise.all(to.filter((target) => target !== "@conversation").map(
      (target) => this.assertActiveWorkspaceIdentity(conversation, target),
    ));
    const result = await this.storage.commitResponse(
      {
        id: createResourceId("message"),
        conversationId,
        participantId: input.participantId,
        to,
        body: input.body,
        replyTo: trigger.id,
        createdAt: new Date().toISOString(),
      },
      trigger.sequence,
    );
    if (result.created) {
      const event: ConversationEvent = {
        id: createResourceId("event"),
        type: "message.created",
        conversationId,
        message: { ...result.message, to: [...result.message.to] },
        createdAt: new Date().toISOString(),
      };
      for (const listener of this.listeners.get(conversationId) ?? []) listener(event);
    }
    return { message: { ...result.message, to: [...result.message.to] }, created: result.created };
  }

  async subscribe(conversationId: string, listener: EventListener): Promise<() => void> {
    return this.subscribeMany([conversationId], listener);
  }

  async subscribeMany(conversationIds: readonly string[], listener: EventListener): Promise<() => void> {
    const subscriptions: Array<{ conversationId: string; conversationListeners: Set<EventListener> }> = [];
    let subscribed = true;
    const unsubscribe = () => {
      if (!subscribed) return;
      subscribed = false;
      for (const { conversationId, conversationListeners } of subscriptions) {
        conversationListeners.delete(listener);
        if (conversationListeners.size === 0) this.listeners.delete(conversationId);
      }
    };
    try {
      for (const conversationId of [...new Set(conversationIds)]) {
        if (!(await this.storage.getConversation(conversationId))) {
          throw new ConversationNotFoundError(`Conversation not found: ${conversationId}`);
        }
        const conversationListeners = this.listeners.get(conversationId) ?? new Set<EventListener>();
        conversationListeners.add(listener);
        this.listeners.set(conversationId, conversationListeners);
        subscriptions.push({ conversationId, conversationListeners });
      }
      return unsubscribe;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.storage.close?.();
  }
}
