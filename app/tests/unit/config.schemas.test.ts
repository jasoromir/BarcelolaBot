import { describe, it, expect } from 'vitest';
import {
  GroupsConfigSchema,
  ToursConfigSchema,
  TemplatesConfigSchema,
  AllowlistConfigSchema,
  SettingsConfigSchema,
} from '../../src/config/schemas.js';

describe('GroupsConfigSchema', () => {
  it('accepts valid groups', () => {
    const valid = {
      groups: [
        { id: '120363012345678901@g.us', name: 'Main', active: true },
      ],
    };
    expect(GroupsConfigSchema.parse(valid)).toEqual(valid);
  });

  it('rejects group id not ending in @g.us', () => {
    const bad = { groups: [{ id: '123', name: 'x', active: true }] };
    expect(() => GroupsConfigSchema.parse(bad)).toThrow();
  });
});

describe('ToursConfigSchema', () => {
  it('accepts tour with all required fields', () => {
    const valid = {
      tours: {
        'gaudi-modernista': {
          name_he: 'x',
          emoji: '🌻',
          description_he: 'desc',
          meeting_point_he: 'mp',
        },
      },
    };
    expect(ToursConfigSchema.parse(valid).tours['gaudi-modernista']?.emoji).toBe('🌻');
  });
});

describe('TemplatesConfigSchema', () => {
  it('requires all template fields', () => {
    const bad = { night_header: 'x' };
    expect(() => TemplatesConfigSchema.parse(bad)).toThrow();
  });
});

describe('AllowlistConfigSchema', () => {
  it('accepts explicit mode', () => {
    const v = { mode: 'explicit', explicit_phones: ['+972501234567'], rule: { country_codes: [] } };
    expect(AllowlistConfigSchema.parse(v).mode).toBe('explicit');
  });
  it('rejects phone without + prefix', () => {
    const v = { mode: 'explicit', explicit_phones: ['972501234567'], rule: { country_codes: [] } };
    expect(() => AllowlistConfigSchema.parse(v)).toThrow();
  });
});

describe('SettingsConfigSchema', () => {
  it('accepts valid settings', () => {
    const v = {
      timezone: 'Europe/Madrid',
      schedule: { nightly_cron: '30 21 * * *', morning_cron: '30 8 * * *' },
      broadcast: { mode: 'test', test_group_id: '120@g.us', inter_message_delay_ms: 2000 },
      min_bookings_to_run: 1,
      retry: { max_attempts: 3, backoff_ms: [60000, 300000, 900000] },
      reminders: {
        enabled: true,
        lead_time_hours: 24,
        combine_threshold_hours: 24,
        no_reply_alert_minutes_before: 120,
        poll_interval_seconds: 30,
        official_contact_number: '+34623964800',
        worker_group_id: '120@g.us',
        classifier_confidence_threshold: 0.7,
        reply_debounce_seconds: 0,
      },
    };
    expect(SettingsConfigSchema.parse(v).broadcast.mode).toBe('test');
  });
});
