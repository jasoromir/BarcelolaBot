import { describe, it, expect, vi } from 'vitest';
import { startScheduler } from '../../src/scheduler.js';
import type { App } from '../../src/app.js';
import type { WhatsAppState } from '../../src/types.js';
import type { SessionMonitor } from '../../src/notify/sessionMonitor.js';

function fakeApp(overrides: {
  waState: WhatsAppState;
  sessionMonitor: SessionMonitor | null;
}): App {
  return {
    config: {
      settings: {
        timezone: 'Europe/Madrid',
        schedule: { nightly_cron: '30 21 * * *', morning_cron: '30 8 * * *' },
        private_tours: undefined,
      },
    },
    whatsapp: { state: () => overrides.waState },
    sessionMonitor: overrides.sessionMonitor,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    eventLog: { pruneOlderThan: vi.fn(() => 0) },
    runPrivateTourSync: null,
  } as unknown as App;
}

describe('scheduler health-check tick (regression: 2026-07-19 silent disconnect-alert bug)', () => {
  it('calls sessionMonitor.tick() while CONNECTED, not just while disconnected', () => {
    // This is the exact bug: sessionMonitor.tick() previously lived after an
    // early `return` in the connected branch, so it only ran while
    // disconnected — meaning the "clear alert flag on reconnect" logic inside
    // tick() never executed, and a stale alert-sent flag from one outage
    // silently blocked every future outage's alert forever.
    const tick = vi.fn(async () => {});
    const app = fakeApp({
      waState: { kind: 'connected', phone: '+34600000000' },
      sessionMonitor: { tick },
    });
    const tasks = startScheduler(app);
    tasks.runHealthCheckTick();
    expect(tick).toHaveBeenCalledOnce();
    tasks.nightly.stop();
    tasks.morning.stop();
    tasks.prune.stop();
    tasks.waHealth.stop();
  });

  it('also calls sessionMonitor.tick() while disconnected', () => {
    const tick = vi.fn(async () => {});
    const app = fakeApp({
      waState: { kind: 'qr_pending', qrDataUrl: 'x' },
      sessionMonitor: { tick },
    });
    const tasks = startScheduler(app);
    tasks.runHealthCheckTick();
    expect(tick).toHaveBeenCalledOnce();
    tasks.nightly.stop();
    tasks.morning.stop();
    tasks.prune.stop();
    tasks.waHealth.stop();
  });

  it('does not throw when sessionMonitor is null (notifications disabled)', () => {
    const app = fakeApp({ waState: { kind: 'connected', phone: '+1' }, sessionMonitor: null });
    const tasks = startScheduler(app);
    expect(() => tasks.runHealthCheckTick()).not.toThrow();
    tasks.nightly.stop();
    tasks.morning.stop();
    tasks.prune.stop();
    tasks.waHealth.stop();
  });

  it('logs session_monitor_tick_failed (but does not throw) if tick() rejects', async () => {
    const tick = vi.fn(async () => {
      throw new Error('boom');
    });
    const app = fakeApp({ waState: { kind: 'disconnected' }, sessionMonitor: { tick } });
    const tasks = startScheduler(app);
    expect(() => tasks.runHealthCheckTick()).not.toThrow();
    // tick() rejects asynchronously; flush microtasks before asserting the logger call.
    await new Promise((r) => setImmediate(r));
    expect((app.logger.error as any)).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'session_monitor_tick_failed' }),
    );
    tasks.nightly.stop();
    tasks.morning.stop();
    tasks.prune.stop();
    tasks.waHealth.stop();
  });
});
