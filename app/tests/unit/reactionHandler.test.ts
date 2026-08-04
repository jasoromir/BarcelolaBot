import { describe, it, expect, vi } from 'vitest';
import { createReactionHandler } from '../../src/reminders/reactionHandler.js';

const WORKER_GROUP = '120363425214664727@g.us';
const NOTIFY_PHONE = '+34623964800';

const reminder = {
  bookingId: 'b1',
  orderIdEcom: null,
  phone: '+972544211402',
  clientName: 'דנה',
  tourId: null,
  tourNameHe: 'סיור גאודי',
  startAtIso: '2099-01-02T09:00:00.000Z',
  participantCount: 3,
  status: 'awaiting_reply' as const,
  sendAtIso: null,
  sentAtIso: null,
  lastReplyTs: null,
  welcomeDelivered: true,
  createdAt: '',
  updatedAt: '',
};

const templates = {
  confirmation_ack: 'ACK {client_name} {participant_count}',
  confirmation_update_ack: 'UPDATE {participant_count}',
  cancel_ack: 'CANCEL-ACK {client_name}',
  cancel_notice: 'CANCEL-NOTICE {client_name} {wix_status}',
  client_response_notice:
    'NOTICE {status_emoji} {status_text} {client_name} {phone} {tour_name_he} {time} {via_text}',
};

function makeDeps(overrides: any = {}) {
  const wa = {
    sendDirect: vi.fn(async () => ({ messageId: 'm' })),
    sendToGroup: vi.fn(async () => ({ messageId: 'g' })),
    resolveParticipantPhone: vi.fn(async () => null),
  };
  const wix = {
    cancelBooking: vi.fn(async () => ({ ok: true })),
    updateNumberOfParticipants: vi.fn(async () => ({ ok: true })),
  };
  const reminders = {
    findActiveForReply: vi.fn(() =>
      'reminder' in overrides ? overrides.reminder : reminder,
    ),
    setStatus: vi.fn(),
  };
  const audit = { record: vi.fn() };
  const workerForwards = { get: vi.fn(() => overrides.forward ?? null), markSent: vi.fn() };
  const deps: any = {
    wa,
    wix,
    reminders,
    audit,
    workerForwards,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      workerGroupId: WORKER_GROUP,
      officialContactNumber: '+34600000000',
      // `'notifyPhone' in overrides` rather than `??`, so a test can explicitly
      // pass undefined to mean "not configured".
      clientResponseNotifyPhone: 'notifyPhone' in overrides ? overrides.notifyPhone : NOTIFY_PHONE,
    },
    config: () => ({ templates, tours: { tours: {} } }),
  };
  return { deps, wa, wix, reminders, audit, workerForwards };
}

/** A customer reaction on our DM. */
function customerReaction(emoji: string, over: any = {}) {
  return {
    targetMessageId: 'true_972544211402@c.us_ABC',
    reaction: emoji,
    chatId: '972544211402@c.us',
    senderId: '972544211402@c.us',
    timestamp: 0,
    fromMe: false,
    targetFromMe: true,
    ...over,
  };
}

