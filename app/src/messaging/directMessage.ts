import type { WhatsAppClient } from '../whatsapp/types';
import type { PendingDms } from '../persistence/pendingDms';
import type { AllowlistConfig } from '../config/schemas';
import { allowlistAllows } from './allowlistGate';
import { retry, type RetryOpts } from './retry';

export type DmOutcome =
  | { outcome: 'sent'; messageId: string }
  | { outcome: 'skipped_allowlist' }
  | { outcome: 'skipped_paused' }
  | { outcome: 'deferred'; queueId: number }
  | { outcome: 'failed'; error: string };

export interface DirectMessageSenderOpts {
  client: WhatsAppClient;
  pendingDms: PendingDms;
  allowlist: () => AllowlistConfig;
  retry: RetryOpts;
  isPaused?: () => boolean;
}

export interface SendInput {
  phone: string;
  body: string;
  bookingId?: string;
}

export class DirectMessageSender {
  constructor(private readonly opts: DirectMessageSenderOpts) {}

  async send(input: SendInput): Promise<DmOutcome> {
    if (this.opts.isPaused?.()) {
      return { outcome: 'skipped_paused' };
    }
    if (!allowlistAllows(this.opts.allowlist(), input.phone)) {
      return { outcome: 'skipped_allowlist' };
    }
    const state = this.opts.client.state();
    if (state.kind !== 'connected') {
      const id = this.opts.pendingDms.enqueue({
        phone: input.phone,
        body: input.body,
        bookingId: input.bookingId,
      });
      return { outcome: 'deferred', queueId: id };
    }
    try {
      const r = await retry(
        () => this.opts.client.sendDirect(input.phone, input.body),
        this.opts.retry,
      );
      return { outcome: 'sent', messageId: r.messageId };
    } catch (err) {
      return { outcome: 'failed', error: (err as Error).message };
    }
  }

  async drainPending(): Promise<{ sent: number; failed: number; abandoned: number }> {
    const stats = { sent: 0, failed: 0, abandoned: 0 };
    const items = this.opts.pendingDms.pending();
    for (const item of items) {
      try {
        await retry(
          () => this.opts.client.sendDirect(item.phone, item.body),
          this.opts.retry,
        );
        this.opts.pendingDms.markSent(item.id);
        stats.sent += 1;
      } catch (err) {
        this.opts.pendingDms.recordFailure(item.id, (err as Error).message);
        if (item.attempts + 1 >= this.opts.retry.attempts * 3) {
          this.opts.pendingDms.markAbandoned(item.id);
          stats.abandoned += 1;
        } else {
          stats.failed += 1;
        }
      }
    }
    return stats;
  }
}
