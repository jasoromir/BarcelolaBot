import { describe, it, expect, vi } from 'vitest';
import { GroupAdminService } from '../../src/whatsapp/groupAdmin.js';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types.js';

function fakeClient(overrides?: Partial<WhatsAppClient>): WhatsAppClient {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    state: () => ({ kind: 'connected', phone: '+1' }),
    onStateChange: vi.fn(),
    sendToGroup: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    sendDirect: vi.fn(async () => ({ messageId: 'x' }) as SendResult),
    isGroupAdmin: vi.fn(async () => true),
    setGroupMessagesAdminsOnly: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('GroupAdminService.verifyAdminAll', () => {
  it('returns admin groups and non-admin groups', async () => {
    const c = fakeClient({
      isGroupAdmin: vi.fn(async (id: string) => id === 'g1@g.us'),
    });
    const svc = new GroupAdminService(c);
    const result = await svc.verifyAdminAll(['g1@g.us', 'g2@g.us']);
    expect(result.admin).toEqual(['g1@g.us']);
    expect(result.notAdmin).toEqual(['g2@g.us']);
  });
});

describe('GroupAdminService.closeAll', () => {
  it('calls setGroupMessagesAdminsOnly(true) per group', async () => {
    const fn = vi.fn(async () => {});
    const c = fakeClient({ setGroupMessagesAdminsOnly: fn });
    await new GroupAdminService(c).closeAll(['g1@g.us', 'g2@g.us']);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, 'g1@g.us', true);
    expect(fn).toHaveBeenNthCalledWith(2, 'g2@g.us', true);
  });

  it('continues on per-group failure and reports ok/failed', async () => {
    const fn = vi.fn(async (id: string) => {
      if (id === 'g1@g.us') throw new Error('boom');
    });
    const c = fakeClient({ setGroupMessagesAdminsOnly: fn });
    const result = await new GroupAdminService(c).closeAll(['g1@g.us', 'g2@g.us']);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.ok).toEqual(['g2@g.us']);
    expect(result.failed).toEqual([{ groupId: 'g1@g.us', error: 'boom' }]);
  });
});
