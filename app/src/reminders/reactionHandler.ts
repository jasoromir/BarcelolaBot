import type { AppLogger } from '../log/logger.js';
import type { ReplyAuditStore, RemindersStore } from '../persistence/reminders.js';
import type { WorkerForwardsStore } from '../persistence/workerForwards.js';
import type { ReactionEvent, WhatsAppClient } from '../whatsapp/types.js';
import { normalizePhone } from '../messaging/phoneNormalizer.js';
import { classifyReactionEmoji } from './reactionIntent.js';
import { applyCancel, applyConfirm, type BookingResponseDeps } from './bookingResponse.js';

// Unicode thumbs up, including the FE0F variation selector that some clients
// attach. Skin-tone modifiers ('\u{1F44D}\u{1F3FB}' etc.) start with the same
// base codepoint so we compare on the prefix.
const THUMBS_UP_CODEPOINT = '👍';

function isThumbsUp(emoji: string): boolean {
  return emoji.startsWith(THUMBS_UP_CODEPOINT);
}

/** Extends BookingResponseDeps so `deps` can be passed to applyConfirm/applyCancel. */
export interface ReactionHandlerDeps extends BookingResponseDeps {
  wa: WhatsAppClient;
  workerForwards: WorkerForwardsStore;
  /** Present when reminders are enabled — needed to resolve a DM reaction to a booking. */
  reminders: RemindersStore;
  audit: ReplyAuditStore;
  logger: AppLogger;
  settings: {
    workerGroupId: string;
    officialContactNumber: string;
    defaultGoogleMapsUrl?: string;
    clientResponseNotifyPhone?: string;
  };
}

