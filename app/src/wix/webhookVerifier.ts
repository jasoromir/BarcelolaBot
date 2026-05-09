import { z } from 'zod';
import type { BookingEvent } from '../types.js';

const BookingWebhookSchema = z.object({
  data: z.object({
    booking: z.object({
      id: z.string().min(1),
      totalParticipants: z.number().optional(),
      bookedEntity: z.object({
        serviceId: z.string().min(1),
        title: z.string().optional(),
        singleSession: z.object({
          start: z.string().min(1),
          end: z.string().optional(),
        }),
      }),
      formInfo: z.object({
        contactDetails: z.object({
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          email: z.string().optional(),
          phone: z.string().min(1),
        }),
        paymentSelection: z.array(z.object({
          numberOfParticipants: z.number().optional(),
        })).optional(),
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

// Wix's real `wix_bookings-sessions_booked` trigger posts a flat payload with
// snake_case fields, not the nested `data.booking.*` shape we originally assumed
// (which comes from Wix Bookings REST webhooks, a different channel).
// See docs/webhook-payloads/sessions_booked-sample.json for a captured example.
const WixSessionBookedSchema = z.object({
  data: z.object({
    order_id: z.string().min(1),
    booking_contact_phone: z.string().min(1),
    booking_contact_email: z.string().optional(),
    start_date: z.string().min(1),
    booked_entity_id: z.string().optional(),
    bookings_page_url: z.string().optional(),
    business_name: z.string().optional(),
  }),
});

function titleFromBookingsPageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1];
    if (!last) return undefined;
    return decodeURIComponent(last).replace(/-/g, ' ');
  } catch {
    return undefined;
  }
}

function nameFromEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const local = email.split('@')[0];
  if (!local) return undefined;
  const cleaned = local.replace(/[._+\-]+/g, ' ').replace(/\d+$/g, '').trim();
  if (!cleaned) return undefined;
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function parseBookingWebhook(payload: unknown): ParseResult {
  // Try the nested shape first (used by direct-API fixtures and tests).
  const nested = BookingWebhookSchema.safeParse(payload);
  if (nested.success) {
    const b = nested.data.data.booking;
    const cd = b.formInfo.contactDetails;
    const first = cd.firstName ?? '';
    const last = cd.lastName ?? '';
    let participantCount = b.totalParticipants;
    if (!participantCount && b.formInfo.paymentSelection && b.formInfo.paymentSelection.length > 0) {
      participantCount = b.formInfo.paymentSelection[0]?.numberOfParticipants;
    }
    return {
      ok: true,
      event: {
        bookingId: b.id,
        tourId: b.bookedEntity.serviceId,
        tourTitle: b.bookedEntity.title,
        phone: cd.phone,
        clientName: [first, last].filter(Boolean).join(' ').trim() || (cd.email ?? 'Guest'),
        date: fmtDate(b.bookedEntity.singleSession.start),
        time: fmtTime(b.bookedEntity.singleSession.start),
        participantCount: participantCount || 1,
      },
    };
  }

  // Fall back to Wix's native automations payload for sessions_booked.
  const flat = WixSessionBookedSchema.safeParse(payload);
  if (flat.success) {
    const d = flat.data.data;
    return {
      ok: true,
      event: {
        bookingId: d.order_id,
        tourId: d.booked_entity_id ?? '',
        tourTitle: titleFromBookingsPageUrl(d.bookings_page_url),
        phone: d.booking_contact_phone,
        clientName:
          nameFromEmail(d.booking_contact_email) ??
          d.booking_contact_email ??
          'Guest',
        date: fmtDate(d.start_date),
        time: fmtTime(d.start_date),
        participantCount: 1,
      },
    };
  }

  return { ok: false, error: nested.error.message };
}

export interface SignatureVerifier {
  verify(rawBody: string, signatureHeader: string | undefined): boolean;
}

export function createSignatureVerifier(signingSecret: string): SignatureVerifier {
  return {
    verify(_rawBody, header) {
      return header === signingSecret;
    },
  };
}
