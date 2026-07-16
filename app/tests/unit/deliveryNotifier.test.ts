import { describe, it, expect, vi } from 'vitest';
import { createDeliveryNotifier } from '../../src/messaging/deliveryNotifier.js';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types.js';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function client(partial: Partial<WhatsAppClient>): WhatsAppClient {
  return {
    sendToGroup: vi.fn(async () => ({ messageId: 'g' }) as SendResult),
    sendDirect: vi.fn(async () => ({ messageId: 'm' }) as SendResult),
    resolveNumberId: vi.fn(async () => '123@lid'),
    confirmDelivery: vi.fn(async () => 2),
    ...partial,
  } as unknown as WhatsAppClient;
}

const GROUP = '120@g.us';

describe('deliveryNotifier.sendAndAnnounce', () => {
  it('sends and posts a ✅ ping when delivery is confirmed (ack>=2)', async () => {
    const wa = client({ confirmDelivery: vi.fn(async () => 3) });
    const n = createDeliveryNotifier({ wa, logger: noopLogger, workerGroupId: GROUP });
    const res = await n.sendAndAnnounce({ phone: '+972500000000', body: 'hi', kind: 'welcome', name: 'Dana' });
    expect(res.status).toBe('delivered');
    expect(wa.sendDirect).toHaveBeenCalledWith('+972500000000', 'hi');
    const ping = (wa.sendToGroup as any).mock.calls[0];
    expect(ping[0]).toBe(GROUP);
    expect(ping[1]).toContain('✅ Sent welcome to Dana: +972500000000');
  });

  it('posts a ⚠️ warning when the number is unregistered and does NOT send', async () => {
    const wa = client({ resolveNumberId: vi.fn(async () => null) });
    const n = createDeliveryNotifier({ wa, logger: noopLogger, workerGroupId: GROUP });
    const res = await n.sendAndAnnounce({ phone: '+972511111111', body: 'hi', kind: 'welcome', name: 'Noa' });
    expect(res.status).toBe('unregistered');
    expect(wa.sendDirect).not.toHaveBeenCalled();
    const msg = (wa.sendToGroup as any).mock.calls[0][1];
    expect(msg).toContain('NOT DELIVERED');
    expect(msg).toContain('unregistered');
  });

  it('posts a ⚠️ warning when delivery never confirms even after the follow-up recheck (ack<2 both times)', async () => {
    const wa = client({ confirmDelivery: vi.fn(async () => 1) });
    const n = createDeliveryNotifier({
      wa, logger: noopLogger, workerGroupId: GROUP,
      followUpDelayMs: 0, followUpTimeoutMs: 0,
    });
    const res = await n.sendAndAnnounce({ phone: '+972522222222', body: 'hi', kind: 'reminder', name: 'Gil' });
    expect(res.status).toBe('not_delivered');
    const msg = (wa.sendToGroup as any).mock.calls[0][1];
    expect(msg).toContain('NOT DELIVERED');
    expect(msg).toContain('ack=1');
    expect(wa.confirmDelivery).toHaveBeenCalledTimes(2); // initial poll + one follow-up recheck
  });

  it('does NOT alert if ack=1 on the first poll but the follow-up recheck sees ack>=2 (delayed delivery, not a real failure)', async () => {
    const confirmDelivery = vi.fn()
      .mockResolvedValueOnce(1) // first poll: still in flight
      .mockResolvedValueOnce(2); // follow-up recheck: actually delivered
    const wa = client({ confirmDelivery });
    const n = createDeliveryNotifier({
      wa, logger: noopLogger, workerGroupId: GROUP,
      followUpDelayMs: 0, followUpTimeoutMs: 0,
    });
    const res = await n.sendAndAnnounce({ phone: '+972545205697', body: 'hi', kind: 'welcome + confirmation', name: 'Hodayah' });
    expect(res.status).toBe('delivered');
    const msg = (wa.sendToGroup as any).mock.calls[0][1];
    expect(msg).toContain('✅ Sent welcome + confirmation to Hodayah');
    expect(msg).not.toContain('NOT DELIVERED');
  });

  it('does NOT wait for a follow-up recheck on a hard failure (ack=-1) — reports immediately', async () => {
    const confirmDelivery = vi.fn(async () => -1);
    const wa = client({ confirmDelivery });
    const n = createDeliveryNotifier({ wa, logger: noopLogger, workerGroupId: GROUP });
    const res = await n.sendAndAnnounce({ phone: '+972500000009', body: 'hi', kind: 'welcome', name: 'Broken' });
    expect(res.status).toBe('not_delivered');
    expect(confirmDelivery).toHaveBeenCalledTimes(1); // no follow-up recheck for a hard -1
  });
});