export function createReactionHandler(deps: ReactionHandlerDeps) {
  // Reactions are delivered via `reactionTableMode.bulkUpsert`, which WhatsApp
  // Web re-runs on resync — the same reaction can therefore be emitted more
  // than once. Confirm/cancel is idempotent on the DB status, but the customer
  // ack + manager notification are not, so dedupe on (message, sender, emoji).
  // In-memory only: a restart at worst re-sends one ack.
  const seen = new Set<string>();
  const remember = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 1000) {
      const first = seen.values().next().value;
      if (first) seen.delete(first);
    }
    return true;
  };

  /**
   * A customer reacted to one of our DMs (typically the day-before reminder).
   * Treat a recognised emoji exactly as if they had replied with that word.
   */
  async function handleCustomerReaction(ev: ReactionEvent): Promise<void> {
    // The reaction event's chatId is the DM chat, which for @c.us carries the
    // phone digits. For @lid we resolve through the client, same as inbound DMs.
    const rawId = ev.senderId || ev.chatId;
    if (!rawId) return;
    let phone: string | null = null;
    if (rawId.endsWith('@c.us')) {
      const digits = rawId.replace(/@c\.us$/, '');
      phone = /^\d{6,15}$/.test(digits) ? `+${digits}` : null;
    } else {
      phone = await deps.wa.resolveParticipantPhone(rawId).catch(() => null);
    }
    if (!phone) {
      deps.logger.warn({
        source: 'reply',
        eventType: 'reaction_phone_unresolved',
        message: `could not resolve phone for reaction from ${rawId}`,
      });
      return;
    }
    phone = normalizePhone(phone) ?? phone;

    const nowIso = new Date().toISOString();
    const reminder = deps.reminders.findActiveForReply(phone, nowIso);
    if (!reminder) {
      // No upcoming booking — nothing to confirm. Reacting to an old message is
      // not something we need to answer, and unlike a text DM it carries no
      // question, so we deliberately do NOT send the unmanaged-number reply.
      deps.logger.info({
        source: 'reply',
        eventType: 'reaction_no_active_reminder',
        message: `reaction ${ev.reaction} from ${phone} with no active reminder — ignored`,
      });
      return;
    }

    const intent = classifyReactionEmoji(ev.reaction);
    if (!intent) {
      // An emoji we don't map (🤔, 😂, ...). Don't guess — tell staff so a human
      // reads it, and record it in the audit trail.
      deps.audit.record({
        ts: nowIso,
        phone,
        bookingId: reminder.bookingId,
        rawText: `[reaction] ${ev.reaction}`,
        intent: null,
        participantCount: null,
        confidence: null,
        forwarded: true,
        notes: 'reaction_unrecognized',
      });
      try {
        await deps.wa.sendToGroup(
          deps.settings.workerGroupId,
          `❓ *לקוח הגיב בתגובה שלא זוהתה* — נא לבדוק ידנית\n\n` +
            `👤 *לקוח:* ${reminder.clientName ?? 'לקוח/ה'}\n` +
            `📞 ${phone}\n` +
            `🎯 *סיור:* ${reminder.tourNameHe ?? '(לא ידוע)'}\n` +
            `💬 *התגובה:* ${ev.reaction}`,
        );
      } catch (err) {
        deps.logger.error({
          source: 'reply',
          eventType: 'worker_notify_failed',
          message: `reaction_unrecognized: ${(err as Error).message}`,
        });
      }
      deps.logger.info({
        source: 'reply',
        eventType: 'reaction_unrecognized',
        message: `unmapped reaction ${ev.reaction} from ${phone} on ${reminder.bookingId}`,
      });
      return;
    }

    const rawText = `[reaction] ${ev.reaction}`;

    if (intent === 'cancel') {
      if (reminder.status === 'cancelled') {
        deps.audit.record({
          ts: nowIso,
          phone,
          bookingId: reminder.bookingId,
          rawText,
          intent: 'cancel',
          participantCount: null,
          confidence: null,
          forwarded: false,
          notes: 'already_cancelled_reaction',
        });
        return;
      }
      await applyCancel(deps, { reminder, via: 'reaction', rawText: ev.reaction, nowIso });
      deps.audit.record({
        ts: nowIso,
        phone,
        bookingId: reminder.bookingId,
        rawText,
        intent: 'cancel',
        participantCount: null,
        confidence: null,
        forwarded: false,
        notes: 'via_reaction',
      });
      return;
    }

    // A reaction carries no number, so the count is always unchanged. That makes
    // an already-confirmed booking a no-op: re-sending the ack would just repeat
    // the same confirmation at the customer.
    if (reminder.status === 'confirmed') {
      deps.audit.record({
        ts: nowIso,
        phone,
        bookingId: reminder.bookingId,
        rawText,
        intent: 'confirm',
        participantCount: null,
        confidence: null,
        forwarded: false,
        notes: 'already_confirmed_reaction',
      });
      deps.logger.info({
        source: 'reply',
        eventType: 'confirm_ignored_duplicate',
        message: `duplicate confirm-by-reaction for ${reminder.bookingId}`,
      });
      return;
    }

    await applyConfirm(deps, {
      reminder,
      newCount: reminder.participantCount,
      via: 'reaction',
      rawText: ev.reaction,
      nowIso,
    });
    deps.audit.record({
      ts: nowIso,
      phone,
      bookingId: reminder.bookingId,
      rawText,
      intent: 'confirm',
      participantCount: null,
      confidence: null,
      forwarded: false,
      notes: 'via_reaction',
    });
  }

  /**
   * A staff member 👍'd a forwarded customer message in the worker group, which
   * means "send the suggested reply as-is".
   */
  async function handleWorkerReaction(ev: ReactionEvent): Promise<void> {
    if (!isThumbsUp(ev.reaction)) return;

    const forward = deps.workerForwards.get(ev.targetMessageId);
    if (!forward) {
      // Reaction on something else in the group — ignore.
      return;
    }
    if (forward.status === 'sent') {
      deps.logger.info({
        source: 'reply',
        eventType: 'draft_already_sent',
        message: `ignored duplicate 👍 on ${ev.targetMessageId}`,
      });
      return;
    }
    if (!forward.suggestedReply) {
      deps.logger.warn({
        source: 'reply',
        eventType: 'draft_missing',
        message: `forward ${ev.targetMessageId} has no suggested_reply`,
      });
      return;
    }

    try {
      await deps.wa.sendDirect(forward.phone, forward.suggestedReply);
      deps.workerForwards.markSent(ev.targetMessageId);
      deps.logger.info({
        source: 'reply',
        eventType: 'draft_sent',
        message: `sent draft reply to ${forward.phone} (booking ${forward.bookingId})`,
      });
      // Confirm in the group so workers see the draft went out.
      try {
        await deps.wa.sendToGroup(
          deps.settings.workerGroupId,
          `✅ התשובה המוצעת נשלחה ללקוח (${forward.clientName ?? forward.phone}).`,
        );
      } catch {
        // Non-critical.
      }
    } catch (err) {
      deps.logger.error({
        source: 'reply',
        eventType: 'draft_send_failed',
        message: (err as Error).message,
      });
    }
  }

  return async function handleReaction(ev: ReactionEvent): Promise<void> {
    // Reaction removal sends an empty emoji. There's no sensible "un-confirm"
    // action (we've already acked the customer and told Wix), so ignore it.
    if (!ev.reaction) return;
    // Never react to our own reactions.
    if (ev.fromMe) return;

    const dedupeKey = `${ev.targetMessageId}|${ev.senderId}|${ev.reaction}`;
    if (!remember(dedupeKey)) return;

    if (ev.chatId === deps.settings.workerGroupId) {
      await handleWorkerReaction(ev);
      return;
    }

    // chatId occasionally arrives empty (the reaction payload's nested key
    // objects aren't always populated). The pre-existing behaviour was to still
    // try the staff-draft flow, which is safe because workerForwards is keyed by
    // a group message id we recorded ourselves — a lookup miss just means "not a
    // draft". Keep that, then fall through to the customer path via senderId.
    if (!ev.chatId) {
      if (deps.workerForwards.get(ev.targetMessageId)) {
        await handleWorkerReaction(ev);
        return;
      }
      if (!ev.senderId) return;
      await handleCustomerReaction(ev);
      return;
    }

    // 1:1 chats only — reactions in other groups (public tour groups) are not
    // booking answers and must not be interpreted as such.
    if (ev.chatId.endsWith('@g.us')) return;
    if (!(ev.chatId.endsWith('@c.us') || ev.chatId.endsWith('@lid'))) return;
    // Only a reaction on a message WE sent is an answer to us. `targetFromMe`
    // is undefined when the reaction payload didn't carry the flag — in that
    // case we proceed, since in a 1:1 chat with a booked customer the realistic
    // target is our reminder.
    if (ev.targetFromMe === false) return;
    await handleCustomerReaction(ev);
  };
}
