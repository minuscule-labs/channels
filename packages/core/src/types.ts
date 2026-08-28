export type ParticipantType = "human" | "agent" | "service";

export interface Participant {
  id: string;
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
  participants: Participant[];
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
