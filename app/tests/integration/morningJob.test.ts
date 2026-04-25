import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db.js';
import { EventLog } from '../../src/persistence/eventLog.js';
import { JobHistory } from '../../src/persistence/jobHistory.js';
import { createLogger } from '../../src/log/logger.js';
import { runMorningJob } from '../../src/jobs/morningJob.js';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types.js';
import type { WixClient } from '../../src/wix/types.js';
import type { AppConfig } from '../../src/config/loader.js';

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

function fakeConfig(): AppConfig {
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
  };
}

function freshInfra() {
  const db = openDatabase(path.join(os.tmpdir(), `wabot-mj-${Date.now()}-${Math.random()}.sqlite`));
  const eventLog = new EventLog(db);
  const history = new JobHistory(db);
  const logger = createLogger({
    eventLog,
    logDir: path.join(os.tmpdir(), `wabot-mj-logs-${Date.now()}`),
    consoleLevel: 'silent',
  });
  return { history, logger };
}

describe('runMorningJob', () => {
  it('opens groups and sends morning message', async () => {
    const { history, logger } = freshInfra();
    const client = fakeClient();
    const wix: WixClient = {
      getToursForDate: vi.fn(async () => [
        { id: 't1', date: '2026-04-26', startTime: '10:30', endTime: '13:30', bookingCount: 2 },
      ]),
    };
    const result = await runMorningJob({
      config: fakeConfig(),
      whatsapp: client,
      wix,
      history,
      logger,
      isPaused: () => false,
      dryRun: false,
      now: () => new Date('2026-04-26T07:30:00Z'),
    });
    expect(result.status).toBe('success');
    expect(client.setGroupMessagesAdminsOnly).toHaveBeenCalledWith('test@g.us', false);
    expect(client.sendToGroup).toHaveBeenCalledWith('test@g.us', expect.stringContaining('MORNING'));
  });

  it('opens groups even when 0 tours', async () => {
    const { history, logger } = freshInfra();
    const client = fakeClient();
    const result = await runMorningJob({
      config: fakeConfig(),
      whatsapp: client,
      wix: { getToursForDate: vi.fn(async () => []) },
      history,
      logger,
      isPaused: () => false,
      dryRun: false,
      now: () => new Date('2026-04-26T07:30:00Z'),
    });
    expect(result.status).toBe('success');
    expect(client.setGroupMessagesAdminsOnly).toHaveBeenCalledWith('test@g.us', false);
    expect(client.sendToGroup).not.toHaveBeenCalled();
  });
});
