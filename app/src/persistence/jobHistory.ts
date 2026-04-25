import type { Database as DB } from 'better-sqlite3';
import type { JobName, JobStatus } from '../types.js';

export interface JobRunRow {
  id: number;
  job_name: JobName;
  started_at: string;
  ended_at: string | null;
  status: JobStatus;
  tours_count: number | null;
  groups_sent: number | null;
  groups_closed: number | null;
  dry_run: 0 | 1;
  error: string | null;
  metadata: Record<string, unknown> | null;
}

export interface FinishInput {
  status: JobStatus;
  toursCount?: number;
  groupsSent?: number;
  groupsClosed?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export class JobHistory {
  constructor(private readonly db: DB) {}

  start(jobName: JobName, opts: { dryRun: boolean }): number {
    const info = this.db
      .prepare(
        `INSERT INTO job_runs (job_name, started_at, status, dry_run)
         VALUES (?, ?, 'running', ?)`,
      )
      .run(jobName, new Date().toISOString(), opts.dryRun ? 1 : 0);
    return Number(info.lastInsertRowid);
  }

  finish(id: number, input: FinishInput): void {
    this.db
      .prepare(
        `UPDATE job_runs
         SET ended_at = ?, status = ?, tours_count = ?, groups_sent = ?, groups_closed = ?, error = ?, metadata = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        input.status,
        input.toursCount ?? null,
        input.groupsSent ?? null,
        input.groupsClosed ?? null,
        input.error ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        id,
      );
  }

  recent(limit: number): JobRunRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM job_runs ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<Omit<JobRunRow, 'metadata'> & { metadata: string | null }>;
    return rows.map((r) => ({
      ...r,
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    }));
  }

  markStaleRunning(olderThanIsoTs: string): number {
    return this.db
      .prepare(
        `UPDATE job_runs SET status = 'failed', ended_at = ?, error = 'process restart'
         WHERE status = 'running' AND started_at < ?`,
      )
      .run(new Date().toISOString(), olderThanIsoTs).changes;
  }
}
