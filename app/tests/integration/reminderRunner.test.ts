import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db.js';
import { RemindersStore } from '../../src/persistence/reminders.js';
import { createReminderRunner } from '../../src/reminders/runner.js';
import type { WhatsAppClient } from '../../src/whatsapp/types.js';
import type { WixClient } from '../../src/wix/types.js';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) if (fs.existsSync(f)) fs.unlinkSync(f);
  tmpFiles.length = 0;
});
function tmpDbPath(): string {
  const p = path.join(os.tmpdir(), `wabot-rr-${Date.now()}-${Math.random()}.sqlite`);
  tmpFiles.push(p);
  return p;
}

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

const templates = {
  reminder_24h: 'R24 {client_name}',
  anti_reply_footer: 'FTR {official_contact_number}',
} as any;

function makeRunner(overrides: Partial<Parameters<typeof createReminderRunner>[0]> = {}) {
  const sent: Array<{ phone: string; body: string }> = [];
  const wa: Partial<WhatsAppClient> = {
    sendDirect: async (phone, body) => {
      sent.push({ phone, body });
      return { messageId: `dm-${sent.length}` };
    },
  };
  const wix: Partial<WixClient> = {};
  const db = openDatabase(tmpDbPath());
  const reminders = new RemindersStore(db);

  const runner = createReminderRunner({
    wa: wa as WhatsAppClient,
    wix: wix as WixClient,
    reminders,
    logger: noopLogger,
    config: () => ({ templates, tours: { tours: {} } }),
    settings: {
      pollIntervalSeconds: 30,
      officialContactNumber: '+34623964800',
      workerGroupId: '120@g.us',
    },
    isPaused: () => false,
    isConnected: () => true,
    ...overrides,
  });
  return { runner, sent, reminders };
}

// reminderRunner.tick() reads real wall-clock time internally (`new
// Date().toISOString()`), so the fixture's send_at_iso must be relative to
// actual now, not a fixed test date.
const dueBooking = {
  bookingId: 'b1',
  orderIdEcom: null,
  phone: '+972500000001',
  clientName: 'Dana',
  tourId: null,
  tourNameHe: 'Gaudi',
  startAtIso: new Date(Date.now() + 24 * 3600_000).toISOString(),
  participantCount: 1,
  status: 'awaiting_send' as const,
  sendAtIso: new Date(Date.now() - 60_000).toISOString(),
  sentAtIso: null,
  lastReplyTs: null,
  welcomeDelivered: null,
};

describe('reminderRunner.tick', () => {
  it('sends a due reminder when welcomeDelivered is null (not yet checked)', async () => {
    const { runner, sent, reminders } = makeRunner();
    reminders.upsert(dueBooking);
    const stats = await runner.tick();
    expect(stats.sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('sends a due reminder when welcomeDelivered is true', async () => {
    const { runner, sent, reminders } = makeRunner();
    reminders.upsert(dueBooking);
    reminders.setWelcomeDelivered('b1', true);
    const stats = await runner.tick();
    expect(stats.sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('skips (does not send) when welcomeDelivered is false, and marks the row so it is not retried', async () => {
    const { runner, sent, reminders } = makeRunner();
    reminders.upsert(dueBooking);
    reminders.setWelcomeDelivered('b1', false);
    const stats = await runner.tick();
    expect(sent).toHaveLength(0);
    expect(stats.sent).toBe(0);
    const row = reminders.get('b1');
    expect(row?.status).toBe('skipped_undelivered_welcome');
    // Second tick shouldn't pick it up again (no longer 'awaiting_send').
    const stats2 = await runner.tick();
    expect(stats2.attempted).toBe(0);
  });

  it('passes the exact reminder message body through to notifyDelivery.confirmAndAnnounce', async () => {
    const confirmAndAnnounce = vi.fn(async () => ({ status: 'delivered' }));
    const { runner, sent, reminders } = makeRunner({ notifyDelivery: { confirmAndAnnounce } });
    reminders.upsert(dueBooking);
    await runner.tick();
    await new Promise((r) => setImmediate(r));
    expect(confirmAndAnnounce).toHaveBeenCalledOnce();
    const arg = confirmAndAnnounce.mock.calls[0][0];
    expect(arg.body).toBe(sent[0]!.body);
  });

  it('forwards the reminder to the guide instead of the client when isNewClientMessagingEnabled is false', async () => {
    const { runner, sent, reminders } = makeRunner({
      isNewClientMessagingEnabled: () => false,
      forwardToGuidePhone: () => '+34623964800',
    });
    reminders.upsert(dueBooking);
    const stats = await runner.tick();
    expect(stats.sent).toBe(0); // not sent to the client
    expect(sent).toHaveLength(2); // header + body, both to the guide
    expect(sent[0]!.phone).toBe('+34623964800');
    expect(sent[1]!.phone).toBe('+34623964800');
    expect(sent[1]!.body).toContain('Dana');
    // Still marked handled so it isn't retried every tick.
    const row = reminders.get('b1');
    expect(row?.sentAtIso).not.toBeNull();
  });

  it('does not touch the client (and sends nothing) when isNewClientMessagingEnabled is false and no guide phone resolves', async () => {
    const { runner, sent, reminders } = makeRunner({
      isNewClientMessagingEnabled: () => false,
      forwardToGuidePhone: () => null,
    });
    reminders.upsert(dueBooking);
    const stats = await runner.tick();
    expect(stats.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('waits between consecutive due reminders in the same tick (no burst), but not before the first one', async () => {
    const { runner, sent, reminders } = makeRunner({
      settings: {
        pollIntervalSeconds: 30,
        officialContactNumber: '+34623964800',
        workerGroupId: '120@g.us',
        interMessageDelayMinMs: 50,
        interMessageDelayMaxMs: 60,
      },
    });
    reminders.upsert({ ...dueBooking, bookingId: 'b1', phone: '+972500000001' });
    reminders.upsert({ ...dueBooking, bookingId: 'b2', phone: '+972500000002' });
    reminders.upsert({ ...dueBooking, bookingId: 'b3', phone: '+972500000003' });
    const start = Date.now();
    const stats = await runner.tick();
    const elapsed = Date.now() - start;
    expect(stats.sent).toBe(3);
    expect(sent).toHaveLength(3);
    // Two gaps (between item 1-2 and 2-3), each at least the configured min.
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it('does not delay before sending when only one reminder is due', async () => {
    const { runner, sent, reminders } = makeRunner({
      settings: {
        pollIntervalSeconds: 30,
        officialContactNumber: '+34623964800',
        workerGroupId: '120@g.us',
        interMessageDelayMinMs: 5_000,
        interMessageDelayMaxMs: 6_000,
      },
    });
    reminders.upsert(dueBooking);
    const start = Date.now();
    const stats = await runner.tick();
    const elapsed = Date.now() - start;
    expect(stats.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(elapsed).toBeLessThan(1_000);
  });
});
