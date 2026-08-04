import type { Tour, BookingSummary, GuideTourRoster, RosterAttendee } from '../types.js';
import type {
  CancelBookingInput,
  CancelBookingResult,
  UpdateParticipantsInput,
  UpdateParticipantsResult,
  WixClient,
  WixService,
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

  // Fetch all scheduled sessions for a local date via the Time Slots API.
  // This returns sessions regardless of whether anyone booked — the missing
  // piece that the bookings-only query couldn't provide.
  async function fetchEventTimeSlots(
    date: string,
  ): Promise<Array<{ serviceId: string; startLocal: string; endLocal: string; location?: string }>> {
    const [y, m, d] = date.split('-');
    const from = `${date}T00:00:00`;
    const to = `${y}-${m}-${String(Number(d) + 1).padStart(2, '0')}T00:00:00`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const slots: Array<{ serviceId: string; startLocal: string; endLocal: string; location?: string }> = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const res = await fetchFn(`${base}/_api/service-availability/v2/time-slots/event`, {
          method: 'POST',
          headers: {
            Authorization: opts.apiKey,
            'wix-site-id': opts.siteId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fromLocalDate: from,
            toLocalDate: to,
            timeZone: tz,
            includeNonBookable: true,
            cursorPaging: { limit: 50, ...(cursor ? { cursor } : {}) },
          }),
          signal: controller.signal,
        });
        if (!res.ok) break;
        const data = (await res.json()) as {
          timeSlots?: Array<{
            serviceId?: string;
            localStartDate?: string;
            localEndDate?: string;
            location?: { formattedAddress?: string };
          }>;
          pagingMetadata?: { hasNext?: boolean; cursors?: { next?: string } };
        };
        for (const ts of data.timeSlots ?? []) {
          if (ts.serviceId && ts.localStartDate && ts.localEndDate) {
            slots.push({
              serviceId: ts.serviceId,
              startLocal: ts.localStartDate,
              endLocal: ts.localEndDate,
              location: ts.location?.formattedAddress,
            });
          }
        }
        if (!data.pagingMetadata?.hasNext) break;
        cursor = data.pagingMetadata?.cursors?.next;
        if (!cursor) break;
      }
      return slots;
    } catch {
      return [];
    } finally {
      clearTimeout(t);
    }
  }

  return {
    async getToursForDate(date: string): Promise<Tour[]> {
      // Step 1: Get ALL scheduled sessions for this date (including zero-booking ones).
      const eventSlots = await fetchEventTimeSlots(date);

      // Seed perSession from the time-slots response so every session exists
      // even if no bookings are found for it later.
      const perSession: Map<string, Tour> = new Map();
      for (const slot of eventSlots) {
        const startTime = slot.startLocal.slice(11, 16); // "HH:mm"
        const endTime = slot.endLocal.slice(11, 16);
        const sessionKey = `${slot.serviceId}-${slot.startLocal}`;
        if (!perSession.has(sessionKey)) {
          perSession.set(sessionKey, {
            id: slot.serviceId,
            date,
            startTime,
            endTime,
            bookingCount: 0,
            location: slot.location,
            participants: [],
          });
        }
      }

      // Step 2: Fetch confirmed bookings to overlay participant counts and details.
      const startFromIso = new Date(`${date}T00:00:00.000Z`).toISOString();
      const [y, m, d] = date.split('-').map(Number);
      const localMidnightGuess = new Date(Date.UTC(y!, (m ?? 1) - 1, (d ?? 1) + 1, 0, 0, 0));
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).formatToParts(localMidnightGuess);
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
      const observedUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
      const offsetMs = observedUtc - localMidnightGuess.getTime();
      const endExclusiveMs = localMidnightGuess.getTime() - offsetMs;

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
          // Key must match the time-slots seed format: serviceId-localDateTimeT
          // The time-slots API gives local times like "2026-06-27T20:00:00";
          // bookings give ISO with offset like "2026-06-27T20:00:00.000+02:00".
          // Normalize by formatting the start instant to local "YYYY-MM-DDTHH:mm:00".
          const localStart = `${toLocalDate(s.start, tz)}T${toLocalTime(s.start, tz)}:00`;
          const sessionKey = `${serviceId}-${localStart}`;
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
            if (!existing.tourTitle) existing.tourTitle = b.bookedEntity?.title;
            if (!existing.location) existing.location = b.bookedEntity?.location?.address;
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

    async getConfirmedBookingsInRange(fromIso: string, toIso: string): Promise<BookingSummary[]> {
      const toMs = new Date(toIso).getTime();
      const results: BookingSummary[] = [];
      let cursor: string | undefined;
      const maxPages = 200; // generous cap for a multi-week range in 100-row pages
      for (let page = 0; page < maxPages; page++) {
        const data = await queryPage(cursor, fromIso);
        const entries = data.bookingsEntries ?? [];
        let passedEnd = false;
        for (const e of entries) {
          const b = e.booking;
          if (!b) continue;
          if (b.status && b.status !== 'CONFIRMED' && b.status !== 'APPROVED') continue;
          const s = b.bookedEntity?.singleSession;
          if (!s?.start) continue;
          const startMs = new Date(s.start).getTime();
          if (startMs >= toMs) {
            passedEnd = true;
            break;
          }
          results.push({
            bookingId: b.id,
            tourId: b.bookedEntity?.serviceId ?? 'unknown',
            tourTitle: b.bookedEntity?.title,
            startAtIso: new Date(s.start).toISOString(),
            clientName: asName(b.formInfo?.contactDetails),
            phone: b.formInfo?.contactDetails?.phone ?? '',
            participantCount: participantCount(b),
          });
        }
        if (passedEnd) break;
        cursor = data.pagingMetadata?.cursors?.next;
        if (!cursor) break;
      }
      return results;
    },

    async getGuideRostersForDate(date: string): Promise<GuideTourRoster[]> {
      // Query confirmed bookings whose tour starts within the requested local
      // date via the extended-bookings v2 API. Unlike bookings/v1, this exposes
      // bookedEntity.slot.resource (the assigned guide). We filter on startDate
      // using a UTC window generous enough to cover the full local day (tours
      // are Europe/Madrid = UTC+1/+2, so a day starting at the previous 22:00Z
      // and ending at 22:00Z the next day covers all local-date sessions).
      const dayStartUtc = new Date(`${date}T00:00:00.000+00:00`);
      const fromIso = new Date(dayStartUtc.getTime() - 3 * 3600 * 1000).toISOString();
      const toIso = new Date(dayStartUtc.getTime() + 27 * 3600 * 1000).toISOString();

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const perTour = new Map<string, GuideTourRoster>();
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const res = await fetchFn(`${base}/_api/bookings-reader/v2/extended-bookings/query`, {
            method: 'POST',
            headers: {
              Authorization: opts.apiKey,
              'wix-site-id': opts.siteId,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query: {
                filter: {
                  $and: [{ startDate: { $gte: fromIso } }, { startDate: { $lte: toIso } }],
                },
                cursorPaging: { limit: 100, ...(cursor ? { cursor } : {}) },
              },
            }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`guide rosters query failed ${res.status}: ${text.slice(0, 300)}`);
          }
          const data = (await res.json()) as {
            extendedBookings?: Array<{
              booking?: {
                id: string;
                status?: string;
                startDate?: string;
                totalParticipants?: number;
                contactDetails?: WixContactDetails;
                bookedEntity?: {
                  title?: string;
                  slot?: {
                    serviceId?: string;
                    eventId?: string;
                    startDate?: string;
                    resource?: { id?: string; name?: string };
                  };
                };
              };
            }>;
            pagingMetadata?: { hasNext?: boolean; cursors?: { next?: string } };
          };

          for (const eb of data.extendedBookings ?? []) {
            const b = eb.booking;
            if (!b) continue;
            if (b.status && b.status !== 'CONFIRMED' && b.status !== 'APPROVED') continue;
            const slot = b.bookedEntity?.slot;
            const startIso = b.startDate ?? slot?.startDate;
            if (!startIso) continue;
            // Keep only sessions whose LOCAL date matches the requested date.
            if (toLocalDate(startIso, tz) !== date) continue;

            const key = slot?.eventId ?? `${slot?.serviceId ?? 'unknown'}-${startIso}`;
            const attendee: RosterAttendee = {
              name: asName(b.contactDetails),
              phone: b.contactDetails?.phone ?? '',
              participants:
                typeof b.totalParticipants === 'number' && b.totalParticipants > 0
                  ? b.totalParticipants
                  : 1,
            };
            const existing = perTour.get(key);
            if (existing) {
              existing.attendees.push(attendee);
              existing.totalParticipants += attendee.participants;
              if (!existing.guideName && slot?.resource?.name) {
                existing.guideName = slot.resource.name;
              }
            } else {
              perTour.set(key, {
                serviceId: slot?.serviceId ?? 'unknown',
                eventId: slot?.eventId,
                tourTitle: b.bookedEntity?.title ?? 'Tour',
                startAtIso: new Date(startIso).toISOString(),
                startTimeLocal: toLocalTime(startIso, tz),
                guideName: slot?.resource?.name,
                attendees: [attendee],
                totalParticipants: attendee.participants,
              });
            }
          }

          if (!data.pagingMetadata?.hasNext) break;
          cursor = data.pagingMetadata?.cursors?.next;
          if (!cursor) break;
        }

        return [...perTour.values()].sort((a, b) =>
          a.startAtIso.localeCompare(b.startAtIso),
        );
      } finally {
        clearTimeout(t);
      }
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

    async listServices(): Promise<WixService[]> {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const out: WixService[] = [];
        let offset = 0;
        for (let page = 0; page < 10; page++) {
          const res = await fetchFn(`${base}/bookings/v2/services/query`, {
            method: 'POST',
            headers: {
              Authorization: opts.apiKey,
              'wix-site-id': opts.siteId,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query: { paging: { limit: 100, offset } },
            }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`listServices ${res.status}: ${text.slice(0, 300)}`);
          }
          const data = (await res.json()) as {
            services?: Array<{
              id: string;
              name?: string;
              description?: string;
              hidden?: boolean;
              type?: string;
              category?: { name?: string };
              locations?: Array<{ calculatedAddress?: { formattedAddress?: string } }>;
            }>;
            pagingMetadata?: { total?: number; count?: number };
          };
          const batch = data.services ?? [];
          for (const s of batch) {
            out.push({
              id: s.id,
              name: s.name ?? '',
              description: s.description,
              category: s.category?.name,
              location: s.locations?.[0]?.calculatedAddress?.formattedAddress,
              hidden: Boolean(s.hidden),
              type: s.type ?? 'UNKNOWN',
            });
          }
          if (batch.length < 100) break;
          offset += 100;
        }
        return out;
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

    async getOrderPaymentInfo(orderId: string): Promise<import('./types.js').OrderPaymentInfo | null> {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchFn(`${base}/ecom/v1/orders/${encodeURIComponent(orderId)}`, {
          method: 'GET',
          headers: {
            Authorization: opts.apiKey,
            'wix-site-id': opts.siteId,
          },
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const data = (await res.json()) as {
          order?: {
            paymentStatus?: string;
            balanceSummary?: {
              paid?: { amount?: string; formattedAmount?: string };
              balance?: { amount?: string; formattedAmount?: string };
            };
          };
        };
        const order = data.order;
        if (!order || order.paymentStatus !== 'PARTIALLY_PAID') return null;
        const paid = order.balanceSummary?.paid?.amount;
        const balance = order.balanceSummary?.balance?.amount;
        if (!paid || !balance) return null;
        // Extract currency symbol from formattedAmount (e.g. "19.00€" → "€")
        const fmt = order.balanceSummary?.paid?.formattedAmount ?? '';
        const currencySymbol = fmt.replace(/[\d.,\s]/g, '') || '€';
        return { paid, balance, currencySymbol };
      } catch {
        return null;
      } finally {
        clearTimeout(t);
      }
    },
  };
}
