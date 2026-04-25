import type { WhatsAppClient } from '../whatsapp/types.js';
import { retry, type RetryOpts } from './retry.js';

export interface BroadcastResult {
  sent: number;
  failed: Array<{ groupId: string; error: string }>;
}

export interface BroadcasterOpts {
  interMessageDelayMs: number;
  retry: RetryOpts;
}

export class Broadcaster {
  constructor(
    private readonly client: WhatsAppClient,
    private readonly opts: BroadcasterOpts,
  ) {}

  async send(body: string, groupIds: string[]): Promise<BroadcastResult> {
    const result: BroadcastResult = { sent: 0, failed: [] };
    for (let i = 0; i < groupIds.length; i++) {
      const id = groupIds[i]!;
      try {
        await retry(() => this.client.sendToGroup(id, body), this.opts.retry);
        result.sent += 1;
      } catch (err) {
        result.failed.push({ groupId: id, error: (err as Error).message });
      }
      if (i < groupIds.length - 1 && this.opts.interMessageDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.opts.interMessageDelayMs));
      }
    }
    return result;
  }
}
