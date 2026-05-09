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
        order_id: 'order-abc-123',
        booking_contact_phone: '+34651886491',
        booking_contact_email: 'lianak227@gmail.com',
        start_date: '2026-05-15T10:00:00.000+02:00',
        booked_entity_id: '4422ee5f-957b-45c8-bf06-876482fd2b57',
        bookings_page_url:
          'https://www.barcelola-tours.com/booking-calendar/המסע-בעקבות-גאודי-והמודרניסטה',
        business_name: 'Barcelola Tours',
      },
    };
    const result = parseBookingWebhook(wixNative);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.bookingId).toBe('order-abc-123');
    expect(result.event.phone).toBe('+34651886491');
    expect(result.event.tourId).toBe('4422ee5f-957b-45c8-bf06-876482fd2b57');
    expect(result.event.date).toBe('2026-05-15');
    expect(result.event.time).toBe('10:00');
    expect(result.event.clientName).toBe('Lianak');
  });

  it('falls back to email when name cannot be derived', () => {
    const wixNative = {
      data: {
        order_id: 'order-xyz',
        booking_contact_phone: '+34651886491',
        start_date: '2026-05-15T10:00:00.000+02:00',
      },
    };
    const result = parseBookingWebhook(wixNative);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.clientName).toBe('Guest');
    expect(result.event.tourId).toBe('');
  });
});
