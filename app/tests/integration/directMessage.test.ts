import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db.js';
import { PendingDms } from '../../src/persistence/pendingDms.js';
import { DirectMessageSender } from '../../src/messaging/directMessage.js';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types.js';
import type { AllowlistConfig } from '../../src/config/schemas.js';

function fakeClient(partial: Partial<WhatsAppClient> = {}): WhatsAppClient {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    state: () => ({ kind: 'connected', phone: '+1' }),
    onStateChange: vi.fn(),
    sendToGroup: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    sendDirect: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    isGroupAdmin: vi.fn(async () => true),
    setGroupMessagesAdminsOnly: vi.fn(async () => {}),
    ...partial,
  };
}

function freshQueue() {
  const db = openDatabase(path.join(os.tmpdir(), `wabot-dm-${Date.now()}-${Math.random()}.sqlite`));
  return new PendingDms(db);
}

const openCfg: AllowlistConfig = {
  mode: 'open',
  explicit_phones: [],
  rule: { country_codes: [] },
};
const explicitCfg: AllowlistConfig = {
  mode: 'explicit',
  explicit_phones: ['+972501234567'],
  rule: { country_codes: [] },
};

describe('DirectMessageSender.send', () => {
  it('sends when connected and allowlisted', async () => {
    const client = fakeClient();
    const sender = new DirectMessageSender({
      client,
      pendingDms: freshQueue(),
      allowlist: () => openCfg,
      retry: { attempts: 1, backoffMs: [] },
    });
    const r = await sender.send({ phone: '+1', body: 'hi' });
    expect(r.outcome).toBe('sent');
    expect(client.sendDirect).toHaveBeenCalledOnce();
  });

  it('returns skipped_allowlist when phone not allowed', async () => {
    const client = fakeClient();
    const sender = new DirectMessageSender({
      client,
      pendingDms: freshQueue(),
      allowlist: () => explicitCfg,
      retry: { attempts: 1, backoffMs: [] },
    });
    const r = await sender.send({ phone: '+1234567890', body: 'hi' });
    expect(r.outcome).toBe('skipped_allowlist');
    expect(client.sendDirect).not.toHaveBeenCalled();
  });

  it('enqueues when disconnected', async () => {
    const client = fakeClient({ state: () => ({ kind: 'disconnected' }) });
    const q = freshQueue();
    const sender = new DirectMessageSender({
      client,
      pendingDms: q,
      allowlist: () => openCfg,
      retry: { attempts: 1, backoffMs: [] },
    });
    const r = await sender.send({ phone: '+1', body: 'hi', bookingId: 'b1' });
    expect(r.outcome).toBe('deferred');
    expect(q.pending()).toHaveLength(1);
  });

  it('holds a first-contact send while the new-chat restriction is active', async () => {
    const client = fakeClient();
    const q = freshQueue();
    const sender = new DirectMessageSender({
      client,
      pendingDms: q,
      allowlist: () => openCfg,
      retry: { attempts: 1, backoffMs: [] },
      isNewContactRestricted: () => true,
      hasConfirmedDelivery: () => false,
    });
    const r = await sender.send({ phone: '+1', body: 'hi', bookingId: 'b1' });
    expect(r.outcome).toBe('deferred');
    expect(client.sendDirect).not.toHaveBeenCalled();
    expect(q.pending()).toHaveLength(1);
  });

  it('sends to an already-established contact even while the new-chat restriction is active', async () => {
    const client = fakeClient();
    const sender = new DirectMessageSender({
      client,
      pendingDms: freshQueue(),
      allowlist: () => openCfg,
      retry: { attempts: 1, backoffMs: [] },
      isNewContactRestricted: () => true,
      hasConfirmedDelivery: () => true,
    });
    const r = await sender.send({ phone: '+1', body: 'hi' });
    expect(r.outcome).toBe('sent');
    expect(client.sendDirect).toHaveBeenCalledOnce();
  });

  it('sends normally once the restriction is lifted', async () => {
    const client = fakeClient();
    const sender = new DirectMessageSender({
      client,
      pendingDms: freshQueue(),
      allowlist: () => openCfg,
      retry: { attempts: 1, backoffMs: [] },
      isNewContactRestricted: () => false,
      hasConfirmedDelivery: () => false,
    });
    const r = await sender.send({ phone: '+1', body: 'hi' });
    expect(r.outcome).toBe('sent');
  });
});

