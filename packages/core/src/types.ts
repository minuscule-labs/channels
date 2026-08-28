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
  type: IdentityType;
  displayName?: string;
  publicProfile?: string;
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
  slug: string;
  name: string;
  description?: string;
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
  participants: Participant[];
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

export type ChannelEvent = MessageCreatedEvent;

export interface CreateChannelInput {
  workspaceId?: string;
  participantIds?: string[];
  /** @deprecated Compatibility path for pre-Workspace callers. */
  participants?: Participant[];
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
