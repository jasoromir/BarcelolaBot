import type { Database as DB } from 'better-sqlite3';

export type GuideNotifyStatus = 'sent' | 'skipped_no_phone' | 'failed';

export interface GuideNotificationRow {
  tourKey: string;
  guideName: string | null;
  guidePhone: string | null;
  tourTitle: string | null;
  startAtIso: string;
  attendeeCount: number;
  sentAt: string;
  messageId: string | null;
  status: GuideNotifyStatus;
}

/**
 * Dedup store for the guide pre-tour roster job. A row exists once we've
 * attempted to notify the guide for a given tour occurrence, so the poller
 * never sends the same roster twice. We record skips/failures too (as their
 * own status) so a missing-phone tour doesn't get retried every poll tick.
 */
export class GuideNotificationsStore {
  constructor(private readonly db: DB) {}

  wasHandled(tourKey: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM guide_notifications WHERE tour_key = ?')
      .get(tourKey);
    return Boolean(row);
  }

  record(r: GuideNotificationRow): void {
    this.db
      .prepare(
        `INSERT INTO guide_notifications
           (tour_key, guide_name, guide_phone, tour_title, start_at_iso,
            attendee_count, sent_at, message_id, status)
         VALUES (@tour_key, @guide_name, @guide_phone, @tour_title, @start_at_iso,
                 @attendee_count, @sent_at, @message_id, @status)
         ON CONFLICT(tour_key) DO UPDATE SET
           guide_name = excluded.guide_name,
           guide_phone = excluded.guide_phone,
           tour_title = excluded.tour_title,
           start_at_iso = excluded.start_at_iso,
           attendee_count = excluded.attendee_count,
           sent_at = excluded.sent_at,
           message_id = excluded.message_id,
           status = excluded.status`,
      )
      .run({
        tour_key: r.tourKey,
        guide_name: r.guideName,
        guide_phone: r.guidePhone,
        tour_title: r.tourTitle,
        start_at_iso: r.startAtIso,
        attendee_count: r.attendeeCount,
        sent_at: r.sentAt,
        message_id: r.messageId,
        status: r.status,
      });
  }
}
