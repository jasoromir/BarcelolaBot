/**
 * Maps a WhatsApp *reaction* emoji to a booking intent.
 *
 * Customers increasingly answer the day-before "are you coming?" reminder by
 * reacting to it (👍) instead of replying with text. A reaction carries no
 * body, so it never reaches the text classifier — it arrives as a separate
 * `message_reaction` event. This module is the deliberate, hand-written
 * equivalent of the LLM classifier for that single-emoji case: no model call,
 * no confidence score, just an explicit allowlist.
 *
 * Design rules:
 * - Allowlist only. An emoji we don't recognise returns null and the reaction
 *   is escalated to staff rather than guessed at — silently mis-reading a 🤔
 *   as a confirmation would put a no-show on a guide's roster.
 * - Compare on the base codepoint prefix so skin-tone modifiers
 *   ('👍🏽' = '\u{1F44D}\u{1F3FD}') and the FE0F variation selector match.
 * - A reaction can never change the participant count — there's no number in
 *   it. Confirming via reaction keeps whatever count is on file.
 */

export type ReactionIntent = 'confirm' | 'cancel';

/**
 * Base codepoints that mean "yes, we're coming".
 *
 * Kept narrow on purpose. 🙏 is excluded because in Hebrew/Israeli usage it
 * reads as "thanks"/"please" and is routinely used to acknowledge a message
 * without committing to attend.
 */
const CONFIRM_EMOJI = [
  '👍', // thumbs up — by far the most common
  '👌', // OK hand
  '✅', // check mark button
  '☑️', // ballot box with check
  '✔️', // heavy check mark
  '💪', // flexed biceps — "we're on it"
  '🙌', // raising hands
  '😊', // smiling face — used as a warm "yes"
  '😃',
  '😀',
  '🥳', // partying face — excited yes
  '🤩',
  '❤️', // hearts read as enthusiasm for the tour
  '❤',
  '🧡',
  '💛',
  '💚',
  '💙',
  '💜',
  '🖤',
  '🤍',
  '🤎',
  '💕',
  '💖',
  '💗',
  '💞',
  '😍',
  '🔥', // "let's go"
  '🎉',
  '🎊',
  '🌻', // the company's own sunflower — used affirmatively
  '💯',
  '🤝',
  '🫡', // saluting face — "understood/on it"
] as const;

/** Base codepoints that mean "we're not coming". */
const CANCEL_EMOJI = [
  '👎', // thumbs down
  '❌', // cross mark
  '✖️',
  '❎',
  '🚫',
  '😢', // crying — "sorry, we can't"
  '😭',
  '😞',
  '😔',
  '😥',
  '🙁',
  '☹️',
  '💔',
  '🤒', // sick — the usual reason for dropping out
  '🤢',
  '🤧',
  '😷',
] as const;

/** Strip the FE0F variation selector so '✔️' and '✔' compare equal. */
function stripVariationSelectors(s: string): string {
  return s.replace(/[︎️]/g, '');
}

function matchesAny(emoji: string, table: readonly string[]): boolean {
  const normalized = stripVariationSelectors(emoji);
  return table.some((candidate) => {
    const base = stripVariationSelectors(candidate);
    // Prefix match, so skin-tone / ZWJ-extended variants of the same base
    // gesture ('👍🏿') still resolve.
    return normalized.startsWith(base);
  });
}

/**
 * Classify a reaction emoji. Returns null for anything not explicitly listed
 * (including the empty string WhatsApp sends when a reaction is *removed*) so
 * the caller can escalate to staff instead of acting on a guess.
 */
export function classifyReactionEmoji(emoji: string): ReactionIntent | null {
  if (!emoji) return null;
  // Cancel is checked first: it's the safer of the two to over-detect, since a
  // wrongly-cancelled booking generates a staff notification the customer can
  // correct, whereas a wrongly-confirmed one silently becomes a no-show.
  if (matchesAny(emoji, CANCEL_EMOJI)) return 'cancel';
  if (matchesAny(emoji, CONFIRM_EMOJI)) return 'confirm';
  return null;
}