describe('reactionHandler — customer confirms/cancels by reaction', () => {
  it('👍 on our reminder confirms the booking and acks the customer', async () => {
    const { deps, wa, reminders } = makeDeps();
    await createReactionHandler(deps)(customerReaction('👍') as any);

    expect(reminders.setStatus).toHaveBeenCalledWith('b1', 'confirmed', expect.objectContaining({
      participantCount: 3,
    }));
    // Customer got the confirmation ack.
    expect(wa.sendDirect).toHaveBeenCalledWith('+972544211402', 'ACK דנה 3');
  });

  it('notifies the manager with name, phone, tour, hour, status and emoji', async () => {
    const { deps, wa } = makeDeps();
    await createReactionHandler(deps)(customerReaction('👍') as any);

    const notice = (wa.sendDirect as any).mock.calls.find((c: any[]) => c[0] === NOTIFY_PHONE);
    expect(notice, 'manager should be DMed').toBeDefined();
    const body = notice[1];
    expect(body).toContain('✅');
    expect(body).toContain('אישר/ה הגעה');
    expect(body).toContain('דנה');
    expect(body).toContain('+972544211402');
    expect(body).toContain('סיור גאודי');
    expect(body).toContain('10:00'); // 09:00Z rendered in Europe/Madrid
    expect(body).toContain('ריאקשן');
  });

  it('a reaction never changes the participant count (no Wix count update)', async () => {
    const { deps, wix } = makeDeps();
    await createReactionHandler(deps)(customerReaction('👍') as any);
    expect(wix.updateNumberOfParticipants).not.toHaveBeenCalled();
  });

  it('👎 cancels in Wix, acks the customer and posts a worker-group notice', async () => {
    const { deps, wa, wix, reminders } = makeDeps();
    await createReactionHandler(deps)(customerReaction('👎') as any);

    expect(wix.cancelBooking).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 'b1' }),
    );
    expect(reminders.setStatus).toHaveBeenCalledWith('b1', 'cancelled', expect.anything());
    expect(wa.sendDirect).toHaveBeenCalledWith('+972544211402', 'CANCEL-ACK דנה');
    expect(wa.sendToGroup).toHaveBeenCalledWith(WORKER_GROUP, expect.stringContaining('CANCEL-NOTICE'));

    const notice = (wa.sendDirect as any).mock.calls.find((c: any[]) => c[0] === NOTIFY_PHONE);
    expect(notice[1]).toContain('❌');
    expect(notice[1]).toContain('ביטל/ה הגעה');
  });

  it('an unmapped emoji is escalated to staff, not guessed at', async () => {
    const { deps, wa, wix, reminders, audit } = makeDeps();
    await createReactionHandler(deps)(customerReaction('🤔') as any);

    expect(reminders.setStatus).not.toHaveBeenCalled();
    expect(wix.cancelBooking).not.toHaveBeenCalled();
    expect(wa.sendToGroup).toHaveBeenCalledWith(WORKER_GROUP, expect.stringContaining('🤔'));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'reaction_unrecognized' }),
    );
    // Customer is not acked — a human will follow up.
    expect(wa.sendDirect).not.toHaveBeenCalled();
  });

  it('ignores a duplicate emit of the same reaction', async () => {
    const { deps, wa, reminders } = makeDeps();
    const handle = createReactionHandler(deps);
    await handle(customerReaction('👍') as any);
    await handle(customerReaction('👍') as any);
    expect(reminders.setStatus).toHaveBeenCalledTimes(1);
    // One ack to the customer + one notice to the manager, not two of each.
    expect((wa.sendDirect as any).mock.calls.length).toBe(2);
  });

  it('does not re-ack an already-confirmed booking', async () => {
    const { deps, wa, reminders } = makeDeps({
      reminder: { ...reminder, status: 'confirmed' },
    });
    await createReactionHandler(deps)(customerReaction('👍') as any);
    expect(reminders.setStatus).not.toHaveBeenCalled();
    expect(wa.sendDirect).not.toHaveBeenCalled();
  });

  it('does not double-cancel an already-cancelled booking', async () => {
    const { deps, wa, wix } = makeDeps({
      reminder: { ...reminder, status: 'cancelled' },
    });
    await createReactionHandler(deps)(customerReaction('👎') as any);
    expect(wix.cancelBooking).not.toHaveBeenCalled();
    expect(wa.sendDirect).not.toHaveBeenCalled();
  });

  it('ignores a reaction from a phone with no active booking', async () => {
    const { deps, wa, reminders } = makeDeps({ reminder: null });
    await createReactionHandler(deps)(customerReaction('👍') as any);
    expect(reminders.setStatus).not.toHaveBeenCalled();
    // Notably: no unmanaged-number auto-reply for a bare reaction.
    expect(wa.sendDirect).not.toHaveBeenCalled();
  });

  it('ignores our own reactions', async () => {
    const { deps, reminders } = makeDeps();
    await createReactionHandler(deps)(customerReaction('👍', { fromMe: true }) as any);
    expect(reminders.findActiveForReply).not.toHaveBeenCalled();
    expect(reminders.setStatus).not.toHaveBeenCalled();
  });

  it('ignores a reaction removal (empty emoji)', async () => {
    const { deps, reminders } = makeDeps();
    await createReactionHandler(deps)(customerReaction('') as any);
    expect(reminders.setStatus).not.toHaveBeenCalled();
  });

  it('ignores a reaction on a message the customer sent themselves', async () => {
    const { deps, reminders } = makeDeps();
    await createReactionHandler(deps)(customerReaction('👍', { targetFromMe: false }) as any);
    expect(reminders.setStatus).not.toHaveBeenCalled();
  });

  it('ignores reactions in unrelated tour groups', async () => {
    const { deps, reminders } = makeDeps();
    await createReactionHandler(deps)(
      customerReaction('👍', { chatId: '999@g.us', senderId: '972544211402@c.us' }) as any,
    );
    expect(reminders.setStatus).not.toHaveBeenCalled();
  });

  it('skips the manager notification when no notify phone is configured', async () => {
    const { deps, wa } = makeDeps({ notifyPhone: undefined });
    await createReactionHandler(deps)(customerReaction('👍') as any);
    const toManager = (wa.sendDirect as any).mock.calls.filter((c: any[]) => c[0] === NOTIFY_PHONE);
    expect(toManager.length).toBe(0);
    // Customer ack still goes out.
    expect(wa.sendDirect).toHaveBeenCalledWith('+972544211402', 'ACK דנה 3');
  });

  it('still confirms the booking if the manager notification fails', async () => {
    const { deps, wa, reminders } = makeDeps();
    wa.sendDirect.mockImplementation(async (phone: string) => {
      if (phone === NOTIFY_PHONE) throw new Error('send failed');
      return { messageId: 'm' };
    });
    await createReactionHandler(deps)(customerReaction('👍') as any);
    expect(reminders.setStatus).toHaveBeenCalledWith('b1', 'confirmed', expect.anything());
  });

  it('resolves an @lid sender through the client', async () => {
    const { deps, wa, reminders } = makeDeps();
    wa.resolveParticipantPhone.mockResolvedValue('+972544211402' as any);
    await createReactionHandler(deps)(
      customerReaction('👍', { chatId: '221616084627681@lid', senderId: '221616084627681@lid' }) as any,
    );
    expect(wa.resolveParticipantPhone).toHaveBeenCalledWith('221616084627681@lid');
    expect(reminders.setStatus).toHaveBeenCalledWith('b1', 'confirmed', expect.anything());
  });
});

