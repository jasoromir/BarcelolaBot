import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBookingWebhook } from '../../src/wix/webhookVerifier';

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
});
