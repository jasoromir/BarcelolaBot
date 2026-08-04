import { describe, it, expect } from 'vitest';
import { classifyReactionEmoji } from '../../src/reminders/reactionIntent.js';

describe('classifyReactionEmoji', () => {
  it('maps thumbs up to confirm', () => {
    expect(classifyReactionEmoji('👍')).toBe('confirm');
  });

  it('maps skin-tone thumbs up variants to confirm', () => {
    for (const tone of ['🏻', '🏼', '🏽', '🏾', '🏿']) {
      expect(classifyReactionEmoji(`👍${tone}`)).toBe('confirm');
    }
  });

  it('maps thumbs up with the FE0F variation selector to confirm', () => {
    expect(classifyReactionEmoji('👍️')).toBe('confirm');
  });

  it('maps other affirmative emoji to confirm', () => {
    for (const e of ['👌', '✅', '✔️', '💪', '🙌', '❤️', '🥳', '🔥', '🌻', '💯', '🫡']) {
      expect(classifyReactionEmoji(e), `${e} should confirm`).toBe('confirm');
    }
  });

  it('maps thumbs down to cancel', () => {
    expect(classifyReactionEmoji('👎')).toBe('cancel');
    expect(classifyReactionEmoji('👎🏽')).toBe('cancel');
  });

  it('maps other negative emoji to cancel', () => {
    for (const e of ['❌', '🚫', '😢', '😭', '💔', '🤒', '😷']) {
      expect(classifyReactionEmoji(e), `${e} should cancel`).toBe('cancel');
    }
  });

  it('returns null for ambiguous emoji so the caller escalates to staff', () => {
    for (const e of ['🤔', '😂', '🙃', '🤷', '👀', '🍕', '🙏']) {
      expect(classifyReactionEmoji(e), `${e} should be unmapped`).toBeNull();
    }
  });

  it('returns null for the empty string WhatsApp sends on reaction removal', () => {
    expect(classifyReactionEmoji('')).toBeNull();
  });
});
