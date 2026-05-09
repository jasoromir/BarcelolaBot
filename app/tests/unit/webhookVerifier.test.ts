import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBookingWebhook } from '../../src/wix/webhookVerifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/wix/booking-webhook.json'), 'utf8'),
);

describe('parseBookingWebhook', () => {
  it('extracts BookingEvent from a valid payload', () => {
    const result = parseBookingWebhook(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.bookingId).toBe('booking_42');
    expect(result.event.tourId).toBe('gaudi-modernista');
    expect(result.event.phone).toBe('+972501234567');
    expect(result.event.clientName).toBe('Dana Levi');
    expect(result.event.date).toBe('2026-04-26');
    expect(result.event.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('returns error on malformed payload', () => {
    const result = parseBookingWebhook({ foo: 'bar' });
    expect(result.ok).toBe(false);
  });

  it('parses Wix native sessions_booked payload (flat snake_case)', () => {
    const wixNative = {
      data: {
        order_id: 'ffc8aef7-ff1c-47ae-84e8-01e579e4147d',
        booking_id: 'e23442f8-7d15-4add-82ec-46baeb353960',
        service_id: 'd9807937-2c23-4f57-9eec-232ba2360f37',
        service_name: 'המסע בעקבות גאודי והמודרניסטה',
        service_name_main_language: 'המסע בעקבות גאודי והמודרניסטה',
        booking_contact_phone: '+34675319188',
        booking_contact_email: 'jason.pruebas@gmail.com',
        booking_contact_first_name: 'Jason',
        booking_contact_last_name: 'Omedes',
        number_of_participants: 4,
        start_date: '2026-05-15T10:00:00.000+02:00',
      },
    };
    const result = parseBookingWebhook(wixNative);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.bookingId).toBe('ffc8aef7-ff1c-47ae-84e8-01e579e4147d');
    expect(result.event.phone).toBe('+34675319188');
    expect(result.event.tourId).toBe('d9807937-2c23-4f57-9eec-232ba2360f37');
    expect(result.event.tourTitle).toBe('המסע בעקבות גאודי והמודרניסטה');
    expect(result.event.date).toBe('2026-05-15');
    expect(result.event.time).toBe('10:00');
    expect(result.event.clientName).toBe('Jason Omedes');
    expect(result.event.participantCount).toBe(4);
  });

  it('uses nested contact.name when top-level first/last missing', () => {
    const wixNative = {
      data: {
        order_id: 'order-xyz',
        booking_contact_phone: '+34651886491',
        start_date: '2026-05-15T10:00:00.000+02:00',
        contact: { name: { first: 'Liana', last: 'Katzir' } },
      },
    };
    const result = parseBookingWebhook(wixNative);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.clientName).toBe('Liana Katzir');
    expect(result.event.tourId).toBe('');
  });

  it('falls back to email when no name fields present', () => {
    const wixNative = {
      data: {
        order_id: 'order-xyz',
        booking_contact_phone: '+34651886491',
        booking_contact_email: 'foo@bar.com',
        start_date: '2026-05-15T10:00:00.000+02:00',
      },
    };
    const result = parseBookingWebhook(wixNative);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.clientName).toBe('foo@bar.com');
  });
});
