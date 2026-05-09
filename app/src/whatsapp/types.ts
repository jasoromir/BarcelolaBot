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
}
