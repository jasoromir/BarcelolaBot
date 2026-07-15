import type { Database as DB } from 'better-sqlite3';
import * as crypto from 'node:crypto';

export interface ParsedTourFields {
  tourName: string | null;
  guide: string | null;
  clientName: string | null;
  peopleCount: string | null;
  phone: string | null;
  email: string | null;
  meetingPoint: string | null;
}

export interface PrivateTourEventRow extends ParsedTourFields {
  eventId: string;
  contentHash: string;
  startAtIso: string;
  endAtIso: string;
  rawSummary: string;
  rawDescription: string | null;
  rawLocation: string | null;
  parsedAt: string;
  updatedAt: string;
}

/**
 * Hash of everything that would change what an LLM parse produces — a
 * Google-side edit to any of these fields invalidates the cached row so the
 * sync job re-parses it instead of skipping.
 */
export function computeContentHash(event: {
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  start?: string;
  end?: string;
}): string {
  const basis = JSON.stringify([
    event.summary ?? '',
    event.description ?? '',
    event.location ?? '',
    event.start ?? '',
    event.end ?? '',
  ]);
  return crypto.createHash('sha256').update(basis).digest('hex');
}

export class PrivateTourEventsStore {
  constructor(private readonly db: DB) {}

  /** True if we have a parse for this event ID whose content hash still matches (no re-parse needed). */
  isUpToDate(eventId: string, contentHash: string): boolean {
    const row = this.db
      .prepare('SELECT content_hash FROM private_tour_events WHERE event_id = ?')
      .get(eventId) as { content_hash: string } | undefined;
    return row?.content_hash === contentHash;
  }

  get(eventId: string): PrivateTourEventRow | undefined {
    const row = this.db.prepare('SELECT * FROM private_tour_events WHERE event_id = ?').get(eventId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  upsert(record: Omit<PrivateTourEventRow, 'parsedAt' | 'updatedAt'>): PrivateTourEventRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO private_tour_events
           (event_id, content_hash, start_at_iso, end_at_iso, raw_summary, raw_description, raw_location,
            tour_name, guide_name, client_name, people_count, phone, email, meeting_point, parsed_at, updated_at)
         VALUES (@event_id, @content_hash, @start_at_iso, @end_at_iso, @raw_summary, @raw_description, @raw_location,
                 @tour_name, @guide_name, @client_name, @people_count, @phone, @email, @meeting_point, @parsed_at, @updated_at)
         ON CONFLICT(event_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           start_at_iso = excluded.start_at_iso,
           end_at_iso = excluded.end_at_iso,
           raw_summary = excluded.raw_summary,
           raw_description = excluded.raw_description,
           raw_location = excluded.raw_location,
           tour_name = excluded.tour_name,
           guide_name = excluded.guide_name,
           client_name = excluded.client_name,
           people_count = excluded.people_count,
           phone = excluded.phone,
           email = excluded.email,
           meeting_point = excluded.meeting_point,
           updated_at = excluded.updated_at`,
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
        guide_name: record.guide,
        client_name: record.clientName,
        people_count: record.peopleCount,
        phone: record.phone,
        email: record.email,
        meeting_point: record.meetingPoint,
        parsed_at: now,
        updated_at: now,
      });
    return this.get(record.eventId)!;
  }

  listInRange(startIso: string, endIso: string): PrivateTourEventRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM private_tour_events WHERE start_at_iso >= ? AND start_at_iso <= ? ORDER BY start_at_iso ASC',
      )
      .all(startIso, endIso) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /**
   * Deletes cached rows in [startIso, endIso] whose event_id is no longer in
   * currentIds — handles bookings that got cancelled or recolored away from
   * purple after being cached, so a stale row can't trigger a wrong notify.
   */
  deleteStaleInRange(startIso: string, endIso: string, currentIds: string[]): number {
    const existing = this.db
      .prepare('SELECT event_id FROM private_tour_events WHERE start_at_iso >= ? AND start_at_iso <= ?')
      .all(startIso, endIso) as { event_id: string }[];
    const currentSet = new Set(currentIds);
    const staleIds = existing.map((r) => r.event_id).filter((id) => !currentSet.has(id));
    if (staleIds.length === 0) return 0;
    const del = this.db.prepare('DELETE FROM private_tour_events WHERE event_id = ?');
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) del.run(id);
    });
    tx(staleIds);
    return staleIds.length;
  }

  private rowToRecord(row: Record<string, unknown>): PrivateTourEventRow {
    return {
      eventId: row.event_id as string,
      contentHash: row.content_hash as string,
      startAtIso: row.start_at_iso as string,
      endAtIso: row.end_at_iso as string,
      rawSummary: row.raw_summary as string,
      rawDescription: (row.raw_description as string) ?? null,
      rawLocation: (row.raw_location as string) ?? null,
      tourName: (row.tour_name as string) ?? null,
      guide: (row.guide_name as string) ?? null,
      clientName: (row.client_name as string) ?? null,
      peopleCount: (row.people_count as string) ?? null,
      phone: (row.phone as string) ?? null,
      email: (row.email as string) ?? null,
      meetingPoint: (row.meeting_point as string) ?? null,
      parsedAt: row.parsed_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
