import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db.js';
import { GuideNotificationsStore } from '../../src/persistence/guideNotifications.js';
import { createGuideNotifyRunner } from '../../src/jobs/guideNotifyRunner.js';
import type { GuideTourRoster } from '../../src/types.js';
import type { WhatsAppClient } from '../../src/whatsapp/types.js';
import type { WixClient } from '../../src/wix/types.js';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) if (fs.existsSync(f)) fs.unlinkSync(f);
  tmpFiles.length = 0;
});
function tmpDbPath(): string {
  const p = path.join(os.tmpdir(), `wabot-gn-${Date.now()}-${Math.random()}.sqlite`);
  tmpFiles.push(p);
  return p;
}

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

interface Sent {
  kind: 'direct' | 'group';
  to: string;
  body: string;
}

function makeDeps(rosters: GuideTourRoster[], overrides: Partial<Parameters<typeof createGuideNotifyRunner>[0]> = {}) {
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
    sendPollDirect: async (phone, question) => {
      sent.push({ kind: 'direct', to: phone, body: `[POLL] ${question}` });
      return { messageId: `poll-${sent.length}` };
    },
    sendPollToGroup: async (gid, question) => {
      sent.push({ kind: 'group', to: gid, body: `[POLL] ${question}` });
      return { messageId: `poll-${sent.length}` };
    },
  };
  const wix: Partial<WixClient> = {
    getGuideRostersForDate: async () => rosters,
  };
  const db = openDatabase(tmpDbPath());
  const store = new GuideNotificationsStore(db);

  const runner = createGuideNotifyRunner({
    wa: wa as WhatsAppClient,
    wix: wix as WixClient,
    store,
    logger: noopLogger,
    config: () => ({
      guides: { guides: [{ name: 'ליאנה', phone: '+34651886491', active: true }] },
      tours: { tours: {} },
    }),
    settings: { minutesBefore: 15, pollIntervalSeconds: 60, testMode: false },
    timezone: 'Europe/Madrid',
    isPaused: () => false,
    isConnected: () => true,
    // Fixed "now" = 10 minutes before the tour below.
    now: () => new Date('2026-07-02T14:50:00.000Z'),
    ...overrides,
  });
  return { runner, sent, store };
}

const rosterInWindow: GuideTourRoster = {
  serviceId: 'svc-1',
  eventId: 'evt-1',
  tourTitle: 'Born to be Wild',
  startAtIso: '2026-07-02T15:00:00.000Z', // 10 min after "now"
  startTimeLocal: '17:00',
  guideName: 'ליאנה',
  attendees: [{ name: 'רוני טל', phone: '+972549000073', participants: 2 }],
  totalParticipants: 2,
};

