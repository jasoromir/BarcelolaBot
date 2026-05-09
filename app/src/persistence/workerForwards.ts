import type { Database as DB } from 'better-sqlite3';

export type WorkerForwardStatus = 'pending' | 'sent' | 'expired';

export interface WorkerForwardRow {
  groupMessageId: string;
  bookingId: string;
  phone: string;
  clientName: string | null;
  customerMessage: string;
  suggestedReply: string | null;
  status: WorkerForwardStatus;
  createdAt: string;
  sentAt: string | null;
}

interface DBRow {
  group_message_id: string;
  booking_id: string;
  phone: string;
  client_name: string | null;
  customer_message: string;
  suggested_reply: string | null;
  status: WorkerForwardStatus;
  created_at: string;
  sent_at: string | null;
}

function row(r: DBRow): WorkerForwardRow {
  return {
    groupMessageId: r.group_message_id,
    bookingId: r.booking_id,
    phone: r.phone,
    clientName: r.client_name,
    customerMessage: r.customer_message,
    suggestedReply: r.suggested_reply,
    status: r.status,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

export class WorkerForwardsStore {
  constructor(private db: DB) {}

  insert(r: Omit<WorkerForwardRow, 'createdAt' | 'sentAt' | 'status'> & {
    status?: WorkerForwardStatus;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO worker_forwards
         (group_message_id, booking_id, phone, client_name, customer_message,
          suggested_reply, status, created_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        r.groupMessageId,
        r.bookingId,
        r.phone,
        r.clientName,
        r.customerMessage,
        r.suggestedReply,
        r.status ?? 'pending',
        now,
      );
  }

  get(groupMessageId: string): WorkerForwardRow | null {
    const found = this.db
      .prepare('SELECT * FROM worker_forwards WHERE group_message_id = ?')
      .get(groupMessageId) as DBRow | undefined;
    return found ? row(found) : null;
  }

  markSent(groupMessageId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE worker_forwards SET status = 'sent', sent_at = ? WHERE group_message_id = ?`,
      )
      .run(now, groupMessageId);
  }
}
