import type { WhatsAppState } from '../types.js';

export interface SendResult {
  messageId: string;
}

export interface ChatInfo {
  id: string;
  name: string;
  isGroup: boolean;
  isAdmin?: boolean;
}

export interface MessageInfo {
  id: string;
  body: string;
  type: string;
  timestamp: number;
  hasMedia: boolean;
}

export interface IncomingDm {
  messageId: string;
  fromPhoneE164: string;
  body: string;
  timestamp: number;
}

export type IncomingDmHandler = (dm: IncomingDm) => void | Promise<void>;

export interface ReactionEvent {
  /** Serialized id of the message that was reacted to. */
  targetMessageId: string;
  /** Emoji the user reacted with. Empty string on reaction removal. */
  reaction: string;
  /** The chat/group the reacted-to message lives in. */
  chatId: string;
  timestamp: number;
}

export type ReactionHandler = (ev: ReactionEvent) => void | Promise<void>;

export interface GroupMessage {
  /** Serialized id of the message, usable with delete/forward APIs. */
  messageId: string;
  /** Group chat id (ends in @g.us). */
  groupId: string;
  /** Serialized id of the sender (the participant within the group). */
  authorId: string;
  body: string;
  type: string;
  timestamp: number;
  hasMedia: boolean;
}

export type GroupMessageHandler = (msg: GroupMessage) => void | Promise<void>;

export interface GroupJoinEvent {
  groupId: string;
  /** Serialized ids of the participants that joined. */
  participantIds: string[];
  timestamp: number;
}

export type GroupJoinHandler = (ev: GroupJoinEvent) => void | Promise<void>;

export interface WhatsAppClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  state(): WhatsAppState;
  onStateChange(cb: (s: WhatsAppState) => void): void;

  sendToGroup(groupId: string, body: string): Promise<SendResult>;
  sendDirect(phoneE164: string, body: string): Promise<SendResult>;

  isGroupAdmin(groupId: string): Promise<boolean>;
  setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void>;

  /** Serialized ids of the group's admins. Used to never moderate an admin. */
  getGroupAdmins(groupId: string): Promise<string[]>;
  /** Delete a message for everyone (requires admin for others' messages). */
  deleteMessageForEveryone(messageId: string): Promise<void>;
  /** Remove a participant from a group (requires admin). */
  removeParticipant(groupId: string, participantId: string): Promise<void>;
  /** Best-effort E.164 phone for a participant id, or null if unresolvable (e.g. @lid). */
  resolveParticipantPhone(participantId: string): Promise<string | null>;

  listChats(): Promise<ChatInfo[]>;
  getMessages(chatId: string, limit: number): Promise<MessageInfo[]>;
  forwardMessage(messageId: string, toChatId: string): Promise<SendResult>;
  sendSticker(toChatId: string, messageId: string): Promise<SendResult>;

  onIncomingDm(handler: IncomingDmHandler): void;
  onReaction(handler: ReactionHandler): void;
  onGroupMessage(handler: GroupMessageHandler): void;
  onGroupJoin(handler: GroupJoinHandler): void;

  sendStickerFromDataUrl(toChatId: string, dataUrl: string): Promise<SendResult>;
  downloadStickerBytes(messageId: string): Promise<{ data: string; mimetype: string } | null>;
  debugLinkPreview(url: string): Promise<unknown>;
}
