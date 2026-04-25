import type { WhatsAppClient } from './types.js';

export interface VerifyResult {
  admin: string[];
  notAdmin: string[];
}

export class GroupAdminService {
  constructor(private readonly client: WhatsAppClient) {}

  async verifyAdminAll(groupIds: string[]): Promise<VerifyResult> {
    const admin: string[] = [];
    const notAdmin: string[] = [];
    for (const id of groupIds) {
      if (await this.client.isGroupAdmin(id)) admin.push(id);
      else notAdmin.push(id);
    }
    return { admin, notAdmin };
  }

  async closeAll(groupIds: string[]): Promise<void> {
    for (const id of groupIds) {
      await this.client.setGroupMessagesAdminsOnly(id, true);
    }
  }

  async openAll(groupIds: string[]): Promise<void> {
    for (const id of groupIds) {
      await this.client.setGroupMessagesAdminsOnly(id, false);
    }
  }
}
