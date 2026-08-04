import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db.js';
import { PrivateTourEventsStore, type PrivateTourEventRow } from '../../src/persistence/privateTourEvents.js';
import { PrivateTourNotificationsStore } from '../../src/persistence/privateTourNotifications.js';
import { createPrivateTourNotifyRunner } from '../../src/jobs/privateTourNotifyRunner.js';
import type { WhatsAppClient } from '../../src/whatsapp/types.js';
import type { GuidesConfig, TemplatesConfig, ToursConfig } from '../../src/config/schemas.js';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) if (fs.existsSync(f)) fs.unlinkSync(f);
  tmpFiles.length = 0;
});
function tmpDbPath(): string {
  const p = path.join(os.tmpdir(), `wabot-ptn-${Date.now()}-${Math.random()}.sqlite`);
  tmpFiles.push(p);
  return p;
}

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as any;

const templates: TemplatesConfig = {
  night_header: '',
  morning_header: '',
  footer: '',
  tour_block: '',
  booking_confirmation: '',
  booking_confirmation_lt24h: '',
  reminder_24h: '',
  confirmation_ack: '',
  confirmation_update_ack: '',
  cancel_ack: '',
  anti_reply_footer: '',
  unmanaged_number_reply: '',
  no_reply_alert: '',
  worker_forward: '',
  cancel_notice: '',
  private_tour_guide_reminder:
    'היי {guide_name} 👋\n🚩 *{tour_name}*\n🕒 {time}\n👤 {client_name} ({people_count})\n📞 {client_phone}\n{meeting_point_line}',
  private_tour_missing_info_block: '\n⚠️ חסרים פרטים:\n{missing_fields_list}',
};

const guides: GuidesConfig = {
  guides: [
    { name: 'ליאנה', phone: '+34651886491', active: true },
    { name: 'אדיר', phone: '+34604397498', active: true },
  ],
};

const tours: ToursConfig = { tours: {} };

interface Sent {
  kind: 'direct' | 'group';
  to: string;
  body: string;
}

function baseEvent(overrides: Partial<PrivateTourEventRow> = {}): Omit<PrivateTourEventRow, 'parsedAt' | 'updatedAt'> {
  return {
    eventId: 'evt-1',
    contentHash: 'h',
    startAtIso: '2026-07-15T08:00:00.000Z', // "tomorrow" relative to the fixed now below
    endAtIso: '2026-07-15T11:00:00.000Z',
    rawSummary: 'סיור גאודי פרטי. דנה. 5 אנשים. מדריך אדיר',
    rawDescription: null,
    rawLocation: null,
    tourName: 'גותי', // resolves via the real keyword table but has no fixture meeting point
    guide: 'אדיר',
    clientName: 'דנה',
    peopleCount: '5',
    phone: '+972544211402',
    email: null,
    meetingPoint: 'Some Explicit Hotel',
    ...overrides,
  };
}

function makeDeps(
  events: Array<Omit<PrivateTourEventRow, 'parsedAt' | 'updatedAt'>>,
  overrides: Partial<Parameters<typeof createPrivateTourNotifyRunner>[0]> = {},
) {
  const sent: Sent[] = [];
  const wa: Partial<WhatsAppClient> = {
    sendDirect: async (phone, body) => {
      sent.push({ kind: 'direct', to: phone, body });
      return { messageId: `dm-${sent.length}` };
    },
    sendToGroup: async (gid, body) => {
      sent.push({ kind: 'group', to: gid, body });
      return { messageId: `g-${sent.length}` };
    },
  };
  const db = openDatabase(tmpDbPath());
  const store = new PrivateTourEventsStore(db);
  for (const e of events) store.upsert(e);
  const notifyStore = new PrivateTourNotificationsStore(db);

  const runner = createPrivateTourNotifyRunner({
    wa: wa as WhatsAppClient,
    store,
    notifyStore,
    logger: noopLogger,
    config: () => ({ guides, templates, tours }),
    settings: {
      sendTime: '18:30',
      pollIntervalSeconds: 60,
      testMode: false,
      managerGuideName: 'ליאנה',
    },
    timezone: 'Europe/Madrid',
    isPaused: () => false,
    isConnected: () => true,
    // "now" = 2026-07-14T18:00:00Z = 20:00 local (Europe/Madrid, UTC+2, July) —
    // past the 18:30 send_time, with "tomorrow" (local) = 2026-07-15.
    now: () => new Date('2026-07-14T18:00:00.000Z'),
    ...overrides,
  });
  return { runner, sent, store, notifyStore };
}

