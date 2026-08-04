import { describe, it, expect, vi } from 'vitest';
import { createReplyHandler } from '../../src/reminders/replyHandler.js';

/**
 * The manager notification is shared by the text-reply path and the reaction
 * path (reminders/bookingResponse.ts). These tests cover the text side; the
 * reaction side lives in reactionHandler.test.ts.
 */

const NOTIFY_PHONE = '+34623964800';
const WORKER_GROUP = '120@g.us';

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
  confirmation_ack: 'ACK {participant_count}',
  confirmation_update_ack: 'UPDATE {participant_count}',
  cancel_ack: 'CANCEL-ACK',
  cancel_notice: 'CANCEL-NOTICE {wix_status}',
  unmanaged_number_reply: 'AUTO-REPLY',
  worker_forward: 'FORWARD {message}',
  client_response_notice:
    'NOTICE {status_emoji} {status_text} {client_name} {phone} {tour_name_he} {date} {time} {participant_count} {via_text}',
};

function makeDeps(cls: any, over: any = {}) {
  const wa = {
    sendDirect: vi.fn(async () => ({ messageId: 'm' })),
    sendToGroup: vi.fn(async () => ({ messageId: 'g' })),
    forwardMessage: vi.fn(async () => ({ messageId: 'f' })),
  };
  const wix = {
    cancelBooking: vi.fn(async () => ({ ok: true })),
    updateNumberOfParticipants: vi.fn(async () => ({ ok: true })),
  };
  const deps: any = {
    wa,
    wix,
    reminders: {
      findActiveForReply: vi.fn(() => ('reminder' in over ? over.reminder : reminder)),
      setStatus: vi.fn(),
    },
    audit: { record: vi.fn() },
    workerForwards: { insert: vi.fn() },
    classifier: { classify: vi.fn(async () => cls) },
    drafter: null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      officialContactNumber: '+34600000000',
      workerGroupId: WORKER_GROUP,
      confidenceThreshold: 0.7,
      debounceSeconds: 0,
      clientResponseNotifyPhone:
        'notifyPhone' in over ? over.notifyPhone : NOTIFY_PHONE,
    },
    config: () => ({ templates, tours: { tours: {} } }),
  };
  return { deps, wa, wix };
}

const dm = {
  messageId: 'x1',
  fromPhoneE164: '+972544211402',
  body: 'מאשרת',
  timestamp: 0,
  type: 'chat',
  hasMedia: false,
};

function managerCall(wa: any) {
  return (wa.sendDirect as any).mock.calls.find((c: any[]) => c[0] === NOTIFY_PHONE);
}

describe('manager notification on a text confirm', () => {
  it('includes client name+phone, tour name+hour, status text and emoji', async () => {
    const { deps, wa } = makeDeps({ intent: 'confirm', participantCount: null, confidence: 0.95 });
    await createReplyHandler(deps)(dm as any);

    const call = managerCall(wa);
    expect(call, 'manager should be DMed on confirm').toBeDefined();
    const body = call[1];
    expect(body).toContain('✅');
    expect(body).toContain('אישר/ה הגעה');
    expect(body).toContain('דנה');
    expect(body).toContain('+972544211402');
    expect(body).toContain('סיור גאודי');
    expect(body).toContain('02/01/99'); // date, Europe/Madrid
    expect(body).toContain('10:00'); // 09:00Z → 10:00 Madrid
    expect(body).toContain('3'); // participant count
    expect(body).toContain('הודעת טקסט'); // arrived as text, not a reaction
  });

  it('reports the updated count when the customer changes it', async () => {
    const { deps, wa } = makeDeps({ intent: 'update_count', participantCount: 5, confidence: 0.95 });
    await createReplyHandler(deps)({ ...dm, body: 'נהיינו 5' } as any);
    expect(managerCall(wa)[1]).toContain('5');
  });
});

