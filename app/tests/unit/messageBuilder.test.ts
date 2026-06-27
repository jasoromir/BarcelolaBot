import { describe, it, expect } from 'vitest';
import {
  buildBroadcastMessage,
  buildBookingConfirmation,
} from '../../src/messaging/builder.js';
import type { ToursConfig, TemplatesConfig } from '../../src/config/schemas.js';

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
  booking_confirmation: 'HI {client_name} / {tour_name_he} / {date} {time} / {participant_count} / {anti_reply_footer}',
  booking_confirmation_lt24h:
    'COMBINED {client_name} / {tour_name_he} / {date} {time} / {participant_count} / {anti_reply_footer}',
  reminder_24h: 'R24 {client_name}',
  confirmation_ack: 'ACK {client_name}',
  confirmation_update_ack: 'UPD {client_name} {participant_count}',
  cancel_ack: 'CANCEL {client_name}',
  anti_reply_footer: 'FOOTER({official_contact_number})',
  no_reply_alert: 'NORE {tour_name_he}',
  worker_forward: 'FWD {client_name}',
  cancel_notice: 'CNO {client_name}',
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
    expect(out).toContain('26/04/2026');
    expect(out).toContain('10:30-13:30');
    expect(out).toContain('גאודי');
    expect(out).toContain('FOOTER');
  });

  it('still renders tours without a config entry using Wix-provided title', () => {
    const out = buildBroadcastMessage({
      kind: 'night',
      date: '2026-04-26',
      tours: [
        {
          id: 'unknown-tour',
          date: '2026-04-26',
          startTime: '10:30',
          endTime: '13:30',
          bookingCount: 3,
          tourTitle: 'Gothic Quarter Tour',
          location: 'Plaça Catalunya',
        },
      ],
      toursConfig: tours,
      templates,
    });
    expect(out).toContain('NIGHT');
    expect(out).toContain('FOOTER');
    expect(out).toContain('10:30-13:30');
    expect(out).toContain('Gothic Quarter Tour');
    expect(out).toContain('Plaça Catalunya');
  });
});

describe('buildBookingConfirmation', () => {
  it('interpolates booking fields and includes anti-reply footer', () => {
    const out = buildBookingConfirmation({
      event: {
        bookingId: 'b1',
        tourId: 'gaudi-modernista',
        date: '2026-04-26',
        time: '10:30',
        startAtIso: '2026-04-26T10:30:00.000Z',
        clientName: 'Dana',
        phone: '+972501234567',
        participantCount: 2,
      },
      toursConfig: tours,
      templates,
      officialContactNumber: '+34623964800',
    });
    expect(out).toBe(
      'HI Dana / גאודי / 26/04/26 10:30 / 2 / FOOTER(+34623964800)',
    );
  });

  it('uses Wix tour title when no config entry', () => {
    const out = buildBookingConfirmation({
      event: {
        bookingId: 'b1',
        tourId: 'unknown',
        tourTitle: 'Wix Title',
        date: '2026-04-26',
        time: '10:30',
        startAtIso: '2026-04-26T10:30:00.000Z',
        clientName: 'Dana',
        phone: '+972501234567',
        participantCount: 1,
      },
      toursConfig: tours,
      templates,
      officialContactNumber: '+34623964800',
    });
    expect(out).toContain('Wix Title');
  });

  it('uses lt24h template when combined=true', () => {
    const out = buildBookingConfirmation({
      event: {
        bookingId: 'b1',
        tourId: 'gaudi-modernista',
        date: '2026-04-26',
        time: '10:30',
        startAtIso: '2026-04-26T10:30:00.000Z',
        clientName: 'Dana',
        phone: '+972501234567',
        participantCount: 3,
      },
      toursConfig: tours,
      templates,
      combined: true,
      officialContactNumber: '+34623964800',
    });
    expect(out).toContain('COMBINED');
    expect(out).toContain('Dana');
  });
});
