import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db';
import { PendingDms } from '../../src/persistence/pendingDms';
import { DirectMessageSender } from '../../src/messaging/directMessage';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types';
import type { AllowlistConfig } from '../../src/config/schemas';

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
});
