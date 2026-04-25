import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db.js';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) if (fs.existsSync(f)) fs.unlinkSync(f);
  tmpFiles.length = 0;
});

function tmpDbPath(): string {
  const p = path.join(os.tmpdir(), `wabot-${Date.now()}-${Math.random()}.sqlite`);
  tmpFiles.push(p);
  return p;
}

describe('openDatabase', () => {
  it('creates all tables on fresh db', () => {
    const db = openDatabase(tmpDbPath());
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain('events');
    expect(names).toContain('job_runs');
    expect(names).toContain('processed_webhooks');
    expect(names).toContain('pending_dms');
    expect(names).toContain('control_state');
    db.close();
  });

  it('is idempotent (re-open does not error)', () => {
    const p = tmpDbPath();
    openDatabase(p).close();
    const db = openDatabase(p);
    db.close();
  });

  it('seeds control_state defaults', () => {
    const db = openDatabase(tmpDbPath());
    const row = db
      .prepare("SELECT value FROM control_state WHERE key = 'automations_paused'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('false');
    db.close();
  });
});
