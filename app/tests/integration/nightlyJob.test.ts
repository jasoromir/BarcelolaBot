import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db';
import { EventLog } from '../../src/persistence/eventLog';
import { JobHistory } from '../../src/persistence/jobHistory';
import { createLogger } from '../../src/log/logger';
import { runNightlyJob } from '../../src/jobs/nightlyJob';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types';
import type { WixClient } from '../../src/wix/types';
import type { AppConfig } from '../../src/config/loader';

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

function fakeConfig(over?: Partial<AppConfig>): AppConfig {
  return {
    groups: { groups: [{ id: 'g1@g.us', name: 'Main', active: true }] },
    tours: {
      tours: {
        t1: { name_he: 'T1', emoji: '🌻', description_he: 'd', meeting_point_he: 'mp' },
      },
    },
    templates: {
      night_header: 'NIGHT {date}',
      morning_header: 'MORNING {date}',
      footer: 'FOOTER',
      tour_block: '{emoji} {time_range} {name_he}',
      booking_confirmation: 'HI',
    },
    allowlist: { mode: 'open', explicit_phones: [], rule: { country_codes: [] } },
    settings: {
      timezone: 'Europe/Madrid',
      schedule: { nightly_cron: '30 21 * * *', morning_cron: '30 8 * * *' },
      broadcast: { mode: 'test', test_group_id: 'test@g.us', inter_message_delay_ms: 0 },
      min_bookings_to_run: 1,
      retry: { max_attempts: 1, backoff_ms: [] },
    },
    ...over,
  };
}

function freshInfra() {
  const db = openDatabase(path.join(os.tmpdir(), `wabot-nj-${Date.now()}-${Math.random()}.sqlite`));
  const eventLog = new EventLog(db);
  const history = new JobHistory(db);
  const logger = createLogger({
    eventLog,
    logDir: path.join(os.tmpdir(), `wabot-nj-logs-${Date.now()}`),
    consoleLevel: 'silent',
  });
  return { db, eventLog, history, logger };
}

describe('runNightlyJob', () => {
  it('happy path: fetches tours, sends to test group, closes group', async () => {
    const { history, logger } = freshInfra();
    const client = fakeClient();
    const wix: WixClient = {
      getToursForDate: vi.fn(async () => [
        { id: 't1', date: '2026-04-26', startTime: '10:30', endTime: '13:30', bookingCount: 2 },
      ]),
    };
    const result = await runNightlyJob({
      config: fakeConfig(),
      whatsapp: client,
      wix,
      history,
      logger,
      isPaused: () => false,
      dryRun: false,
      now: () => new Date('2026-04-25T20:30:00Z'),
    });
    expect(result.status).toBe('success');
    expect(result.toursCount).toBe(1);
    expect(result.groupsSent).toBe(1);
    expect(result.groupsClosed).toBe(1);
    expect(client.sendToGroup).toHaveBeenCalledWith('test@g.us', expect.stringContaining('NIGHT'));
    expect(client.setGroupMessagesAdminsOnly).toHaveBeenCalledWith('test@g.us', true);
  });

  it('skips when paused', async () => {
    const { history, logger } = freshInfra();
    const result = await runNightlyJob({
      config: fakeConfig(),
      whatsapp: fakeClient(),
      wix: { getToursForDate: vi.fn(async () => []) },
      history,
      logger,
      isPaused: () => true,
      dryRun: false,
      now: () => new Date('2026-04-25T20:30:00Z'),
    });
    expect(result.status).toBe('skipped');
  });

  it('0 tours -> no broadcast, still closes groups', async () => {
    const { history, logger } = freshInfra();
    const client = fakeClient();
    const result = await runNightlyJob({
      config: fakeConfig(),
      whatsapp: client,
      wix: { getToursForDate: vi.fn(async () => []) },
      history,
      logger,
      isPaused: () => false,
      dryRun: false,
      now: () => new Date('2026-04-25T20:30:00Z'),
    });
    expect(result.status).toBe('success');
    expect(result.groupsSent).toBe(0);
    expect(result.groupsClosed).toBe(1);
    expect(client.sendToGroup).not.toHaveBeenCalled();
  });

  it('dryRun does not send or close', async () => {
    const { history, logger } = freshInfra();
    const client = fakeClient();
    const result = await runNightlyJob({
      config: fakeConfig(),
      whatsapp: client,
      wix: {
        getToursForDate: vi.fn(async () => [
          { id: 't1', date: '2026-04-26', startTime: '10:30', endTime: '13:30', bookingCount: 2 },
        ]),
      },
      history,
      logger,
      isPaused: () => false,
      dryRun: true,
      now: () => new Date('2026-04-25T20:30:00Z'),
    });
    expect(result.status).toBe('success');
    expect(client.sendToGroup).not.toHaveBeenCalled();
    expect(client.setGroupMessagesAdminsOnly).not.toHaveBeenCalled();
    expect(result.metadata?.preview).toContain('NIGHT');
  });
});