describe('DirectMessageSender.drainPending', () => {
  it('sends every queued item on success', async () => {
    const client = fakeClient();
    const q = freshQueue();
    q.enqueue({ phone: '+1', body: 'a' });
    q.enqueue({ phone: '+2', body: 'b' });
    const sender = new DirectMessageSender({
      client,
      pendingDms: q,
      allowlist: () => openCfg,
      retry: { attempts: 3, backoffMs: [100, 100] },
      drainInterItemDelayMs: 0,
    });
    const stats = await sender.drainPending();
    expect(stats).toEqual({ sent: 2, failed: 0, abandoned: 0 });
    expect(q.pending()).toHaveLength(0);
  });

  it('a single permanently-failing item does not block the rest of the backlog, and is not retried within the same sweep', async () => {
    const sendDirect = vi.fn(async (phone: string) => {
      if (phone === '+broken') throw new Error('No LID for user');
      return { messageId: 'x' } as SendResult;
    });
    const client = fakeClient({ sendDirect });
    const q = freshQueue();
    q.enqueue({ phone: '+broken', body: 'a' });
    q.enqueue({ phone: '+ok1', body: 'b' });
    q.enqueue({ phone: '+ok2', body: 'c' });
    const sender = new DirectMessageSender({
      client,
      pendingDms: q,
      allowlist: () => openCfg,
      // Even with a real production-like retry policy configured for live
      // sends, drainPending must not apply backoff — it does a single
      // attempt per item so one broken number can't stall the whole sweep.
      retry: { attempts: 3, backoffMs: [60_000, 300_000, 900_000] },
      drainInterItemDelayMs: 0,
    });
    const start = Date.now();
    const stats = await sender.drainPending();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(stats.sent).toBe(2);
    expect(stats.failed).toBe(1);
    // sendDirect called exactly once per item — no in-sweep retry/backoff.
    expect(sendDirect).toHaveBeenCalledTimes(3);
    const remaining = q.pending();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.phone).toBe('+broken');
    expect(remaining[0]!.attempts).toBe(1);
  });

  it('abandons an item once it hits maxDrainAttempts across repeated sweeps', async () => {
    const client = fakeClient({
      sendDirect: vi.fn(async () => {
        throw new Error('permanent failure');
      }),
    });
    const q = freshQueue();
    q.enqueue({ phone: '+broken', body: 'a' });
    const sender = new DirectMessageSender({
      client,
      pendingDms: q,
      allowlist: () => openCfg,
      retry: { attempts: 1, backoffMs: [] },
      maxDrainAttempts: 2,
      drainInterItemDelayMs: 0,
    });
    await sender.drainPending();
    expect(q.pending()).toHaveLength(1); // 1st failure: still pending
    await sender.drainPending();
    expect(q.pending()).toHaveLength(0); // 2nd failure hits the limit: abandoned
  });

  it('waits drainInterItemDelayMs between sends so a burst reconnect drain does not fire back-to-back (2026-07-20 instant-ban incident)', async () => {
    const client = fakeClient();
    const q = freshQueue();
    q.enqueue({ phone: '+1', body: 'a' });
    q.enqueue({ phone: '+2', body: 'b' });
    const sender = new DirectMessageSender({
      client,
      pendingDms: q,
      allowlist: () => openCfg,
      retry: { attempts: 1, backoffMs: [] },
      drainInterItemDelayMs: 50,
    });
    const start = Date.now();
    const stats = await sender.drainPending();
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
    expect(stats).toEqual({ sent: 2, failed: 0, abandoned: 0 });
  });
});
