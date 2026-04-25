import type { Database as DB } from 'better-sqlite3';

export type LogLevel = 'info' | 'warn' | 'error';

export interface EventInput {
  level: LogLevel;
  source: string;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface EventRow {
  id: number;
  ts: string;
  level: LogLevel;
  source: string;
  event_type: string;
  message: string;
  metadata: Record<string, unknown> | null;
}

export class EventLog {
  constructor(private readonly db: DB) {}

  append(evt: EventInput): void {
    this.db
      .prepare(
        `INSERT INTO events (ts, level, source, event_type, message, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        evt.level,
        evt.source,
        evt.eventType,
        evt.message,
        evt.metadata ? JSON.stringify(evt.metadata) : null,
      );
  }

  recent(limit: number): EventRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, level, source, event_type, message, metadata
         FROM events ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<Omit<EventRow, 'metadata'> & { metadata: string | null }>;
    return rows.map((r) => ({
      ...r,
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    }));
  }

  since(sinceId: number, limit: number): EventRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, level, source, event_type, message, metadata
         FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(sinceId, limit) as Array<Omit<EventRow, 'metadata'> & { metadata: string | null }>;
    return rows.map((r) => ({
      ...r,
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    }));
  }

  pruneOlderThan(isoTs: string): number {
    return this.db.prepare('DELETE FROM events WHERE ts < ?').run(isoTs).changes;
  }
}
