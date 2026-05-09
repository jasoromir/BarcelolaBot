import type { Tour } from '../types.js';
import type {
  CancelBookingInput,
  CancelBookingResult,
  UpdateParticipantsInput,
  UpdateParticipantsResult,
  WixClient,
} from './types.js';

export interface WixClientOpts {
  apiKey: string;
  siteId: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timezone?: string; // defaults to Europe/Madrid
  timeoutMs?: number; // defaults to 15000
}

interface WixContactDetails {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  countryCode?: string;
}

interface WixBookingRaw {
  id: string;
  status?: string;
  createdDate?: string;
  _createdDate?: string;
  _updatedDate?: string;
  bookedEntity?: {
    serviceId?: string;
    title?: string;
    location?: { address?: string };
    singleSession?: { start?: string; end?: string; sessionId?: string };
  };
  formInfo?: {
    contactDetails?: WixContactDetails;
    paymentSelection?: Array<{ numberOfParticipants?: number }>;
  };
  totalParticipants?: number;
}

interface WixBookingsQueryResponse {
  bookingsEntries?: Array<{ booking?: WixBookingRaw }>;
  pagingMetadata?: { cursors?: { next?: string } };
}

function fmtInTz(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, ...opts }).format(
    new Date(iso),
  );
}

function toLocalDate(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function toLocalTime(iso: string, tz: string): string {
  return fmtInTz(iso, tz, { hour: '2-digit', minute: '2-digit' });
}

function asName(c: WixContactDetails | undefined): string {
  if (!c) return 'Guest';
  const full = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
  return full || c.email || 'Guest';
}

function participantCount(b: WixBookingRaw): number {
  const n = b.formInfo?.paymentSelection?.[0]?.numberOfParticipants;
  if (typeof n === 'number' && n > 0) return n;
  if (typeof b.totalParticipants === 'number' && b.totalParticipants > 0) return b.totalParticipants;
  return 1;
}

export function createWixClient(opts: WixClientOpts): WixClient {
  const base = opts.baseUrl ?? 'https://www.wixapis.com';
  const fetchFn = opts.fetchFn ?? fetch;
  const tz = opts.timezone ?? 'Europe/Madrid';
  const timeoutMs = opts.timeoutMs ?? 15000;

  async function queryPage(
    cursor: string | undefined,
    startFromIso: string,
  ): Promise<WixBookingsQueryResponse> {
    const body = {
      query: {
        filter: { startTime: { $gte: startFromIso } },
        paging: { limit: 100, ...(cursor ? { cursor } : {}) },
        sort: [{ fieldName: 'startTime', order: 'ASC' }],
      },
    };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${base}/bookings/v1/bookings/query`, {
        method: 'POST',
        headers: {
          Authorization: opts.apiKey,
          'wix-site-id': opts.siteId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Wix bookings query failed: ${res.status} ${text}`);
      }
      return (await res.json()) as WixBookingsQueryResponse;
    } finally {
      clearTimeout(t);
    }
  }

  interface BookingSnapshot {
    ok: true;
    booking: { revision?: string; status?: string; totalParticipants?: number } | null;
  }
  interface BookingSnapshotErr {
    ok: false;
    error: string;
  }
  async function fetchBookingSnapshot(
    bookingId: string,
    signal: AbortSignal,
  ): Promise<BookingSnapshot | BookingSnapshotErr> {
    try {
      const res = await fetchFn(`${base}/_api/bookings-reader/v2/extended-bookings/query`, {
        method: 'POST',
        headers: {
          Authorization: opts.apiKey,
          'wix-site-id': opts.siteId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: { filter: { id: bookingId }, cursorPaging: { limit: 1 } },
        }),
        signal,
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: `snapshot failed ${res.status}: ${text.slice(0, 300)}` };
      }
      const data = (await res.json()) as {
        extendedBookings?: Array<{
          booking?: { revision?: string; status?: string; totalParticipants?: number };
        }>;
      };
      const first = data.extendedBookings?.[0]?.booking;
      return { ok: true, booking: first ?? null };
    } catch (err) {
      return { ok: false, error: `snapshot failed: ${(err as Error).message}` };
    }
  }

  return {
    async getToursForDate(date: string): Promise<Tour[]> {
      // Fetch bookings from start-of-local-date onward; stop once we cross end-of-local-date.
      const startFromIso = new Date(`${date}T00:00:00.000Z`).toISOString();
      // Local end-of-day as a UTC instant: take the last moment of the local day.
      // Compute by formatting tomorrow-00:00 local as UTC.
      const [y, m, d] = date.split('-').map(Number);
      // Construct a UTC instant that represents local midnight; approximate and adjust by offset.
      const localMidnightGuess = new Date(Date.UTC(y!, (m ?? 1) - 1, (d ?? 1) + 1, 0, 0, 0));
      // Adjust for timezone offset: observe what this instant looks like in tz and back-calc.
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(localMidnightGuess);
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
      const observedUtc = Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour'),
        get('minute'),
        get('second'),
      );
      const offsetMs = observedUtc - localMidnightGuess.getTime();
      const endExclusiveMs = localMidnightGuess.getTime() - offsetMs;

      const perSession: Map<string, Tour> = new Map();
      let cursor: string | undefined = undefined;
      const maxPages = 20;
      for (let page = 0; page < maxPages; page++) {
        const data = await queryPage(cursor, startFromIso);
        const entries = data.bookingsEntries ?? [];
        let passedEnd = false;
        for (const e of entries) {
          const b = e.booking;
          if (!b) continue;
          if (b.status && b.status !== 'CONFIRMED' && b.status !== 'APPROVED') continue;
          const s = b.bookedEntity?.singleSession;
          if (!s?.start || !s?.end) continue;
          const startMs = new Date(s.start).getTime();
          if (startMs >= endExclusiveMs) {
            passedEnd = true;
            break;
          }
          const serviceId = b.bookedEntity?.serviceId ?? 'unknown';
          const sessionKey = s.sessionId || `${serviceId}-${s.start}`;
          const count = participantCount(b);
          const participant = {
            name: asName(b.formInfo?.contactDetails),
            phone: b.formInfo?.contactDetails?.phone ?? '',
            email: b.formInfo?.contactDetails?.email,
            count,
            bookingId: b.id,
            createdAt: b.createdDate ?? b._createdDate ?? '',
          };
          const existing = perSession.get(sessionKey);
          if (existing) {
            existing.bookingCount += count;
            existing.participants!.push(participant);
          } else {
            perSession.set(sessionKey, {
              id: serviceId,
              date: toLocalDate(s.start, tz),
              startTime: toLocalTime(s.start, tz),
              endTime: toLocalTime(s.end, tz),
              bookingCount: count,
              tourTitle: b.bookedEntity?.title,
              location: b.bookedEntity?.location?.address,
              participants: [participant],
            });
          }
        }
        if (passedEnd) break;
        cursor = data.pagingMetadata?.cursors?.next;
        if (!cursor) break;
      }

      // Return only sessions that fall within the requested local date.
      return [...perSession.values()]
        .filter((t) => t.date === date)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
    },

    async cancelBooking(input: CancelBookingInput): Promise<CancelBookingResult> {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const snapshot = await fetchBookingSnapshot(input.bookingId, controller.signal);
        if (!snapshot.ok) return { ok: false, error: snapshot.error };
        if (!snapshot.booking) return { ok: true, alreadyCancelled: true };
        if (snapshot.booking.status === 'CANCELED' || snapshot.booking.status === 'CANCELLED') {
          return { ok: true, alreadyCancelled: true };
        }
        const revision = snapshot.booking.revision;
        if (!revision) return { ok: false, error: 'revision missing from Wix response' };

        const res = await fetchFn(
          `${base}/bookings/v2/bookings/${encodeURIComponent(input.bookingId)}/cancel`,
          {
            method: 'POST',
            headers: {
              Authorization: opts.apiKey,
              'wix-site-id': opts.siteId,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              revision,
              participantNotification: { notifyParticipants: false },
              // Wix uses "ignoreCancellationPolicy" / "withRefund" /
              // "waiveCancellationFee" here (skip* names don't exist — those
              // silently had no effect, which is why the 72h policy kept
              // rejecting us with 428 BOOKING_POLICY_VIOLATION).
              flowControlSettings: {
                ignoreCancellationPolicy: true,
                waiveCancellationFee: true,
              },
              initiator: 'BUSINESS',
              reason: input.reason,
            }),
            signal: controller.signal,
          },
        );
        if (!res.ok) {
          const text = await res.text();
          if (res.status === 409 || /already.*canc/i.test(text)) {
            return { ok: true, alreadyCancelled: true };
          }
          return {
            ok: false,
            error: `cancel failed ${res.status}: ${text.slice(0, 300)}`,
          };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      } finally {
        clearTimeout(t);
      }
    },

    async updateNumberOfParticipants(
      input: UpdateParticipantsInput,
    ): Promise<UpdateParticipantsResult> {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const snapshot = await fetchBookingSnapshot(input.bookingId, controller.signal);
        if (!snapshot.ok) return { ok: false, error: snapshot.error };
        if (!snapshot.booking) return { ok: false, error: 'booking not found' };
        if (snapshot.booking.status === 'CANCELED' || snapshot.booking.status === 'CANCELLED') {
          return { ok: false, error: 'booking already cancelled' };
        }
        if (
          typeof snapshot.booking.totalParticipants === 'number' &&
          snapshot.booking.totalParticipants === input.totalParticipants
        ) {
          return { ok: true, unchanged: true };
        }
        const revision = snapshot.booking.revision;
        if (!revision) return { ok: false, error: 'revision missing from Wix response' };

        const res = await fetchFn(
          `${base}/bookings/v2/bookings/${encodeURIComponent(input.bookingId)}/update_number_of_participants`,
          {
            method: 'POST',
            headers: {
              Authorization: opts.apiKey,
              'wix-site-id': opts.siteId,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              revision,
              totalParticipants: input.totalParticipants,
              participantNotification: { notifyParticipants: false },
            }),
            signal: controller.signal,
          },
        );
        if (!res.ok) {
          const text = await res.text();
          return {
            ok: false,
            error: `update-participants failed ${res.status}: ${text.slice(0, 300)}`,
          };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      } finally {
        clearTimeout(t);
      }
    },
  };
}
