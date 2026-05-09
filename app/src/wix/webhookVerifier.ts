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

export function parseBookingWebhook(payload: unknown): ParseResult {
  const parsed = BookingWebhookSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  const b = parsed.data.data.booking;
  const cd = b.formInfo.contactDetails;
  const first = cd.firstName ?? '';
  const last = cd.lastName ?? '';

  // Get participant count from multiple possible sources
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