describe('deliveryNotifier guide alert (on permanent failure)', () => {
  const GUIDE_PHONE = '+34623964800';

  it('DMs the guide with an alert + the client message body when the number is unregistered', async () => {
    const wa = client({ resolveNumberId: vi.fn(async () => null) });
    const n = createDeliveryNotifier({
      wa, logger: noopLogger, workerGroupId: GROUP,
      alertPhone: () => GUIDE_PHONE,
    });
    await n.sendAndAnnounce({ phone: '+972511111111', body: 'client message text', kind: 'welcome', name: 'Noa' });
    const calls = (wa.sendDirect as any).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe(GUIDE_PHONE);
    expect(calls[0][1]).toContain('Noa');
    expect(calls[1]).toEqual([GUIDE_PHONE, 'client message text']);
  });

  it('DMs the guide when the send itself throws', async () => {
    // 1st sendDirect call is the (failing) customer send; the 2nd and 3rd are
    // the guide-alert text + forwarded body, both of which must succeed even
    // though the customer send rejected.
    const wa = client({
      sendDirect: vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ messageId: 'a' })
        .mockResolvedValueOnce({ messageId: 'b' }),
    });
    const n = createDeliveryNotifier({
      wa, logger: noopLogger, workerGroupId: GROUP,
      alertPhone: () => GUIDE_PHONE,
    });
    const res = await n.sendAndAnnounce({ phone: '+972522222222', body: 'client message text', kind: 'welcome', name: 'Gil' });
    expect(res.status).toBe('error');
    expect(wa.sendDirect).toHaveBeenCalledTimes(3);
    expect((wa.sendDirect as any).mock.calls[2]).toEqual([GUIDE_PHONE, 'client message text']);
  });

  it('DMs the guide when delivery never confirms (not_delivered)', async () => {
    const wa = client({ confirmDelivery: vi.fn(async () => 1) });
    const n = createDeliveryNotifier({
      wa, logger: noopLogger, workerGroupId: GROUP,
      followUpDelayMs: 0, followUpTimeoutMs: 0,
      alertPhone: () => GUIDE_PHONE,
    });
    await n.sendAndAnnounce({ phone: '+972533333333', body: 'client message text', kind: 'reminder', name: 'Ron' });
    const guideCalls = (wa.sendDirect as any).mock.calls.filter((c: any[]) => c[0] === GUIDE_PHONE);
    expect(guideCalls).toHaveLength(2);
    expect(guideCalls[1][1]).toBe('client message text');
  });

  it('does NOT DM the guide when delivery succeeds', async () => {
    const wa = client({ confirmDelivery: vi.fn(async () => 2) });
    const n = createDeliveryNotifier({
      wa, logger: noopLogger, workerGroupId: GROUP,
      alertPhone: () => GUIDE_PHONE,
    });
    await n.sendAndAnnounce({ phone: '+972544444444', body: 'hi', kind: 'welcome', name: 'Tal' });
    // Only the one customer send — no guide alert.
    expect(wa.sendDirect).toHaveBeenCalledTimes(1);
  });

  it('is a no-op (no crash, no extra sends) when alertPhone is not configured', async () => {
    const wa = client({ resolveNumberId: vi.fn(async () => null) });
    const n = createDeliveryNotifier({ wa, logger: noopLogger, workerGroupId: GROUP });
    const res = await n.sendAndAnnounce({ phone: '+972555555555', body: 'hi', kind: 'welcome', name: 'Yael' });
    expect(res.status).toBe('unregistered');
    expect(wa.sendDirect).not.toHaveBeenCalled();
  });

  it('is a no-op when alertPhone resolves to null (e.g. guide not found in guides.yaml)', async () => {
    const wa = client({ resolveNumberId: vi.fn(async () => null) });
    const n = createDeliveryNotifier({
      wa, logger: noopLogger, workerGroupId: GROUP,
      alertPhone: () => null,
    });
    await n.sendAndAnnounce({ phone: '+972566666666', body: 'hi', kind: 'welcome', name: 'Omer' });
    expect(wa.sendDirect).not.toHaveBeenCalled();
  });

  it('confirmAndAnnounce DMs the guide with the body when provided and delivery fails', async () => {
    const wa = client({ confirmDelivery: vi.fn(async () => 1) });
    const n = createDeliveryNotifier({
      wa, logger: noopLogger, workerGroupId: GROUP,
      followUpDelayMs: 0, followUpTimeoutMs: 0,
      alertPhone: () => GUIDE_PHONE,
    });
    await n.confirmAndAnnounce({
      messageId: 'm3', phone: '+972577777777', kind: 'reminder', name: 'Shira', body: 'client message text',
    });
    const guideCalls = (wa.sendDirect as any).mock.calls.filter((c: any[]) => c[0] === GUIDE_PHONE);
    expect(guideCalls).toHaveLength(2);
    expect(guideCalls[1][1]).toBe('client message text');
  });

  it('confirmAndAnnounce does NOT DM the guide when body is omitted (backward compat)', async () => {
    const wa = client({ confirmDelivery: vi.fn(async () => 1) });
    const n = createDeliveryNotifier({
      wa, logger: noopLogger, workerGroupId: GROUP,
      followUpDelayMs: 0, followUpTimeoutMs: 0,
      alertPhone: () => GUIDE_PHONE,
    });
    await n.confirmAndAnnounce({ messageId: 'm4', phone: '+972588888888', kind: 'reminder', name: 'Doron' });
    expect(wa.sendDirect).not.toHaveBeenCalled();
  });
});

describe('deliveryNotifier.confirmAndAnnounce', () => {
  it('confirms an already-sent message and pings without re-sending', async () => {
    const wa = client({ confirmDelivery: vi.fn(async () => 2) });
    const n = createDeliveryNotifier({ wa, logger: noopLogger, workerGroupId: GROUP });
    const res = await n.confirmAndAnnounce({ messageId: 'm1', phone: '+972533333333', kind: 'welcome', name: 'Ari' });
    expect(res.status).toBe('delivered');
    expect(wa.sendDirect).not.toHaveBeenCalled();
    expect((wa.sendToGroup as any).mock.calls[0][1]).toContain('✅ Sent welcome to Ari');
  });

  it('also applies the follow-up recheck before declaring not_delivered', async () => {
    const confirmDelivery = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    const wa = client({ confirmDelivery });
    const n = createDeliveryNotifier({
      wa, logger: noopLogger, workerGroupId: GROUP,
      followUpDelayMs: 0, followUpTimeoutMs: 0,
    });
    const res = await n.confirmAndAnnounce({ messageId: 'm2', phone: '+972545205697', kind: 'welcome + confirmation', name: 'Hodayah' });
    expect(res.status).toBe('delivered');
  });
});
