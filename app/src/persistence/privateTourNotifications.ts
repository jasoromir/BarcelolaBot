import type { Database as DB } from 'better-sqlite3';

export type PrivateTourNotifyStatus = 'sent' | 'skipped_no_recipients' | 'failed';

export interface PrivateTourNotificationRow {
  eventId: string;
  guideName: string | null;
  guidePhones: string[];
  managerPhone: string | null;
  recipients: string[];
  tourName: string | null;
  startAtIso: string;
  missingFields: string[];
  sentAt: string;
  status: PrivateTourNotifyStatus;
}

/**
 * Dedup store for the private-tour day-before notify runner. A row exists
 * once we've attempted to notify about a given calendar event, so the poller
 * never sends the same reminder twice.
 */
export class PrivateTourNotificationsStore {
  constructor(private readonly db: DB) {}

  wasHandled(eventId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM private_tour_notifications WHERE event_id = ?').get(eventId);
    return Boolean(row);
  }

  record(r: PrivateTourNotificationRow): void {
    this.db
      .prepare(
        `INSERT INTO private_tour_notifications
           (event_id, guide_name, guide_phones, manager_phone, recipients, tour_name, start_at_iso, missing_fields, sent_at, status)
         VALUES (@event_id, @guide_name, @guide_phones, @manager_phone, @recipients, @tour_name, @start_at_iso, @missing_fields, @sent_at, @status)
         ON CONFLICT(event_id) DO UPDATE SET
           guide_name = excluded.guide_name,
           guide_phones = excluded.guide_phones,
           manager_phone = excluded.manager_phone,
           recipients = excluded.recipients,
           tour_name = excluded.tour_name,
           start_at_iso = excluded.start_at_iso,
           missing_fields = excluded.missing_fields,
           sent_at = excluded.sent_at,
           status = excluded.status`,
      )
      .run({
        event_id: r.eventId,
        guide_name: r.guideName,
        guide_phones: JSON.stringify(r.guidePhones),
        manager_phone: r.managerPhone,
        recipients: JSON.stringify(r.recipients),
        tour_name: r.tourName,
        start_at_iso: r.startAtIso,
        missing_fields: JSON.stringify(r.missingFields),
        sent_at: r.sentAt,
        status: r.status,
      });
  }
}
