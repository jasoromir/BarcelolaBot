import type { Database as DB } from 'better-sqlite3';

export type ReminderStatus =
  | 'awaiting_send' // reminder queued, not yet sent (only for >=24h bookings)
  | 'awaiting_reply' // reminder/combined DM sent, waiting for client
  | 'confirmed'
  | 'cancelled'
  | 'no_reply' // tour time passed without response
  | 'skipped_undelivered_welcome'; // welcome DM confirmed NOT delivered — reminder deliberately not sent

export interface ReminderRow {
  bookingId: string;
  /** eCommerce order ID from Wix — used to look up deposit/balance at reminder send time. */
  orderIdEcom: string | null;
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
  /** null = not yet checked, true = welcome DM confirmed delivered (ack>=2), false = confirmed NOT delivered. */
  welcomeDelivered: boolean | null;
  createdAt: string;
  updatedAt: string;
}

interface DBRow {
  booking_id: string;
  order_id_ecom: string | null;
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
  welcome_delivered: number | null;
  created_at: string;
  updated_at: string;
}

function rowToReminder(r: DBRow): ReminderRow {
  return {
    bookingId: r.booking_id,
    orderIdEcom: r.order_id_ecom,
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
    welcomeDelivered: r.welcome_delivered === null ? null : r.welcome_delivered === 1,
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
         (booking_id, order_id_ecom, phone, client_name, tour_id, tour_name_he, start_at_iso,
          participant_count, status, send_at_iso, sent_at_iso, last_reply_ts,
          created_at, updated_at)
         VALUES (@booking_id, @order_id_ecom, @phone, @client_name, @tour_id, @tour_name_he, @start_at_iso,
                 @participant_count, @status, @send_at_iso, @sent_at_iso, @last_reply_ts,
                 @now, @now)
         ON CONFLICT(booking_id) DO UPDATE SET
           order_id_ecom = excluded.order_id_ecom,
           phone = excluded.phone,
           client_name = excluded.client_name,
           tour_id = excluded.tour_id,
           tour_name_he = excluded.tour_name_he,
           start_at_iso = excluded.start_at_iso,
           participant_count = excluded.participant_count,
           status = excluded.status,
           send_at_iso = excluded.send_at_iso,
           sent_at_iso = excluded.sent_at_iso,
           updated_at = @now`,
      )
      .run({
        booking_id: r.bookingId,
        order_id_ecom: r.orderIdEcom,
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
    // Any reminder whose tour hasn't started yet. We keep listening even
    // after confirm/cancel so customers can change their mind or ask
    // follow-up questions.
    //
    // When a phone has multiple active future reminders (e.g. one confirmed
    // yesterday + a brand new booking today), prefer the one that's still
    // waiting for a reply, then prefer the most recently created. This
    // prevents a stale 'confirmed' row from hijacking a reply that was
    // obviously meant for the fresh booking.
    //
    // The status ranking uses a CASE expression to put awaiting_reply first,
    // then awaiting_send, then confirmed, then cancelled.
    const row = this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE phone = ?
           AND start_at_iso > ?
         ORDER BY
           CASE status
             WHEN 'awaiting_reply' THEN 0
             WHEN 'awaiting_send' THEN 1
             WHEN 'confirmed' THEN 2
             WHEN 'cancelled' THEN 3
             ELSE 4
           END ASC,
           created_at DESC
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

  /** Record whether the welcome/confirmation DM for this booking was confirmed delivered (ack>=2). */
  setWelcomeDelivered(bookingId: string, delivered: boolean): void {
    this.db
      .prepare(
        `UPDATE reminders
         SET welcome_delivered = ?, updated_at = ?
         WHERE booking_id = ?`,
      )
      .run(delivered ? 1 : 0, new Date().toISOString(), bookingId);
  }

  /**
   * Has this phone number ever had a DM confirmed delivered (any booking)?
   * Used to gate first-contact sends while the linked-device account is under
   * a WhatsApp anti-spam "new chat" restriction — established contacts are
   * unaffected, only brand-new numbers trip the restriction.
   */
  hasConfirmedDelivery(phone: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM reminders WHERE phone = ? AND welcome_delivered = 1 LIMIT 1`)
      .get(phone);
    return row !== undefined;
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

  forDate(dateIso: string): ReminderRow[] {
    // All reminders whose tour falls on dateIso (YYYY-MM-DD), any status.
    // start_at_iso is stored as UTC ISO; a full-day UTC range covers all tours
    // whose local date is dateIso (tours are in Europe/Madrid = UTC+1/+2, so
    // they all fall well within the UTC day boundary).
    const rows = this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE start_at_iso >= ? AND start_at_iso < ?
         ORDER BY start_at_iso ASC, client_name ASC`,
      )
      .all(`${dateIso}T00:00:00.000Z`, `${dateIso}T23:59:59.999Z`) as DBRow[];
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
