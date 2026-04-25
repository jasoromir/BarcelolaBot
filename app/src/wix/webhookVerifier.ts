import { z } from 'zod';
import type { BookingEvent } from '../types.js';

const BookingWebhookSchema = z.object({
  entityId: z.string(),
  data: z.object({
    booking: z.object({
      id: z.string(),
      serviceId: z.string(),
      startDate: z.string(),
      contactDetails: z.object({
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        phone: z.string(),
      }),
    }),
  }),
});

export type ParseResult =
  | { ok: true; event: BookingEvent }
  | { ok: false; error: string };

function fmtDate(iso: string, tz = 'Europe/Madrid'): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${day}`;
}

function fmtTime(iso: string, tz = 'Europe/Madrid'): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function parseBookingWebhook(payload: unknown): ParseResult {
  const parsed = BookingWebhookSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  const b = parsed.data.data.booking;
  const first = b.contactDetails.firstName ?? '';
  const last = b.contactDetails.lastName ?? '';
  return {
    ok: true,
    event: {
      bookingId: b.id,
      tourId: b.serviceId,
      phone: b.contactDetails.phone,
      clientName: [first, last].filter(Boolean).join(' ').trim() || 'Guest',
      date: fmtDate(b.startDate),
      time: fmtTime(b.startDate),
    },
  };
}

export interface SignatureVerifier {
  verify(rawBody: string, signatureHeader: string | undefined): boolean;
}

export function createSignatureVerifier(signingSecret: string): SignatureVerifier {
  // Wix signs webhooks; exact algorithm is documented per-webhook.
  // v1: simple shared-secret header check; swap to HMAC at integration time.
  return {
    verify(_rawBody, header) {
      return header === signingSecret;
    },
  };
}
