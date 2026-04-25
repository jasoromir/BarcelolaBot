import { describe, it, expect, vi } from 'vitest';
import { Broadcaster, type BroadcastResult } from '../../src/messaging/broadcaster.js';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types.js';

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

describe('Broadcaster.send', () => {
  it('sends to each group in order and reports success counts', async () => {
    const client = fakeClient();
    const b = new Broadcaster(client, { interMessageDelayMs: 0, retry: { attempts: 1, backoffMs: [] } });
    const res: BroadcastResult = await b.send('hello', ['g1@g.us', 'g2@g.us']);
    expect(res.sent).toBe(2);
    expect(res.failed).toHaveLength(0);
    expect(client.sendToGroup).toHaveBeenCalledTimes(2);
  });

  it('records failures without aborting the batch', async () => {
    let i = 0;
    const client = fakeClient({
      sendToGroup: vi.fn(async () => {
        i++;
        if (i === 1) throw new Error('bad');
        return { messageId: 'x' };
      }),
    });
    const b = new Broadcaster(client, { interMessageDelayMs: 0, retry: { attempts: 1, backoffMs: [] } });
    const res = await b.send('hello', ['g1@g.us', 'g2@g.us']);
    expect(res.sent).toBe(1);
    expect(res.failed).toEqual([{ groupId: 'g1@g.us', error: 'bad' }]);
  });
});