describe('manager notification on a text cancel', () => {
  it('reports the cancellation with the ❌ emoji', async () => {
    const { deps, wa } = makeDeps({ intent: 'cancel', participantCount: null, confidence: 0.95 });
    await createReplyHandler(deps)({ ...dm, body: 'מבטלת' } as any);

    const body = managerCall(wa)[1];
    expect(body).toContain('❌');
    expect(body).toContain('ביטל/ה הגעה');
    expect(body).toContain('דנה');
    expect(body).toContain('הודעת טקסט');
  });
});

describe('manager notification is not sent for non-decisions', () => {
  it('no notice for an off-topic message forwarded to staff', async () => {
    const { deps, wa } = makeDeps({ intent: 'other', participantCount: null, confidence: 0.95 });
    await createReplyHandler(deps)({ ...dm, body: 'מה השעה?' } as any);
    expect(managerCall(wa)).toBeUndefined();
  });

  it('no notice for a low-confidence classification', async () => {
    const { deps, wa } = makeDeps({ intent: 'confirm', participantCount: null, confidence: 0.2 });
    await createReplyHandler(deps)(dm as any);
    expect(managerCall(wa)).toBeUndefined();
  });

  it('no notice for a message from a number with no active booking', async () => {
    const { deps, wa } = makeDeps(
      { intent: 'confirm', participantCount: null, confidence: 0.95 },
      { reminder: null },
    );
    await createReplyHandler(deps)(dm as any);
    expect(managerCall(wa)).toBeUndefined();
  });

  it('no notice for a duplicate confirm on an already-confirmed booking', async () => {
    const { deps, wa } = makeDeps(
      { intent: 'confirm', participantCount: null, confidence: 0.95 },
      { reminder: { ...reminder, status: 'confirmed' } },
    );
    await createReplyHandler(deps)(dm as any);
    expect(managerCall(wa)).toBeUndefined();
  });
});

describe('manager notification is optional', () => {
  it('confirms normally when no notify phone is configured', async () => {
    const { deps, wa } = makeDeps(
      { intent: 'confirm', participantCount: null, confidence: 0.95 },
      { notifyPhone: undefined },
    );
    await createReplyHandler(deps)(dm as any);
    expect(managerCall(wa)).toBeUndefined();
    // Customer ack still goes out.
    expect(wa.sendDirect).toHaveBeenCalledWith('+972544211402', 'ACK 3');
  });

  it('picks up a notify phone added by a config reload after startup', async () => {
    // Regression: index.ts built `settings` as a plain literal, so a phone
    // hot-added to the volume overlay and reloaded never reached the handler —
    // notifyClientResponse returned at its `if (!phone)` guard and confirmations
    // went unannounced. `settings` now exposes getters over the reassignable
    // config binding; this mirrors that shape.
    let livePhone: string | undefined = undefined;
    const { deps, wa } = makeDeps(
      { intent: 'confirm', participantCount: null, confidence: 0.95 },
      { notifyPhone: undefined },
    );
    Object.defineProperty(deps.settings, 'clientResponseNotifyPhone', {
      get: () => livePhone,
      configurable: true,
    });

    // Before the reload: nothing configured, so no manager DM.
    await createReplyHandler(deps)(dm as any);
    expect(managerCall(wa)).toBeUndefined();

    // Operator pushes the overlay and hits /admin/api/config/reload.
    livePhone = NOTIFY_PHONE;
    await createReplyHandler(deps)(dm as any);
    expect(managerCall(wa), 'reloaded phone must be picked up').toBeDefined();
  });

  it('still confirms when the manager DM fails', async () => {
    const { deps, wa } = makeDeps({ intent: 'confirm', participantCount: null, confidence: 0.95 });
    wa.sendDirect.mockImplementation(async (phone: string) => {
      if (phone === NOTIFY_PHONE) throw new Error('send failed');
      return { messageId: 'm' };
    });
    await createReplyHandler(deps)(dm as any);
    expect(deps.reminders.setStatus).toHaveBeenCalledWith('b1', 'confirmed', expect.anything());
  });
});
