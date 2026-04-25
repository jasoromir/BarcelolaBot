import { describe, it, expect } from 'vitest';
import {
  buildBroadcastMessage,
  buildBookingConfirmation,
} from '../../src/messaging/builder';
import type { ToursConfig, TemplatesConfig } from '../../src/config/schemas';

const tours: ToursConfig = {
  tours: {
    'gaudi-modernista': {
      name_he: 'גאודי',
      emoji: '🌻',
      description_he: 'תיאור',
      meeting_point_he: 'נקודת מפגש',
    },
  },
};

const templates: TemplatesConfig = {
  night_header: 'NIGHT {weekday_he} {date}',
  morning_header: 'MORNING {weekday_he} {date}',
  footer: 'FOOTER',
  tour_block: '{emoji} {time_range} | {name_he} | {description_he} | {meeting_point_he}',
  booking_confirmation: 'HI {client_name} / {tour_name_he} / {date} {time}',
};

describe('buildBroadcastMessage', () => {
  it('composes night message', () => {
    const out = buildBroadcastMessage({
      kind: 'night',
      date: '2026-04-26',
      tours: [
        { id: 'gaudi-modernista', date: '2026-04-26', startTime: '10:30', endTime: '13:30', bookingCount: 3 },
      ],
      toursConfig: tours,
      templates,
    });
    expect(out).toContain('NIGHT');
    expect(out).toContain('2026-04-26');
    expect(out).toContain('10:30-13:30');
    expect(out).toContain('גאודי');
    expect(out).toContain('FOOTER');
  });

  it('skips tours with no config entry and logs name', () => {
    const out = buildBroadcastMessage({
      kind: 'night',
      date: '2026-04-26',
      tours: [
        { id: 'unknown-tour', date: '2026-04-26', startTime: '10:30', endTime: '13:30', bookingCount: 3 },
      ],
      toursConfig: tours,
      templates,
    });
    expect(out).toContain('NIGHT');
    expect(out).toContain('FOOTER');
    expect(out).not.toContain('10:30-13:30');
  });
});

describe('buildBookingConfirmation', () => {
  it('interpolates booking fields', () => {
    const out = buildBookingConfirmation({
      event: {
        bookingId: 'b1',
        tourId: 'gaudi-modernista',
        date: '2026-04-26',
        time: '10:30',
        clientName: 'Dana',
        phone: '+972501234567',
      },
      toursConfig: tours,
      templates,
    });
    expect(out).toBe('HI Dana / גאודי / 2026-04-26 10:30');
  });

  it('falls back to tour id when no config entry', () => {
    const out = buildBookingConfirmation({
      event: {
        bookingId: 'b1',
        tourId: 'unknown',
        date: '2026-04-26',
        time: '10:30',
        clientName: 'Dana',
        phone: '+972501234567',
      },
      toursConfig: tours,
      templates,
    });
    expect(out).toContain('unknown');
  });
});
