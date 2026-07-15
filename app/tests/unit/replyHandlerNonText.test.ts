import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createReplyHandler } from '../../src/reminders/replyHandler.js';

// Minimal stubs — we only exercise the non-text (voice/media) branch, which
// runs before the classifier, so the classifier/wix/drafter can be no-ops.
function makeDeps(overrides: any = {}) {
  const wa = {
    sendToGroup: vi.fn(async () => ({ messageId: 'g' })),
    sendDirect: vi.fn(async () => ({ messageId: 'm' })),
    forwardMessage: vi.fn(async () => ({ messageId: 'f' })),
  };
  const reminders = {
    findActiveForReply: vi.fn(() => overrides.reminder ?? null),
  };
  const audit = { record: vi.fn() };
  const deps: any = {
    wa,
    wix: {},
    reminders,
    audit,
    workerForwards: { insert: vi.fn() },
    classifier: { classify: vi.fn(async () => ({ intent: 'other', confidence: 1 })) },
    drafter: null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: { officialContactNumber: '+34', workerGroupId: '120@g.us', confidenceThreshold: 0.7, debounceSeconds: 0 },
    config: () => ({ templates: { unmanaged_number_reply: 'AUTO-REPLY' }, tours: { tours: {} } }),
  };
  return { deps, wa, reminders, audit };
}

const voiceDm = {
  messageId: 'x1',
  fromPhoneE164: '+972500000000',
  body: '',
  timestamp: 0,
  type: 'ptt',
  hasMedia: true,
};

describe('replyHandler non-text (voice/media) handling', () => {
  it('forwards a voice note to the worker group and forwards the media', async () => {
    const { deps, wa } = makeDeps({ reminder: { bookingId: 'b1', phone: '+972500000000', clientName: 'Dana', tourNameHe: 'Tour' } });
    const handle = createReplyHandler(deps);
    await handle(voiceDm as any);
    expect(wa.sendToGroup).toHaveBeenCalled();
    expect((wa.sendToGroup as any).mock.calls[0][1]).toContain('הודעה קולית');
    expect(wa.forwardMessage).toHaveBeenCalledWith('x1', '120@g.us');
    // Booked customer → NO auto-reply DM
    expect(wa.sendDirect).not.toHaveBeenCalled();
  });

  it('for an unbooked number: forwards AND sends the unmanaged auto-reply', async () => {
    const { deps, wa } = makeDeps({ reminder: null });
    const handle = createReplyHandler(deps);
    await handle(voiceDm as any);
    expect(wa.sendToGroup).toHaveBeenCalled();
    expect(wa.sendDirect).toHaveBeenCalledWith('+972500000000', 'AUTO-REPLY');
  });

  it('does not re-send the auto-reply within the throttle window', async () => {
    const { deps, wa } = makeDeps({ reminder: null });
    const handle = createReplyHandler(deps);
    await handle(voiceDm as any);
    await handle({ ...voiceDm, messageId: 'x2' } as any);
    // sendDirect (auto-reply) only once despite two media messages
    expect((wa.sendDirect as any).mock.calls.length).toBe(1);
    // but both were forwarded to staff
    expect((wa.sendToGroup as any).mock.calls.length).toBe(2);
  });
});
