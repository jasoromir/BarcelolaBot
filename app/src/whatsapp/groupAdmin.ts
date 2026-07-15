import type { WhatsAppClient } from './types.js';

export interface VerifyResult {
  admin: string[];
  notAdmin: string[];
}

export interface BulkActionResult {
  ok: string[];
  failed: Array<{ groupId: string; error: string }>;
}

export class GroupAdminService {
  constructor(private readonly client: WhatsAppClient) {}

  async verifyAdminAll(groupIds: string[]): Promise<VerifyResult> {
    const admin: string[] = [];
    const notAdmin: string[] = [];
    for (const id of groupIds) {
      try {
        if (await this.client.isGroupAdmin(id)) admin.push(id);
        else notAdmin.push(id);
      } catch (err) {
        console.error(`[groupAdmin] isGroupAdmin(${id}) threw:`, (err as Error)?.message ?? err);
        notAdmin.push(id);
      }
    }
    return { admin, notAdmin };
  }

  async closeAll(groupIds: string[]): Promise<BulkActionResult> {
    const result: BulkActionResult = { ok: [], failed: [] };
    for (const id of groupIds) {
      try {
        await this.client.setGroupMessagesAdminsOnly(id, true);
        result.ok.push(id);
      } catch (err) {
        result.failed.push({ groupId: id, error: (err as Error).message });
      }
    }
    return result;
  }

  async openAll(groupIds: string[]): Promise<BulkActionResult> {
    const result: BulkActionResult = { ok: [], failed: [] };
    for (const id of groupIds) {
      try {
        await this.client.setGroupMessagesAdminsOnly(id, false);
        result.ok.push(id);
      } catch (err) {
        result.failed.push({ groupId: id, error: (err as Error).message });
      }
    }
    return result;
  }
}
