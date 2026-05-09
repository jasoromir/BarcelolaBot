import type { AppLogger } from '../log/logger.js';
import type { WorkerForwardsStore } from '../persistence/workerForwards.js';
import type { ReactionEvent, WhatsAppClient } from '../whatsapp/types.js';

// Unicode thumbs up, including the FE0F variation selector that some clients
// attach. Skin-tone modifiers ('\u{1F44D}\u{1F3FB}' etc.) start with the same
// base codepoint so we compare on the prefix.
const THUMBS_UP_CODEPOINT = '👍';

function isThumbsUp(emoji: string): boolean {
  return emoji.startsWith(THUMBS_UP_CODEPOINT);
}

export interface ReactionHandlerDeps {
  wa: WhatsAppClient;
  workerForwards: WorkerForwardsStore;
  logger: AppLogger;
  settings: { workerGroupId: string };
}

export function createReactionHandler(deps: ReactionHandlerDeps) {
  return async function handleReaction(ev: ReactionEvent): Promise<void> {
    if (!isThumbsUp(ev.reaction)) return;
    // Only act on reactions to messages in the worker group.
    if (ev.chatId && ev.chatId !== deps.settings.workerGroupId) return;

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
  };
}
