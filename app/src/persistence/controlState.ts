import type { Database as DB } from 'better-sqlite3';

export class ControlState {
  constructor(private readonly db: DB) {}

  get(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM control_state WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO control_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }
}
