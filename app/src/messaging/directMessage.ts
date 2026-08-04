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
  /** True while WhatsApp has restricted this account from starting new chats. */
  isNewContactRestricted?: () => boolean;
  /** Has this phone ever had a DM confirmed delivered? Used with isNewContactRestricted. */
  hasConfirmedDelivery?: (phone: string) => boolean;
  /**
   * Delay between each queued send during drainPending (default 8s). This is
   * a bulk catch-up sweep, not a live send — firing several DMs back-to-back
   * the moment a session reconnects is the exact burst pattern suspected of
   * triggering the 2026-07-20 instant-logout ban (a fresh reconnect drained
   * one queued DM within ~15s of coming online, then WhatsApp logged the
   * session out again seconds later). A gap between items, on top of the
   * humanized per-message typing delay already in sendDirect, keeps sends
   * looking sequential/human rather than an automated burst.
   */
  drainInterItemDelayMs?: number;
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
    // WhatsApp has restricted this account from starting new chats (2026-07-07
    // anti-spam flag). Established contacts keep working normally — only a
    // phone we've never successfully delivered to before gets held, so we
    // don't keep tripping the restriction. It drains automatically via
    // drainPending once the restriction is lifted (see /admin toggle).
    if (
      this.opts.isNewContactRestricted?.() &&
      !this.opts.hasConfirmedDelivery?.(input.phone)
    ) {
      const id = this.opts.pendingDms.enqueue({
        phone: input.phone,
        body: input.body,
        bookingId: input.bookingId,
      });
      return { outcome: 'deferred', queueId: id };
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
    const delayMs = this.opts.drainInterItemDelayMs ?? 8_000;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (i > 0 && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      try {
        // Single attempt, no backoff — this is a bulk catch-up sweep over a
        // (possibly multi-day) backlog, not a live send. Using the full
        // production retry policy here (up to 3 attempts x 900s backoff) lets
        // one permanently-broken number (e.g. a recipient hard-failing with
        // "No LID for user") stall every item behind it in the shared send
        // queue for hours, since sends are globally serialized. A failed item
        // just increments its attempt count and gets picked up by the next
        // drain (next reconnect or admin toggle) instead.
        await this.opts.client.sendDirect(item.phone, item.body);
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
