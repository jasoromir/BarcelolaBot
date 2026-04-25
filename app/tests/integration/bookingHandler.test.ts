import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../src/persistence/db';
import { WebhookDedup } from '../../src/persistence/webhookDedup';
import { PendingDms } from '../../src/persistence/pendingDms';
import { EventLog } from '../../src/persistence/eventLog';
import { createLogger } from '../../src/log/logger';
import { DirectMessageSender } from '../../src/messaging/directMessage';
import { handleBookingWebhook } from '../../src/webhook/bookingHandler';
import type { WhatsAppClient, SendResult } from '../../src/whatsapp/types';
import type { AppConfig } from '../../src/config/loader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/wix/booking-webhook.json'), 'utf8'),
);

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

function fakeConfig(mode: 'open' | 'explicit' = 'open'): AppConfig {
  return {
    groups: { groups: [] },
    tours: {
      tours: {
        'gaudi-modernista': {
          name_he: 'Gaudi', emoji: '🌻', description_he: 'd', meeting_point_he: 'mp',
        },
      },
    },
    templates: {
      night_header: 'N', morning_header: 'M', footer: 'F',
      tour_block: '{emoji} {time_range} {name_he}',
      booking_confirmation: 'HI {client_name} {tour_name_he}',
    },
    allowlist: {
      mode,
      explicit_phones: mode === 'explicit' ? ['+999999999'] : [],
      rule: { country_codes: [] },
    },
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
  const db = openDatabase(path.join(os.tmpdir(), `wabot-wh-${Date.now()}-${Math.random()}.sqlite`));
  const eventLog = new EventLog(db);
  const dedup = new WebhookDedup(db);
  const pending = new PendingDms(db);
  const logger = createLogger({
    eventLog,
    logDir: path.join(os.tmpdir(), `wabot-wh-logs-${Date.now()}`),
    consoleLevel: 'silent',
  });
  return { dedup, pending, logger };
}

describe('handleBookingWebhook', () => {
  it('sends DM when allowlist open and connected', async () => {
    const { dedup, pending, logger } = freshInfra();
    const client = fakeClient();
    const sender = new DirectMessageSender({
      client,
      pendingDms: pending,
      allowlist: () => fakeConfig('open').allowlist,
      retry: { attempts: 1, backoffMs: [] },
    });
    const result = await handleBookingWebhook({
      payload: fixture,
      config: fakeConfig('open'),
      dedup,
      sender,
      logger,
      isPaused: () => false,
    });
    expect(result.outcome).toBe('sent');
    expect(client.sendDirect).toHaveBeenCalled();
  });

  it('dedups on second call', async () => {
    const { dedup, pending, logger } = freshInfra();
    const client = fakeClient();
    const sender = new DirectMessageSender({
      client, pendingDms: pending, allowlist: () => fakeConfig('open').allowlist,
      retry: { attempts: 1, backoffMs: [] },
    });
    const first = await handleBookingWebhook({
      payload: fixture, config: fakeConfig('open'), dedup, sender, logger, isPaused: () => false,
    });
    const second = await handleBookingWebhook({
      payload: fixture, config: fakeConfig('open'), dedup, sender, logger, isPaused: () => false,
    });
    expect(first.outcome).toBe('sent');
    expect(second.outcome).toBe('duplicate');
    expect(client.sendDirect).toHaveBeenCalledTimes(1);
  });

  it('skips when not on allowlist', async () => {
    const { dedup, pending, logger } = freshInfra();
    const client = fakeClient();
    const sender = new DirectMessageSender({
      client, pendingDms: pending,
      allowlist: () => fakeConfig('explicit').allowlist,
      retry: { attempts: 1, backoffMs: [] },
    });
    const result = await handleBookingWebhook({
      payload: fixture, config: fakeConfig('explicit'), dedup, sender, logger, isPaused: () => false,
    });
    expect(result.outcome).toBe('skipped_allowlist');
    expect(client.sendDirect).not.toHaveBeenCalled();
  });

  it('defers when disconnected', async () => {
    const { dedup, pending, logger } = freshInfra();
    const client = fakeClient({ state: () => ({ kind: 'disconnected' }) });
    const sender = new DirectMessageSender({
      client, pendingDms: pending,
      allowlist: () => fakeConfig('open').allowlist,
      retry: { attempts: 1, backoffMs: [] },
    });
    const result = await handleBookingWebhook({
      payload: fixture, config: fakeConfig('open'), dedup, sender, logger, isPaused: () => false,
    });
    expect(result.outcome).toBe('deferred');
    expect(pending.pending()).toHaveLength(1);
  });
});
