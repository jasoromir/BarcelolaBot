import Database, { Database as DB } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     level TEXT NOT NULL,
     source TEXT NOT NULL,
     event_type TEXT NOT NULL,
     message TEXT NOT NULL,
     metadata TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)`,
  `CREATE TABLE IF NOT EXISTS job_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_name TEXT NOT NULL,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     status TEXT NOT NULL,
     tours_count INTEGER,
     groups_sent INTEGER,
     groups_closed INTEGER,
     dry_run INTEGER DEFAULT 0,
     error TEXT,
     metadata TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS processed_webhooks (
     booking_id TEXT PRIMARY KEY,
     received_at TEXT NOT NULL,
     completed_at TEXT,
     outcome TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS pending_dms (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     phone TEXT NOT NULL,
     body TEXT NOT NULL,
     booking_id TEXT,
     created_at TEXT NOT NULL,
     attempts INTEGER DEFAULT 0,
     last_error TEXT,
     status TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_dms_status ON pending_dms(status)`,
  `CREATE TABLE IF NOT EXISTS control_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS reminders (
     booking_id TEXT PRIMARY KEY,
     phone TEXT NOT NULL,
     client_name TEXT,
     tour_id TEXT,
     tour_name_he TEXT,
     start_at_iso TEXT NOT NULL,
     participant_count INTEGER NOT NULL DEFAULT 1,
     status TEXT NOT NULL,
     send_at_iso TEXT,
     sent_at_iso TEXT,
     last_reply_ts TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status)`,
  `CREATE INDEX IF NOT EXISTS idx_reminders_send_at ON reminders(send_at_iso) WHERE sent_at_iso IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_reminders_phone ON reminders(phone)`,
  `CREATE TABLE IF NOT EXISTS reply_audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     phone TEXT NOT NULL,
     booking_id TEXT,
     raw_text TEXT NOT NULL,
     intent TEXT,
     participant_count INTEGER,
     confidence REAL,
     forwarded INTEGER DEFAULT 0,
     notes TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_reply_audit_ts ON reply_audit(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reply_audit_phone ON reply_audit(phone)`,
  `CREATE TABLE IF NOT EXISTS worker_forwards (
     group_message_id TEXT PRIMARY KEY,
     booking_id TEXT NOT NULL,
     phone TEXT NOT NULL,
     client_name TEXT,
     customer_message TEXT NOT NULL,
     suggested_reply TEXT,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     sent_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_worker_forwards_status ON worker_forwards(status)`,
];

const SEEDS: Array<[string, string]> = [
  ['automations_paused', 'false'],
  ['last_connect_state', 'disconnected'],
];

export function openDatabase(dbPath: string): DB {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.transaction(() => {
    for (const sql of MIGRATIONS) db.exec(sql);
    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO control_state (key, value, updated_at) VALUES (?, ?, ?)',
    );
    for (const [k, v] of SEEDS) insert.run(k, v, now);
  })();
  return db;
}
