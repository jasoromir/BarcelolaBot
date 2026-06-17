import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db.js';
import { ControlState } from '../../src/persistence/controlState.js';
import { createSessionMonitor } from '../../src/notify/sessionMonitor.js';
import type { Emailer, EmailMessage } from '../../src/notify/emailer.js';
import type { WhatsAppClient } from '../../src/whatsapp/types.js';
import type { WhatsAppState } from '../../src/types.js';
import type { AppLogger } from '../../src/log/logger.js';

const noopLogger: AppLogger = { info() {}, warn() {}, error() {} };

function store() {
  const db = openDatabase(
    path.join(os.tmpdir(), `wabot-sm-${Date.now()}-${Math.random()}.sqlite`),
  );
  return new ControlState(db);
}

function fakeWa(getState: () => WhatsAppState): WhatsAppClient {
  // Only state() is exercised by the monitor; the rest throw if misused.
  return { state: getState } as unknown as WhatsAppClient;
}

function capturingEmailer(): Emailer & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    enabled: true,
    sent,
    async send(msg: EmailMessage) {
      sent.push(msg);
      return true;
    },
  };
}

describe('sessionMonitor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends one reactive alert after the threshold, not before, and only once', async () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    let state: WhatsAppState = { kind: 'qr_pending', qrDataUrl: 'x' };
    const emailer = capturingEmailer();
    const mon = createSessionMonitor({
      whatsapp: fakeWa(() => state),
      emailer,
      store: store(),
      logger: noopLogger,
      settings: { reactiveAfterMinutes: 30, proactiveWarnAfterDays: 12 },
    });

    await mon.tick(); // t=0, starts the outage clock, no alert yet
    expect(emailer.sent).toHaveLength(0);

    vi.setSystemTime(new Date('2026-06-01T00:20:00Z')); // 20m < 30m
    await mon.tick();
    expect(emailer.sent).toHaveLength(0);

    vi.setSystemTime(new Date('2026-06-01T00:35:00Z')); // 35m >= 30m
    await mon.tick();
    expect(emailer.sent).toHaveLength(1);
    expect(emailer.sent[0]!.subject).toMatch(/disconnected/i);

    vi.setSystemTime(new Date('2026-06-01T01:00:00Z')); // still down — must not re-alert
    await mon.tick();
    expect(emailer.sent).toHaveLength(1);
  });

  it('re-arms the reactive alert after a reconnect', async () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    let state: WhatsAppState = { kind: 'disconnected' };
    const emailer = capturingEmailer();
    const st = store();
    const mon = createSessionMonitor({
      whatsapp: fakeWa(() => state),
      emailer,
      store: st,
      logger: noopLogger,
      settings: { reactiveAfterMinutes: 30, proactiveWarnAfterDays: 12 },
    });

    await mon.tick();
    vi.setSystemTime(new Date('2026-06-01T01:00:00Z'));
    await mon.tick(); // first outage alert
    expect(emailer.sent).toHaveLength(1);

    // reconnect
    state = { kind: 'connected', phone: '+34600000000' };
    await mon.tick();

    // drop again, advance past threshold
    state = { kind: 'disconnected' };
    await mon.tick(); // resets outage clock to now
    vi.setSystemTime(new Date('2026-06-01T02:00:00Z'));
    await mon.tick();
    expect(emailer.sent).toHaveLength(2);
  });

  it('sends one proactive warning once the streak exceeds the threshold', async () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    const state: WhatsAppState = { kind: 'connected', phone: '+34600000000' };
    const emailer = capturingEmailer();
    const mon = createSessionMonitor({
      whatsapp: fakeWa(() => state),
      emailer,
      store: store(),
      logger: noopLogger,
      settings: { reactiveAfterMinutes: 30, proactiveWarnAfterDays: 12 },
    });

    await mon.tick(); // streak begins
    expect(emailer.sent).toHaveLength(0);

    vi.setSystemTime(new Date('2026-06-13T01:00:00Z')); // > 12 days later
    await mon.tick();
    expect(emailer.sent).toHaveLength(1);
    expect(emailer.sent[0]!.subject).toMatch(/re-link/i);

    vi.setSystemTime(new Date('2026-06-14T01:00:00Z')); // still up — no repeat
    await mon.tick();
    expect(emailer.sent).toHaveLength(1);
  });
});
