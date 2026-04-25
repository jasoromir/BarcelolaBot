import type { Database as DB } from 'better-sqlite3';

export interface EnqueueInput {
  phone: string;
  body: string;
  bookingId?: string;
}

export interface PendingDmRow {
  id: number;
  phone: string;
  body: string;
  booking_id: string | null;
  created_at: string;
  attempts: number;
  last_error: string | null;
  status: 'pending' | 'sent' | 'abandoned';
}

export class PendingDms {
  constructor(private readonly db: DB) {}

  enqueue(input: EnqueueInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO pending_dms (phone, body, booking_id, created_at, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      )
      .run(input.phone, input.body, input.bookingId ?? null, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  pending(): PendingDmRow[] {
    return this.db
      .prepare(`SELECT * FROM pending_dms WHERE status = 'pending' ORDER BY id ASC`)
      .all() as PendingDmRow[];
  }

  markSent(id: number): void {
    this.db.prepare(`UPDATE pending_dms SET status = 'sent' WHERE id = ?`).run(id);
  }

  recordFailure(id: number, error: string): void {
    this.db
      .prepare(`UPDATE pending_dms SET attempts = attempts + 1, last_error = ? WHERE id = ?`)
      .run(error, id);
  }

  markAbandoned(id: number): void {
    this.db.prepare(`UPDATE pending_dms SET status = 'abandoned' WHERE id = ?`).run(id);
  }
}
