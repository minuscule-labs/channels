export type IdentityType = "human" | "agent" | "service";
export type ParticipantType = IdentityType;
export type IdentityStatus = "active" | "disabled";
export type WorkspaceStatus = "active" | "archived";
export type WorkspaceAccessRole = "owner" | "admin" | "member";
export type WorkspaceMemberStatus = "active" | "disabled";

export interface Identity {
  id: string;
  type: IdentityType;
  displayName?: string;
  publicProfile?: string;
  status: IdentityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIdentityInput {
  /** Caller-stable id used by recoverable local provisioning. */
  id?: string;
  type: IdentityType;
  displayName?: string;
  publicProfile?: string;
}

export interface UpdateIdentityInput {
  /** Workspace used to authorize this global identity update. */
  workspaceId: string;
  /** Advisory product policy until requests are authenticated. */
  actorIdentityId: string;
  displayName: string;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  description?: string;
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceInput {
  /** Caller-stable id used by recoverable local provisioning. */
  id?: string;
  slug: string;
  name: string;
  description?: string;
}

export interface UpdateWorkspaceInput {
  /** Advisory product policy until requests are authenticated. */
  actorIdentityId: string;
  name: string;
}

export interface WorkspaceMember {
  workspaceId: string;
  identityId: string;
  mentionHandle: string;
  accessRole: WorkspaceAccessRole;
  roleLabel?: string;
  profileOverride?: string;
  status: WorkspaceMemberStatus;
  joinedAt: string;
  updatedAt: string;
}

export interface AddWorkspaceMemberInput {
  identityId: string;
  mentionHandle: string;
  accessRole?: WorkspaceAccessRole;
  roleLabel?: string;
  profileOverride?: string;
}

export interface UpdateWorkspaceMemberInput {
  /** Advisory until requests are authenticated. */
  actorIdentityId: string;
  mentionHandle?: string;
  accessRole?: WorkspaceAccessRole;
  roleLabel?: string | null;
  profileOverride?: string | null;
  status?: WorkspaceMemberStatus;
}

export interface Participant {
  /** Stable identity id used for authorship and structured routing. */
  id: string;
  /** Workspace-local mention alias. */
  handle?: string;
  type: ParticipantType;
  displayName?: string;
  /** Short public responsibility label used for routing and delegation. */
  role?: string;
  /** Public delegation guidance. This is not the agent's private system prompt. */
  profile?: string;
  status?: WorkspaceMemberStatus;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  sequence: number;
  participantId: string;
  to: string[];
  body: string;
  replyTo?: string;
  createdAt: string;
}

export type ConversationLifecycleState = "active" | "snoozed" | "settled";

/** Channel-owned lifecycle state. Absence of a stored record means Active. */
export interface ConversationLifecycle {
  workspaceId: string;
  conversationId: string;
  state: ConversationLifecycleState;
  snoozedUntil?: string;
  settledAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Lifecycle after evaluating an expired snooze at read time. */
export interface EffectiveConversationLifecycle {
  state: ConversationLifecycleState;
  snoozedUntil?: string;
  settledAt?: string;
}

export interface UpdateConversationLifecycleInput {
  actorIdentityId: string;
  state: ConversationLifecycleState;
  snoozedUntil?: string;
}

export function assertConversationLifecycle(lifecycle: ConversationLifecycle): void {
  if (!lifecycle.workspaceId || !lifecycle.conversationId) {
    throw new Error("Conversation lifecycle requires Workspace and Conversation ids");
  }
  const hasSnooze = lifecycle.snoozedUntil !== undefined;
  const hasSettled = lifecycle.settledAt !== undefined;
  if (
    (lifecycle.state === "active" && (hasSnooze || hasSettled))
    || (lifecycle.state === "snoozed" && (!hasSnooze || hasSettled))
    || (lifecycle.state === "settled" && (hasSnooze || !hasSettled))
  ) {
    throw new Error("Conversation lifecycle state has incompatible timestamps");
  }
  for (const timestamp of [lifecycle.snoozedUntil, lifecycle.settledAt, lifecycle.createdAt, lifecycle.updatedAt]) {
    if (timestamp !== undefined && Number.isNaN(Date.parse(timestamp))) {
      throw new Error("Conversation lifecycle timestamps must be ISO-8601 dates");
    }
  }
}

export interface ConversationMetadata {
  id: string;
  workspaceId: string;
  name: string;
  participants: Participant[];
  rosterRevision: number;
  createdAt: string;
}

export interface Conversation extends ConversationMetadata {
  messages: ConversationMessage[];
}

export interface MessageCreatedEvent {
  id: string;
  type: "message.created";
  conversationId: string;
  message: ConversationMessage;
  createdAt: string;
}

export interface RosterUpdatedEvent {
  id: string;
  type: "roster.updated";
  conversationId: string;
  rosterRevision: number;
  createdAt: string;
}

export interface ConversationUpdatedEvent {
  id: string;
  type: "conversation.updated";
  conversationId: string;
  createdAt: string;
}

export type ConversationEvent = MessageCreatedEvent | RosterUpdatedEvent | ConversationUpdatedEvent;

export interface CreateConversationInput {
  /** Caller-stable id used by recoverable local provisioning. */
  id?: string;
  workspaceId?: string;
  name?: string;
  participantIds?: string[];
  /** Advisory product policy until requests are authenticated. */
  actorIdentityId?: string;
  /** @deprecated Compatibility path for pre-Workspace callers. */
  participants?: Participant[];
}

export interface UpdateConversationInput {
  /** Advisory product policy until requests are authenticated. */
  actorIdentityId: string;
  name: string;
}

export interface UpdateConversationParticipantsInput {
  /** Advisory product policy until requests are authenticated. */
  actorIdentityId: string;
  participantIds: string[];
  expectedRosterRevision: number;
}

export interface CreateMessageInput {
  participantId: string;
  to?: string[];
  body: string;
  replyTo?: string;
}

export interface CreateResponseInput {
  participantId: string;
  body: string;
  triggerMessageId: string;
  triggerSequence: number;
}

export interface ResponseResult {
  message: ConversationMessage;
  created: boolean;
}

export interface ConversationCursorStore {
  getCursor(conversationId: string, participantId: string): Promise<number>;
  setCursor(conversationId: string, participantId: string, sequence: number): Promise<void>;
}