describe('guideNotifyRunner.tick', () => {
  it('sends the roster to the mapped guide when the tour is in the send window', async () => {
    const { runner, sent } = makeDeps([rosterInWindow]);
    const stats = await runner.tick();
    expect(stats.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe('direct');
    expect(sent[0]!.to).toBe('+34651886491');
    expect(sent[0]!.body).toContain('רוני טל');
  });

  it('does not send twice for the same tour (dedup)', async () => {
    const { runner, sent } = makeDeps([rosterInWindow]);
    await runner.tick();
    const stats2 = await runner.tick();
    expect(stats2.due).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('a tick already in flight blocks an overlapping tick from double-sending (regression: 2026-07-22 duplicate roster to guide אדיר)', async () => {
    // store.record() only marks the roster handled AFTER the send resolves —
    // simulate a slow send (e.g. the humanized typing delay + shared send
    // queue) so a second tick() call, fired before the first resolves, would
    // have seen wasHandled()===false and sent again without the guard.
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
    const wix: Partial<WixClient> = { getGuideRostersForDate: async () => [rosterInWindow] };
    const db = openDatabase(tmpDbPath());
    const store = new GuideNotificationsStore(db);
    const runner = createGuideNotifyRunner({
      wa: wa as WhatsAppClient,
      wix: wix as WixClient,
      store,
      logger: noopLogger,
      config: () => ({
        guides: { guides: [{ name: 'ליאנה', phone: '+34651886491', active: true }] },
        tours: { tours: {} },
      }),
      settings: { minutesBefore: 15, pollIntervalSeconds: 60, testMode: false },
      timezone: 'Europe/Madrid',
      isPaused: () => false,
      isConnected: () => true,
      now: () => new Date('2026-07-02T14:50:00.000Z'),
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

  it('skips (and records) a tour whose guide has no phone on file', async () => {
    const roster = { ...rosterInWindow, guideName: 'נעמי' };
    const { runner, sent, store } = makeDeps([roster]);
    const stats = await runner.tick();
    expect(stats.skipped).toBe(1);
    expect(sent).toHaveLength(0);
    expect(store.wasHandled('evt-1')).toBe(true);
  });

  it('ignores tours outside the 15-min window', async () => {
    const farTour = { ...rosterInWindow, startAtIso: '2026-07-02T16:00:00.000Z' };
    const { runner, sent } = makeDeps([farTour]);
    const stats = await runner.tick();
    expect(stats.due).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('picks up a guide phone change on the NEXT tick without recreating the runner (regression: config must be a live getter, not a startup snapshot)', async () => {
    // Two distinct tour occurrences, staggered so only rosterA is inside the
    // 15-min window on the first tick; rosterB enters the window only once
    // "now" advances on the second tick.
    const rosterA = { ...rosterInWindow, eventId: 'evt-a' };
    const rosterB = { ...rosterInWindow, eventId: 'evt-b', startAtIso: '2026-07-02T15:20:00.000Z' };
    let guidePhone = '+34651886491'; // old number
    let nowValue = new Date('2026-07-02T14:50:00.000Z');
    const sent: Sent[] = [];
    const wa: Partial<WhatsAppClient> = {
      sendDirect: async (phone, body) => {
        sent.push({ kind: 'direct', to: phone, body });
        return { messageId: `dm-${sent.length}` };
      },
      sendToGroup: async () => ({ messageId: 'g' }),
    };
    const wix: Partial<WixClient> = {
      getGuideRostersForDate: async () => [rosterA, rosterB],
    };
    const db = openDatabase(tmpDbPath());
    const store = new GuideNotificationsStore(db);
    const runner = createGuideNotifyRunner({
      wa: wa as WhatsAppClient,
      wix: wix as WixClient,
      store,
      logger: noopLogger,
      // Live getter reading a mutable outer variable — simulates index.ts's
      // `config: () => ({ guides: config.guides, ... })` closing over the
      // reassignable `config` binding that reloadConfig() replaces.
      config: () => ({
        guides: { guides: [{ name: 'ליאנה', phone: guidePhone, active: true }] },
        tours: { tours: {} },
      }),
      settings: { minutesBefore: 15, pollIntervalSeconds: 60, testMode: false },
      timezone: 'Europe/Madrid',
      isPaused: () => false,
      isConnected: () => true,
      now: () => nowValue,
    });

    await runner.tick(); // only evt-a is due; sends to the OLD number
    guidePhone = '+34623964800'; // simulate an /admin/api/config/reload after a guides.yaml edit
    nowValue = new Date('2026-07-02T15:10:00.000Z'); // now evt-b enters the window
    await runner.tick(); // sends evt-b — must use the NEW number

    expect(sent).toHaveLength(2);
    expect(sent[0]!.to).toBe('+34651886491');
    expect(sent[1]!.to).toBe('+34623964800');
  });

  it('routes to the test group when test_mode is on, regardless of guide phone', async () => {
    const roster = { ...rosterInWindow, guideName: 'נעמי' }; // no phone mapping
    const { runner, sent } = makeDeps([roster], {
      settings: {
        minutesBefore: 15,
        pollIntervalSeconds: 60,
        testMode: true,
        testGroupId: '120363425214664727@g.us',
      },
    });
    const stats = await runner.tick();
    expect(stats.sent).toBe(1);
    expect(sent[0]!.kind).toBe('group');
    expect(sent[0]!.to).toBe('120363425214664727@g.us');
  });

  it('sends the checklist poll right after the roster when enabled', async () => {
    const { runner, sent } = makeDeps([rosterInWindow], {
      settings: {
        minutesBefore: 15,
        pollIntervalSeconds: 60,
        testMode: false,
        checklistPoll: {
          enabled: true,
          question: '✅ צ׳ק ליסט',
          note: 'סמנו כל משימה',
          items: ['🕒 להגיע מוקדם', '📋 נוכחות ב-Wix', '📸 תמונה קבוצתית'],
        },
      },
    });
    await runner.tick();
    // roster DM, then the note DM, then the poll DM — all to the guide.
    expect(sent).toHaveLength(3);
    expect(sent[0]!.body).toContain('רוני טל'); // roster
    expect(sent[1]!.body).toContain('סמנו כל משימה'); // note
    expect(sent[2]!.body).toContain('[POLL] ✅ צ׳ק ליסט'); // poll
    expect(sent.every((s) => s.to === '+34651886491')).toBe(true);
  });

  it('sends the poll only to a guide on the checklist guide_names allowlist', async () => {
    const { runner, sent } = makeDeps([rosterInWindow], {
      settings: {
        minutesBefore: 15,
        pollIntervalSeconds: 60,
        testMode: false,
        checklistPoll: {
          enabled: true,
          question: '✅ צ׳ק ליסט',
          note: 'סמנו',
          items: ['🕒 מוקדם'],
          guideNames: ['ליאנה'], // rosterInWindow guide IS ליאנה
        },
      },
    });
    await runner.tick();
    // roster + note + poll = 3
    expect(sent).toHaveLength(3);
    expect(sent.some((s) => s.body.startsWith('[POLL]'))).toBe(true);
  });

  it('skips the poll (but still sends the roster) for a guide not on the allowlist', async () => {
    // Map עדי a phone so the roster sends; poll allowlist only has אדיר.
    const { runner, sent } = makeDeps([{ ...rosterInWindow, guideName: 'עדי' }], {
      config: () => ({
        guides: { guides: [{ name: 'עדי', phone: '+34669705817', active: true }] },
        tours: { tours: {} },
      }),
      settings: {
        minutesBefore: 15,
        pollIntervalSeconds: 60,
        testMode: false,
        checklistPoll: {
          enabled: true,
          question: '✅ צ׳ק ליסט',
          note: 'סמנו',
          items: ['🕒 מוקדם'],
          guideNames: ['אדיר'],
        },
      },
    });
    await runner.tick();
    // roster only — no note, no poll
    expect(sent).toHaveLength(1);
    expect(sent.some((s) => s.body.startsWith('[POLL]'))).toBe(false);
  });

  // Guides are exempt from the new-contact restriction (it only gates customer
  // DMs in DirectMessageSender). The runner no longer checks it.
});

// A tomorrow tour (relative to the fixed now 2026-07-02): ~24h out, so it never
// enters the pre-tour 15-min window — only the day-before pass acts on it.
const rosterTomorrow: GuideTourRoster = {
  serviceId: 'svc-1',
  eventId: 'evt-tomorrow',
  tourTitle: 'Born to be Wild',
  startAtIso: '2026-07-03T15:00:00.000Z',
  startTimeLocal: '17:00',
  guideName: 'ליאנה',
  attendees: [{ name: 'רוני טל', phone: '+972549000073', participants: 2 }],
  totalParticipants: 2,
};

// now = 2026-07-02T16:00:00Z → 18:00 local (Europe/Madrid, UTC+2), so a
// send_time of 18:00 has been reached.
const dayBeforeSettings = {
  minutesBefore: 15,
  pollIntervalSeconds: 60,
  testMode: false,
  dayBefore: { enabled: true, sendTime: '18:00', guideNames: ['ליאנה'] },
};

describe('guideNotifyRunner day-before pass', () => {
  it('sends a day-before reminder to an opted-in guide once send_time is reached', async () => {
    const { runner, sent } = makeDeps([rosterTomorrow], {
      settings: dayBeforeSettings,
      now: () => new Date('2026-07-02T16:00:00.000Z'),
    });
    const stats = await runner.tick();
    expect(stats.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('+34651886491');
    expect(sent[0]!.body).toContain('מחר');
    expect(sent[0]!.body).toContain('*2* משתתפים');
    // Not the per-client roster message.
    expect(sent[0]!.body).not.toContain('+972549000073');
  });

  it('does not send before send_time', async () => {
    const { runner, sent } = makeDeps([rosterTomorrow], {
      settings: dayBeforeSettings,
      now: () => new Date('2026-07-02T13:00:00.000Z'), // 15:00 local < 18:00
    });
    const stats = await runner.tick();
    expect(stats.due).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('does not send to a guide not on the day-before list', async () => {
    const { runner, sent } = makeDeps([{ ...rosterTomorrow, guideName: 'עדי' }], {
      settings: dayBeforeSettings,
      now: () => new Date('2026-07-02T16:00:00.000Z'),
    });
    const stats = await runner.tick();
    expect(stats.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('dedups the day-before reminder (fires once)', async () => {
    const { runner, sent } = makeDeps([rosterTomorrow], {
      settings: dayBeforeSettings,
      now: () => new Date('2026-07-02T16:00:00.000Z'),
    });
    await runner.tick();
    await runner.tick();
    expect(sent).toHaveLength(1);
  });
});
