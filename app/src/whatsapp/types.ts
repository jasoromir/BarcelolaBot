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

export interface WhatsAppClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  state(): WhatsAppState;
  onStateChange(cb: (s: WhatsAppState) => void): void;

  sendToGroup(groupId: string, body: string): Promise<SendResult>;
  sendDirect(phoneE164: string, body: string): Promise<SendResult>;

  isGroupAdmin(groupId: string): Promise<boolean>;
  setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void>;

  listChats(): Promise<ChatInfo[]>;
  getMessages(chatId: string, limit: number): Promise<MessageInfo[]>;
  forwardMessage(messageId: string, toChatId: string): Promise<SendResult>;
  sendSticker(toChatId: string, messageId: string): Promise<SendResult>;

  onIncomingDm(handler: IncomingDmHandler): void;
  onReaction(handler: ReactionHandler): void;

  sendStickerFromDataUrl(toChatId: string, dataUrl: string): Promise<SendResult>;
  downloadStickerBytes(messageId: string): Promise<{ data: string; mimetype: string } | null>;
}
