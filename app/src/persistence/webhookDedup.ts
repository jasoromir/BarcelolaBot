import type { Database as DB } from 'better-sqlite3';

export type WebhookOutcome =
  | 'sent'
  | 'skipped_allowlist'
  | 'skipped_paused'
  | 'deferred'
  | 'failed';

export class WebhookDedup {
  constructor(private readonly db: DB) {}

  tryClaim(bookingId: string): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_webhooks (booking_id, received_at)
         VALUES (?, ?)`,
      )
      .run(bookingId, new Date().toISOString());
    return info.changes === 1;
  }

  complete(bookingId: string, outcome: WebhookOutcome): void {
    this.db
      .prepare(
        `UPDATE processed_webhooks SET completed_at = ?, outcome = ? WHERE booking_id = ?`,
      )
      .run(new Date().toISOString(), outcome, bookingId);
  }
}
