import type { Database as DB } from 'better-sqlite3';

export type JoinedVia = 'group_join' | 'first_message';

export interface GroupMemberRow {
  groupId: string;
  participantId: string;
  firstSeenAt: string;
  joinedVia: JoinedVia;
}

interface DBRow {
  group_id: string;
  participant_id: string;
  first_seen_at: string;
  joined_via: JoinedVia;
}

function row(r: DBRow): GroupMemberRow {
  return {
    groupId: r.group_id,
    participantId: r.participant_id,
    firstSeenAt: r.first_seen_at,
    joinedVia: r.joined_via,
  };
}

export class GroupMembersStore {
  constructor(private db: DB) {}

  /**
   * Record a member's first appearance in a group. No-op if already known, so
   * the genuine join time is preserved even if we later see a `first_message`
   * for someone whose join we caught.
   */
  recordSeen(groupId: string, participantId: string, joinedVia: JoinedVia, at?: string): void {
    const now = at ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO group_members (group_id, participant_id, first_seen_at, joined_via)
         VALUES (?, ?, ?, ?)`,
      )
      .run(groupId, participantId, now, joinedVia);
  }

  get(groupId: string, participantId: string): GroupMemberRow | null {
    const found = this.db
      .prepare('SELECT * FROM group_members WHERE group_id = ? AND participant_id = ?')
      .get(groupId, participantId) as DBRow | undefined;
    return found ? row(found) : null;
  }
}

export type SpamVerdict = 'spam' | 'ham' | 'review';

export interface SpamActionRow {
  ts: string;
  groupId: string;
  participantId: string;
  /** Best-effort E.164 of the sender — kept so a wrongly-kicked customer can be re-added. */
  phone: string | null;
  messageId: string | null;
  body: string;
  score: number;
  verdict: SpamVerdict;
  reasons: string[];
  enforced: boolean;
  deleted: boolean;
  kicked: boolean;
  error: string | null;
}

export interface SpamActionRecord extends Omit<SpamActionRow, 'reasons'> {
  id: number;
  reasons: string[];
}

interface SpamActionDBRow {
  id: number;
  ts: string;
  group_id: string;
  participant_id: string;
  phone: string | null;
  message_id: string | null;
  body: string;
  score: number;
  verdict: SpamVerdict;
  reasons: string | null;
  enforced: number;
  deleted: number;
  kicked: number;
  error: string | null;
}

export class SpamActionsStore {
  constructor(private db: DB) {}

  insert(r: SpamActionRow): void {
    this.db
      .prepare(
        `INSERT INTO spam_actions
         (ts, group_id, participant_id, phone, message_id, body, score, verdict, reasons,
          enforced, deleted, kicked, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.ts,
        r.groupId,
        r.participantId,
        r.phone,
        r.messageId,
        r.body,
        r.score,
        r.verdict,
        JSON.stringify(r.reasons),
        r.enforced ? 1 : 0,
        r.deleted ? 1 : 0,
        r.kicked ? 1 : 0,
        r.error,
      );
  }

  /** Most recent moderation actions, newest first. For the admin review screen. */
  recent(limit = 100): SpamActionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM spam_actions ORDER BY ts DESC LIMIT ?')
      .all(limit) as SpamActionDBRow[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      groupId: r.group_id,
      participantId: r.participant_id,
      phone: r.phone,
      messageId: r.message_id,
      body: r.body,
      score: r.score,
      verdict: r.verdict,
      reasons: r.reasons ? (JSON.parse(r.reasons) as string[]) : [],
      enforced: Boolean(r.enforced),
      deleted: Boolean(r.deleted),
      kicked: Boolean(r.kicked),
      error: r.error,
    }));
  }
}
