import Database, { Database as DB } from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface ParsedTourFields {
  tourName: string | null;
  guide: string | null;
  clientName: string | null;
  peopleCount: string | null;
  phone: string | null;
  email: string | null;
  meetingPoint: string | null;
}

export interface CachedPrivateEvent extends ParsedTourFields {
  eventId: string;
  contentHash: string;
  startAtIso: string;
  endAtIso: string;
  rawSummary: string;
  rawDescription: string | null;
  rawLocation: string | null;
  parsedAt: string;
}

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS private_events (
    event_id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    start_at_iso TEXT NOT NULL,
    end_at_iso TEXT NOT NULL,
    raw_summary TEXT NOT NULL,
    raw_description TEXT,
    raw_location TEXT,
    tour_name TEXT,
    guide TEXT,
    client_name TEXT,
    people_count TEXT,
    phone TEXT,
    email TEXT,
    meeting_point TEXT,
    parsed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_private_events_start ON private_events(start_at_iso);
`;

/** Hash of everything that would change what an LLM parse produces — a Google-side edit invalidates the cached row. */
export function computeContentHash(event: {
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  start?: string;
  end?: string;
}): string {
  const basis = JSON.stringify([event.summary ?? '', event.description ?? '', event.location ?? '', event.start ?? '', event.end ?? '']);
  return crypto.createHash('sha256').update(basis).digest('hex');
}

export class PrivateEventsCache {
  private readonly db: DB;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(MIGRATION);
  }

  /** True if we have a parse for this event ID whose content hash still matches (i.e. no re-parse needed). */
  isUpToDate(eventId: string, contentHash: string): boolean {
    const row = this.db
      .prepare('SELECT content_hash FROM private_events WHERE event_id = ?')
      .get(eventId) as { content_hash: string } | undefined;
    return row?.content_hash === contentHash;
  }

  get(eventId: string): CachedPrivateEvent | undefined {
    const row = this.db.prepare('SELECT * FROM private_events WHERE event_id = ?').get(eventId) as any;
    if (!row) return undefined;
    return this.rowToRecord(row);
  }

  upsert(record: Omit<CachedPrivateEvent, 'parsedAt'>): CachedPrivateEvent {
    const parsedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO private_events
           (event_id, content_hash, start_at_iso, end_at_iso, raw_summary, raw_description, raw_location,
            tour_name, guide, client_name, people_count, phone, email, meeting_point, parsed_at)
         VALUES (@event_id, @content_hash, @start_at_iso, @end_at_iso, @raw_summary, @raw_description, @raw_location,
                 @tour_name, @guide, @client_name, @people_count, @phone, @email, @meeting_point, @parsed_at)
         ON CONFLICT(event_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           start_at_iso = excluded.start_at_iso,
           end_at_iso = excluded.end_at_iso,
           raw_summary = excluded.raw_summary,
           raw_description = excluded.raw_description,
           raw_location = excluded.raw_location,
           tour_name = excluded.tour_name,
           guide = excluded.guide,
           client_name = excluded.client_name,
           people_count = excluded.people_count,
           phone = excluded.phone,
           email = excluded.email,
           meeting_point = excluded.meeting_point,
           parsed_at = excluded.parsed_at`,
      )
      .run({
        event_id: record.eventId,
        content_hash: record.contentHash,
        start_at_iso: record.startAtIso,
        end_at_iso: record.endAtIso,
        raw_summary: record.rawSummary,
        raw_description: record.rawDescription,
        raw_location: record.rawLocation,
        tour_name: record.tourName,
        guide: record.guide,
        client_name: record.clientName,
        people_count: record.peopleCount,
        phone: record.phone,
        email: record.email,
        meeting_point: record.meetingPoint,
        parsed_at: parsedAt,
      });
    return { ...record, parsedAt };
  }

  listInRange(startIso: string, endIso: string): CachedPrivateEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM private_events WHERE start_at_iso >= ? AND start_at_iso <= ? ORDER BY start_at_iso ASC')
      .all(startIso, endIso) as any[];
    return rows.map((r) => this.rowToRecord(r));
  }

  private rowToRecord(row: any): CachedPrivateEvent {
    return {
      eventId: row.event_id,
      contentHash: row.content_hash,
      startAtIso: row.start_at_iso,
      endAtIso: row.end_at_iso,
      rawSummary: row.raw_summary,
      rawDescription: row.raw_description,
      rawLocation: row.raw_location,
      tourName: row.tour_name,
      guide: row.guide,
      clientName: row.client_name,
      peopleCount: row.people_count,
      phone: row.phone,
      email: row.email,
      meetingPoint: row.meeting_point,
      parsedAt: row.parsed_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