describe('reactionHandler — staff 👍 on a worker-group draft (existing behaviour)', () => {
  const workerReaction = {
    targetMessageId: 'gmsg-1',
    reaction: '👍',
    chatId: WORKER_GROUP,
    senderId: '34600111222@c.us',
    timestamp: 0,
    fromMe: false,
    targetFromMe: true,
  };

  it('sends the suggested reply to the customer and marks it sent', async () => {
    const { deps, wa, workerForwards } = makeDeps({
      forward: {
        status: 'pending',
        suggestedReply: 'DRAFT',
        phone: '+972544211402',
        clientName: 'דנה',
        bookingId: 'b1',
      },
    });
    await createReactionHandler(deps)(workerReaction as any);
    expect(wa.sendDirect).toHaveBeenCalledWith('+972544211402', 'DRAFT');
    expect(workerForwards.markSent).toHaveBeenCalledWith('gmsg-1');
  });

  it('does not treat a staff 👍 as a customer confirmation', async () => {
    const { deps, reminders } = makeDeps({
      forward: {
        status: 'pending',
        suggestedReply: 'DRAFT',
        phone: '+972544211402',
        clientName: 'דנה',
        bookingId: 'b1',
      },
    });
    await createReactionHandler(deps)(workerReaction as any);
    expect(reminders.setStatus).not.toHaveBeenCalled();
  });

  it('ignores a non-👍 reaction in the worker group', async () => {
    const { deps, wa } = makeDeps({
      forward: { status: 'pending', suggestedReply: 'DRAFT', phone: '+9725', bookingId: 'b1' },
    });
    await createReactionHandler(deps)({ ...workerReaction, reaction: '❤️' } as any);
    expect(wa.sendDirect).not.toHaveBeenCalled();
  });

  it('still resolves a draft when chatId arrives empty', async () => {
    // The reaction payload's nested key objects aren't always populated; the
    // workerForwards lookup is keyed by a message id we recorded ourselves.
    const { deps, wa } = makeDeps({
      forward: {
        status: 'pending',
        suggestedReply: 'DRAFT',
        phone: '+972544211402',
        bookingId: 'b1',
      },
    });
    await createReactionHandler(deps)({ ...workerReaction, chatId: '' } as any);
    expect(wa.sendDirect).toHaveBeenCalledWith('+972544211402', 'DRAFT');
  });

  it('ignores a duplicate 👍 on an already-sent draft', async () => {
    const { deps, wa } = makeDeps({
      forward: { status: 'sent', suggestedReply: 'DRAFT', phone: '+9725', bookingId: 'b1' },
    });
    await createReactionHandler(deps)(workerReaction as any);
    expect(wa.sendDirect).not.toHaveBeenCalled();
  });
});