describe('privateTourNotifyRunner.tick', () => {
  it('sends to both the assigned guide and the manager when they differ', async () => {
    const { runner, sent } = makeDeps([baseEvent()]);
    const stats = await runner.tick();
    expect(stats.sent).toBe(1);
    expect(sent).toHaveLength(2);
    const recipients = sent.map((s) => s.to).sort();
    expect(recipients).toEqual(['+34604397498', '+34651886491'].sort()); // אדיר, ליאנה
  });

  it('collapses to a single send when the assigned guide IS the manager', async () => {
    const { runner, sent } = makeDeps([baseEvent({ guide: 'ליאנה' })]);
    const stats = await runner.tick();
    expect(stats.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('+34651886491');
  });

  it("that single combined send includes the manager's missing-info addendum when something is missing", async () => {
    const { runner, sent } = makeDeps([baseEvent({ guide: 'ליאנה', phone: null })]);
    await runner.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('חסרים פרטים');
    expect(sent[0]!.body).toContain('לא נמצא מספר טלפון');
  });

  it("the guide's own copy never contains the missing-info addendum, even if info is missing", async () => {
    const { runner, sent } = makeDeps([baseEvent({ phone: null })]); // guide=אדיר, manager=ליאנה, distinct
    await runner.tick();
    expect(sent).toHaveLength(2);
    const guideMsg = sent.find((s) => s.to === '+34604397498')!;
    const managerMsg = sent.find((s) => s.to === '+34651886491')!;
    expect(guideMsg.body).not.toContain('חסרים פרטים');
    expect(managerMsg.body).toContain('חסרים פרטים');
  });

  it('dedupes: does not send twice for the same event', async () => {
    const { runner, sent } = makeDeps([baseEvent()]);
    await runner.tick();
    const stats2 = await runner.tick();
    expect(stats2.due).toBe(0);
    expect(sent).toHaveLength(2); // unchanged from the first tick
  });

  it('a tick already in flight blocks an overlapping tick from double-sending (regression: 2026-07-22 duplicate private-tour reminder to guide אדיר)', async () => {
    // notifyStore.record() only marks the event handled AFTER all its sends
    // resolve — simulate a slow send (e.g. the humanized typing delay + shared
    // send queue) so a second tick() call, fired before the first resolves,
    // would have seen wasHandled()===false and sent again without the guard.
    let resolveSend: (() => void) | null = null;
    const sent: Sent[] = [];
    const wa: Partial<WhatsAppClient> = {
      sendDirect: async (phone, body) => {
        await new Promise<void>((resolve) => {
          resolveSend = resolve;
        });
        sent.push({ kind: 'direct', to: phone, body });
        return { messageId: `dm-${sent.length}` };
      },
      sendToGroup: async () => ({ messageId: 'g' }),
    };
    const db = openDatabase(tmpDbPath());
    const store = new PrivateTourEventsStore(db);
    store.upsert(baseEvent({ guide: 'ליאנה' })); // single recipient keeps the test to one send
    const notifyStore = new PrivateTourNotificationsStore(db);
    const runner = createPrivateTourNotifyRunner({
      wa: wa as WhatsAppClient,
      store,
      notifyStore,
      logger: noopLogger,
      config: () => ({ guides, templates, tours }),
      settings: { sendTime: '18:30', pollIntervalSeconds: 60, testMode: false, managerGuideName: 'ליאנה' },
      timezone: 'Europe/Madrid',
      isPaused: () => false,
      isConnected: () => true,
      now: () => new Date('2026-07-14T18:00:00.000Z'),
    });

    const firstTick = runner.tick();
    // Second tick fires while the first send is still awaiting resolveSend.
    const secondStats = await runner.tick();
    expect(secondStats).toEqual({ due: 0, sent: 0, skipped: 0, failed: 0 });
    resolveSend!();
    const firstStats = await firstTick;
    expect(firstStats.sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('records a skip (no send) when neither guide nor manager phone resolves', async () => {
    const { runner, sent, notifyStore } = makeDeps([baseEvent({ guide: 'לא קיים' })], {
      settings: {
        sendTime: '18:30',
        pollIntervalSeconds: 60,
        testMode: false,
        managerGuideName: 'לא קיימת גם',
      },
    });
    const stats = await runner.tick();
    expect(stats.skipped).toBe(1);
    expect(sent).toHaveLength(0);
    expect(notifyStore.wasHandled('evt-1')).toBe(true);
  });

  it('does not fire before send_time', async () => {
    const { runner, sent } = makeDeps([baseEvent()], {
      now: () => new Date('2026-07-14T14:00:00.000Z'), // 16:00 local < 18:30
    });
    const stats = await runner.tick();
    expect(stats.due).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('ignores events not happening tomorrow (local date)', async () => {
    const { runner, sent } = makeDeps([baseEvent({ startAtIso: '2026-07-20T08:00:00.000Z', endAtIso: '2026-07-20T11:00:00.000Z' })]);
    const stats = await runner.tick();
    expect(stats.due).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('routes to the test group when test_mode is on', async () => {
    const { runner, sent } = makeDeps([baseEvent()], {
      settings: {
        sendTime: '18:30',
        pollIntervalSeconds: 60,
        testMode: true,
        testGroupId: '120363425214664727@g.us',
        managerGuideName: 'ליאנה',
      },
    });
    await runner.tick();
    expect(sent).toHaveLength(2);
    expect(sent.every((s) => s.kind === 'group' && s.to === '120363425214664727@g.us')).toBe(true);
  });
});
