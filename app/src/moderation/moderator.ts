import type { AppLogger } from '../log/logger.js';
import type { GroupJoinEvent, GroupMessage, WhatsAppClient } from '../whatsapp/types.js';
import type { GroupMembersStore, SpamActionsStore } from '../persistence/groupMembers.js';
import type { Detector } from './detector.js';

export interface ModerationSettings {
  enabled: boolean;
  /** Only delete/kick in these groups. Detection still runs everywhere for logging. */
  enforceInGroups: string[];
  /** Sender ids/phones that must never be actioned (official contact, etc.). */
  neverActionPhones: string[];
}

export interface ModeratorDeps {
  wa: WhatsAppClient;
  detector: Detector;
  members: GroupMembersStore;
  actions: SpamActionsStore;
  logger: AppLogger;
  settings: ModerationSettings;
  /** Where to send moderation alerts (worker group id). */
  alertGroupId: string | null;
}

export interface Moderator {
  onGroupMessage(msg: GroupMessage): Promise<void>;
  onGroupJoin(ev: GroupJoinEvent): void;
}

export function createModerator(deps: ModeratorDeps): Moderator {
  const { wa, detector, members, actions, logger, settings, alertGroupId } = deps;

  // Cache group admins briefly so we don't refetch participants on every message.
  const adminCache = new Map<string, { ids: Set<string>; expires: number }>();
  const ADMIN_TTL_MS = 60_000;

  async function adminIds(groupId: string): Promise<Set<string>> {
    const cached = adminCache.get(groupId);
    const now = Date.now();
    if (cached && cached.expires > now) return cached.ids;
    let ids = new Set<string>();
    try {
      ids = new Set(await wa.getGroupAdmins(groupId));
    } catch (err) {
      logger.warn({
        source: 'moderation',
        eventType: 'admin_fetch_failed',
        message: `could not fetch admins for ${groupId}: ${(err as Error).message}`,
      });
    }
    adminCache.set(groupId, { ids, expires: now + ADMIN_TTL_MS });
    return ids;
  }

  function senderAgeMinutes(groupId: string, authorId: string, nowSec: number): number | null {
    const rec = members.get(groupId, authorId);
    if (!rec) return null;
    const firstSeenSec = Math.floor(new Date(rec.firstSeenAt).getTime() / 1000);
    return Math.max(0, Math.floor((nowSec - firstSeenSec) / 60));
  }

  return {
    async onGroupMessage(msg: GroupMessage): Promise<void> {
      if (!settings.enabled) return;
      if (!msg.authorId) return;

      // Compute age against the EXISTING record before stamping, so a sender we
      // saw join 5 minutes ago reads as 5m — not 0. If we never saw them (bot
      // added later, restart), age is null and they're treated as not-new,
      // which is the safe default (won't trip the new-joiner spam boost).
      const age = senderAgeMinutes(msg.groupId, msg.authorId, msg.timestamp);
      // Now stamp first-seen if this is the first message we've observed.
      members.recordSeen(msg.groupId, msg.authorId, 'first_message');

      const result = await detector.detect({ body: msg.body, senderAgeMinutes: age });

      // Clean ham: nothing to do, don't spend a DB row on every benign message.
      if (result.verdict === 'ham') return;

      // Resolve the phone up front so it's recorded even if we don't enforce —
      // this is what lets us re-add a wrongly-kicked customer later.
      const phone = await wa.resolveParticipantPhone(msg.authorId).catch(() => null);

      const admins = await adminIds(msg.groupId);
      const isAdmin = admins.has(msg.authorId);
      const isProtected =
        isAdmin ||
        (phone !== null && settings.neverActionPhones.includes(phone));
      const enforceHere = settings.enforceInGroups.includes(msg.groupId);
      const shouldEnforce = result.verdict === 'spam' && enforceHere && !isProtected;

      let deleted = false;
      let kicked = false;
      let actionError: string | null = null;

      if (shouldEnforce) {
        try {
          await wa.deleteMessageForEveryone(msg.messageId);
          deleted = true;
        } catch (err) {
          actionError = `delete: ${(err as Error).message}`;
        }
        try {
          await wa.removeParticipant(msg.groupId, msg.authorId);
          kicked = true;
        } catch (err) {
          actionError = `${actionError ? actionError + '; ' : ''}kick: ${(err as Error).message}`;
        }
      }

      actions.insert({
        ts: new Date().toISOString(),
        groupId: msg.groupId,
        participantId: msg.authorId,
        phone,
        messageId: msg.messageId,
        body: msg.body,
        score: result.score,
        verdict: result.verdict,
        reasons: result.reasons,
        enforced: shouldEnforce,
        deleted,
        kicked,
        error: actionError,
      });

      const reasonStr = result.reasons.join(', ');
      logger.warn({
        source: 'moderation',
        eventType: shouldEnforce ? 'spam_enforced' : 'spam_detected',
        message: `${result.verdict} (score=${result.score.toFixed(2)}) from ${phone ?? msg.authorId} in ${msg.groupId}; deleted=${deleted} kicked=${kicked}${
          isProtected ? ' [protected: not actioned]' : ''
        }${!enforceHere ? ' [detect-only group]' : ''}`,
        metadata: {
          phone,
          participantId: msg.authorId,
          groupId: msg.groupId,
          score: result.score,
          reasons: reasonStr,
          body: msg.body.slice(0, 200),
          deleted,
          kicked,
          error: actionError,
        },
      });

      // Alert the worker group so a human can spot false positives and re-add
      // the number if needed. We always include the phone for exactly that.
      if (alertGroupId && (shouldEnforce || result.verdict === 'spam' || result.verdict === 'review')) {
        const lines = [
          shouldEnforce ? '🚫 Spam removed' : '⚠️ Suspected spam (not actioned)',
          `From: ${phone ?? msg.authorId}`,
          `Group: ${msg.groupId}`,
          `Reasons: ${reasonStr}`,
          deleted || kicked ? `Action: ${deleted ? 'deleted' : ''}${deleted && kicked ? ' + ' : ''}${kicked ? 'kicked' : ''}` : 'Action: none',
          actionError ? `Error: ${actionError}` : '',
          '',
          `Message: ${msg.body.slice(0, 300)}`,
        ].filter(Boolean);
        wa.sendToGroup(alertGroupId, lines.join('\n')).catch((err) => {
          logger.warn({
            source: 'moderation',
            eventType: 'alert_failed',
            message: `could not send moderation alert: ${(err as Error).message}`,
          });
        });
      }
    },

    onGroupJoin(ev: GroupJoinEvent): void {
      if (!settings.enabled) return;
      const now = new Date().toISOString();
      for (const pid of ev.participantIds) {
        // 'group_join' is authoritative for join time — record even if a
        // first_message already stamped them (INSERT OR IGNORE keeps earliest).
        members.recordSeen(ev.groupId, pid, 'group_join', now);
      }
      logger.info({
        source: 'moderation',
        eventType: 'group_join_tracked',
        message: `tracked ${ev.participantIds.length} joiner(s) in ${ev.groupId}`,
      });
    },
  };
}
