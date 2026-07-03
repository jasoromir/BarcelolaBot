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
  // Migration: eCommerce order ID alongside the bookingId for payment lookups.
  // ALTER TABLE is idempotent via the IGNORE approach: SQLite errors on a duplicate
  // column but we catch it in the migration runner below.
  `ALTER TABLE reminders ADD COLUMN order_id_ecom TEXT`,
  // Spam moderation: track when each participant was first seen in each group so
  // the detector can weight "first message from a brand-new joiner" — the
  // strongest crypto-spam-bot signal. first_seen_at is set on group_join (or on
  // the first message we observe from them if we missed the join event).
  `CREATE TABLE IF NOT EXISTS group_members (
     group_id TEXT NOT NULL,
     participant_id TEXT NOT NULL,
     first_seen_at TEXT NOT NULL,
     joined_via TEXT NOT NULL,
     PRIMARY KEY (group_id, participant_id)
   )`,
  // Audit trail of every moderation decision and action. Lets us review false
  // positives during the test phase and tune thresholds.
  `CREATE TABLE IF NOT EXISTS spam_actions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     group_id TEXT NOT NULL,
     participant_id TEXT NOT NULL,
     phone TEXT,
     message_id TEXT,
     body TEXT NOT NULL,
     score REAL NOT NULL,
     verdict TEXT NOT NULL,
     reasons TEXT,
     enforced INTEGER NOT NULL DEFAULT 0,
     deleted INTEGER NOT NULL DEFAULT 0,
     kicked INTEGER NOT NULL DEFAULT 0,
     error TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_spam_actions_ts ON spam_actions(ts DESC)`,
  // Guide pre-tour roster notifications: one row per tour occurrence we've
  // messaged the guide about, so the poller sends each roster exactly once.
  // tour_key is the Wix eventId (or serviceId+startIso fallback).
  `CREATE TABLE IF NOT EXISTS guide_notifications (
     tour_key TEXT PRIMARY KEY,
     guide_name TEXT,
     guide_phone TEXT,
     tour_title TEXT,
     start_at_iso TEXT NOT NULL,
     attendee_count INTEGER NOT NULL DEFAULT 0,
     sent_at TEXT NOT NULL,
     message_id TEXT,
     status TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_guide_notifications_start ON guide_notifications(start_at_iso)`,
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
    for (const sql of MIGRATIONS) {
      try {
        db.exec(sql);
      } catch (err) {
        // ALTER TABLE throws if the column already exists — safe to ignore.
        if (!/duplicate column/i.test((err as Error).message)) throw err;
      }
    }
    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO control_state (key, value, updated_at) VALUES (?, ?, ?)',
    );
    for (const [k, v] of SEEDS) insert.run(k, v, now);
  })();
  return db;
}
