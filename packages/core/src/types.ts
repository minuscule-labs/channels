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

export interface ChannelMessage {
  id: string;
  channelId: string;
  sequence: number;
  participantId: string;
  to: string[];
  body: string;
  replyTo?: string;
  createdAt: string;
}

export interface ChannelMetadata {
  id: string;
  workspaceId: string;
  name: string;
  participants: Participant[];
  rosterRevision: number;
  createdAt: string;
}

export interface Channel extends ChannelMetadata {
  messages: ChannelMessage[];
}

export interface MessageCreatedEvent {
  id: string;
  type: "message.created";
  channelId: string;
  message: ChannelMessage;
  createdAt: string;
}

export interface RosterUpdatedEvent {
  id: string;
  type: "roster.updated";
  channelId: string;
  rosterRevision: number;
  createdAt: string;
}

export interface ChannelUpdatedEvent {
  id: string;
  type: "channel.updated";
  channelId: string;
  createdAt: string;
}

export type ChannelEvent = MessageCreatedEvent | RosterUpdatedEvent | ChannelUpdatedEvent;

export interface CreateChannelInput {
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

export interface UpdateChannelInput {
  /** Advisory product policy until requests are authenticated. */
  actorIdentityId: string;
  name: string;
}

export interface UpdateChannelParticipantsInput {
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
  message: ChannelMessage;
  created: boolean;
}

export interface ChannelCursorStore {
  getCursor(channelId: string, participantId: string): Promise<number>;
  setCursor(channelId: string, participantId: string, sequence: number): Promise<void>;
}
