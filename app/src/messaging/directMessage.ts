import type { WhatsAppClient } from '../whatsapp/types.js';
import type { PendingDms } from '../persistence/pendingDms.js';
import type { AllowlistConfig } from '../config/schemas.js';
import { allowlistAllows } from './allowlistGate.js';
import { retry, type RetryOpts } from './retry.js';

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
  retry: RetryOpts | (() => RetryOpts);
  maxDrainAttempts?: number;
  isPaused?: () => boolean;
}

export interface SendInput {
  phone: string;
  body: string;
  bookingId?: string;
}

export class DirectMessageSender {
  constructor(private readonly opts: DirectMessageSenderOpts) {}

  private retryOpts(): RetryOpts {
    return typeof this.opts.retry === 'function' ? this.opts.retry() : this.opts.retry;
  }

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
        this.retryOpts(),
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
          this.retryOpts(),
        );
        this.opts.pendingDms.markSent(item.id);
        stats.sent += 1;
      } catch (err) {
        this.opts.pendingDms.recordFailure(item.id, (err as Error).message);
        const limit = this.opts.maxDrainAttempts ?? 5;
        if (item.attempts + 1 >= limit) {
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
