import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db.js';
import { EventLog } from '../../src/persistence/eventLog.js';
import { JobHistory } from '../../src/persistence/jobHistory.js';
import { WebhookDedup } from '../../src/persistence/webhookDedup.js';
import { PendingDms } from '../../src/persistence/pendingDms.js';
import { ControlState } from '../../src/persistence/controlState.js';
import { RemindersStore } from '../../src/persistence/reminders.js';

function freshDb() {
  return openDatabase(
    path.join(os.tmpdir(), `wabot-p-${Date.now()}-${Math.random()}.sqlite`),
  );
}

describe('EventLog', () => {
  it('appends and lists events', () => {
    const log = new EventLog(freshDb());
    log.append({ level: 'info', source: 'test', eventType: 'hello', message: 'hi' });
    const rows = log.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe('hi');
  });
});

describe('JobHistory', () => {
  it('starts + finishes a run', () => {
    const h = new JobHistory(freshDb());
    const id = h.start('nightly', { dryRun: false });
    h.finish(id, { status: 'success', toursCount: 2, groupsSent: 1, groupsClosed: 1 });
    const rows = h.recent(5);
    expect(rows[0]?.status).toBe('success');
  });
});

describe('WebhookDedup', () => {
  it('first insert returns true, second returns false', () => {
    const d = new WebhookDedup(freshDb());
    expect(d.tryClaim('b1')).toBe(true);
    expect(d.tryClaim('b1')).toBe(false);
    d.complete('b1', 'sent');
  });
});

describe('PendingDms', () => {
  it('enqueues and drains', () => {
    const q = new PendingDms(freshDb());
    q.enqueue({ phone: '+1', body: 'hi', bookingId: 'b1' });
    const items = q.pending();
    expect(items).toHaveLength(1);
    q.markSent(items[0]!.id);
    expect(q.pending()).toHaveLength(0);
  });
});

describe('ControlState', () => {
  it('reads defaults and writes', () => {
    const c = new ControlState(freshDb());
    expect(c.get('automations_paused')).toBe('false');
    c.set('automations_paused', 'true');
    expect(c.get('automations_paused')).toBe('true');
  });
});

describe('RemindersStore welcome-delivered tracking', () => {
  function baseRow(bookingId: string, phone: string) {
    return {
      bookingId,
      orderIdEcom: null,
      phone,
      clientName: 'Dana',
      tourId: null,
      tourNameHe: 'Gaudi',
      startAtIso: '2026-08-01T09:00:00.000Z',
      participantCount: 1,
      status: 'awaiting_reply' as const,
      sendAtIso: null,
      sentAtIso: new Date().toISOString(),
      lastReplyTs: null,
      welcomeDelivered: null,
    };
  }

  it('welcomeDelivered starts null and hasConfirmedDelivery is false until set true', () => {
    const r = new RemindersStore(freshDb());
    r.upsert(baseRow('b1', '+972500000001'));
    expect(r.get('b1')?.welcomeDelivered).toBeNull();
    expect(r.hasConfirmedDelivery('+972500000001')).toBe(false);

    r.setWelcomeDelivered('b1', true);
    expect(r.get('b1')?.welcomeDelivered).toBe(true);
    expect(r.hasConfirmedDelivery('+972500000001')).toBe(true);
  });

  it('hasConfirmedDelivery stays false for a phone whose welcome failed', () => {
    const r = new RemindersStore(freshDb());
    r.upsert(baseRow('b2', '+972500000002'));
    r.setWelcomeDelivered('b2', false);
    expect(r.get('b2')?.welcomeDelivered).toBe(false);
    expect(r.hasConfirmedDelivery('+972500000002')).toBe(false);
  });

  it('hasConfirmedDelivery is true if ANY booking for that phone delivered, even if others did not', () => {
    const r = new RemindersStore(freshDb());
    r.upsert(baseRow('b3', '+972500000003'));
    r.upsert(baseRow('b4', '+972500000003'));
    r.setWelcomeDelivered('b3', false);
    r.setWelcomeDelivered('b4', true);
    expect(r.hasConfirmedDelivery('+972500000003')).toBe(true);
  });
});
