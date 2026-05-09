import type { Database as DB } from 'better-sqlite3';

export type ReminderStatus =
  | 'awaiting_send' // reminder queued, not yet sent (only for >=24h bookings)
  | 'awaiting_reply' // reminder/combined DM sent, waiting for client
  | 'confirmed'
  | 'cancelled'
  | 'no_reply'; // tour time passed without response

export interface ReminderRow {
  bookingId: string;
  phone: string;
  clientName: string | null;
  tourId: string | null;
  tourNameHe: string | null;
  startAtIso: string;
  participantCount: number;
  status: ReminderStatus;
  sendAtIso: string | null;
  sentAtIso: string | null;
  lastReplyTs: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DBRow {
  booking_id: string;
  phone: string;
  client_name: string | null;
  tour_id: string | null;
  tour_name_he: string | null;
  start_at_iso: string;
  participant_count: number;
  status: ReminderStatus;
  send_at_iso: string | null;
  sent_at_iso: string | null;
  last_reply_ts: string | null;
  created_at: string;
  updated_at: string;
}

function rowToReminder(r: DBRow): ReminderRow {
  return {
    bookingId: r.booking_id,
    phone: r.phone,
    clientName: r.client_name,
    tourId: r.tour_id,
    tourNameHe: r.tour_name_he,
    startAtIso: r.start_at_iso,
    participantCount: r.participant_count,
    status: r.status,
    sendAtIso: r.send_at_iso,
    sentAtIso: r.sent_at_iso,
    lastReplyTs: r.last_reply_ts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class RemindersStore {
  constructor(private db: DB) {}

  upsert(r: Omit<ReminderRow, 'createdAt' | 'updatedAt'>): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO reminders
         (booking_id, phone, client_name, tour_id, tour_name_he, start_at_iso,
          participant_count, status, send_at_iso, sent_at_iso, last_reply_ts,
          created_at, updated_at)
         VALUES (@booking_id, @phone, @client_name, @tour_id, @tour_name_he, @start_at_iso,
                 @participant_count, @status, @send_at_iso, @sent_at_iso, @last_reply_ts,
                 @now, @now)
         ON CONFLICT(booking_id) DO UPDATE SET
           phone = excluded.phone,
           client_name = excluded.client_name,
           tour_id = excluded.tour_id,
           tour_name_he = excluded.tour_name_he,
           start_at_iso = excluded.start_at_iso,
           participant_count = excluded.participant_count,
           status = excluded.status,
           send_at_iso = excluded.send_at_iso,
           updated_at = @now`,
      )
      .run({
        booking_id: r.bookingId,
        phone: r.phone,
        client_name: r.clientName,
        tour_id: r.tourId,
        tour_name_he: r.tourNameHe,
        start_at_iso: r.startAtIso,
        participant_count: r.participantCount,
        status: r.status,
        send_at_iso: r.sendAtIso,
        sent_at_iso: r.sentAtIso,
        last_reply_ts: r.lastReplyTs,
        now,
      });
  }

  get(bookingId: string): ReminderRow | null {
    const row = this.db
      .prepare('SELECT * FROM reminders WHERE booking_id = ?')
      .get(bookingId) as DBRow | undefined;
    return row ? rowToReminder(row) : null;
  }

  findByPhone(phone: string): ReminderRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE phone = ?
         ORDER BY start_at_iso ASC`,
      )
      .all(phone) as DBRow[];
    return rows.map(rowToReminder);
  }

  findActiveForReply(phone: string, nowIso: string): ReminderRow | null {
    // The most recent reminder whose tour hasn't started yet, that's in a state
    // where a reply would still be meaningful.
    const row = this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE phone = ?
           AND start_at_iso > ?
           AND status IN ('awaiting_send', 'awaiting_reply', 'confirmed')
         ORDER BY start_at_iso ASC
         LIMIT 1`,
      )
      .get(phone, nowIso) as DBRow | undefined;
    return row ? rowToReminder(row) : null;
  }

  due(nowIso: string): ReminderRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE status = 'awaiting_send'
           AND sent_at_iso IS NULL
           AND send_at_iso IS NOT NULL
           AND send_at_iso <= ?`,
      )
      .all(nowIso) as DBRow[];
    return rows.map(rowToReminder);
  }

  markSent(bookingId: string, nowIso: string): void {
    this.db
      .prepare(
        `UPDATE reminders
         SET sent_at_iso = ?, status = 'awaiting_reply', updated_at = ?
         WHERE booking_id = ?`,
      )
      .run(nowIso, nowIso, bookingId);
  }

  setStatus(
    bookingId: string,
    status: ReminderStatus,
    opts?: { participantCount?: number; lastReplyTs?: string },
  ): void {
    const now = new Date().toISOString();
    if (opts?.participantCount !== undefined) {
      this.db
        .prepare(
          `UPDATE reminders
           SET status = ?, participant_count = ?, last_reply_ts = ?, updated_at = ?
           WHERE booking_id = ?`,
        )
        .run(status, opts.participantCount, opts.lastReplyTs ?? now, now, bookingId);
    } else {
      this.db
        .prepare(
          `UPDATE reminders
           SET status = ?, last_reply_ts = ?, updated_at = ?
           WHERE booking_id = ?`,
        )
        .run(status, opts?.lastReplyTs ?? now, now, bookingId);
    }
  }

  pendingNoReply(fromIso: string, toIso: string): ReminderRow[] {
    // Reminders whose tour is starting in [fromIso, toIso] and still awaiting reply.
    const rows = this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE status = 'awaiting_reply'
           AND start_at_iso >= ?
           AND start_at_iso <= ?`,
      )
      .all(fromIso, toIso) as DBRow[];
    return rows.map(rowToReminder);
  }
}

export interface ReplyAuditRow {
  ts: string;
  phone: string;
  bookingId: string | null;
  rawText: string;
  intent: string | null;
  participantCount: number | null;
  confidence: number | null;
  forwarded: boolean;
  notes: string | null;
}

export class ReplyAuditStore {
  constructor(private db: DB) {}

  record(r: ReplyAuditRow): void {
    this.db
      .prepare(
        `INSERT INTO reply_audit
         (ts, phone, booking_id, raw_text, intent, participant_count, confidence, forwarded, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.ts,
        r.phone,
        r.bookingId,
        r.rawText,
        r.intent,
        r.participantCount,
        r.confidence,
        r.forwarded ? 1 : 0,
        r.notes,
      );
  }
}
