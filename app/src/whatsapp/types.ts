import type { WhatsAppState } from '../types.js';

export interface SendResult {
  messageId: string;
}

export interface WhatsAppClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  state(): WhatsAppState;
  onStateChange(cb: (s: WhatsAppState) => void): void;

  sendToGroup(groupId: string, body: string): Promise<SendResult>;
  sendDirect(phoneE164: string, body: string): Promise<SendResult>;

  isGroupAdmin(groupId: string): Promise<boolean>;
  setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void>;
}
