import { describe, it, expect, vi } from 'vitest';
import { createWixClient } from '../../src/wix/client.js';

function bookingEntry(overrides: {
  id: string;
  start: string;
  status?: string;
  phone?: string;
  firstName?: string;
}) {
  return {
    booking: {
      id: overrides.id,
      status: overrides.status ?? 'CONFIRMED',
      bookedEntity: {
        serviceId: 'svc-1',
        title: 'Gaudi Tour',
        singleSession: { start: overrides.start, end: overrides.start },
      },
      formInfo: {
        contactDetails: { firstName: overrides.firstName ?? 'Dana', phone: overrides.phone ?? '+972500000001' },
      },
      totalParticipants: 2,
    },
  };
}

describe('WixClient.getConfirmedBookingsInRange', () => {
  it('returns confirmed bookings within [fromIso, toIso), stopping once a booking starts at/after toIso', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          bookingsEntries: [
            bookingEntry({ id: 'bk-1', start: '2026-08-01T10:00:00.000Z' }),
            bookingEntry({ id: 'bk-2', start: '2026-08-15T10:00:00.000Z' }),
            // Outside the range — must be excluded, and pagination should stop here.
            bookingEntry({ id: 'bk-3', start: '2026-09-01T10:00:00.000Z' }),
          ],
        }),
        { status: 200 },
      ),
    );
    const wix = createWixClient({ apiKey: 'k', siteId: 's', fetchFn: fetchFn as unknown as typeof fetch });
    const result = await wix.getConfirmedBookingsInRange('2026-07-29T00:00:00.000Z', '2026-08-28T00:00:00.000Z');
    expect(result.map((b) => b.bookingId)).toEqual(['bk-1', 'bk-2']);
    expect(fetchFn).toHaveBeenCalledTimes(1); // stopped paginating after passing the end bound
  });

  it('excludes non-confirmed bookings', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          bookingsEntries: [
            bookingEntry({ id: 'bk-cancelled', start: '2026-08-01T10:00:00.000Z', status: 'CANCELLED' }),
            bookingEntry({ id: 'bk-confirmed', start: '2026-08-02T10:00:00.000Z' }),
          ],
        }),
        { status: 200 },
      ),
    );
    const wix = createWixClient({ apiKey: 'k', siteId: 's', fetchFn: fetchFn as unknown as typeof fetch });
    const result = await wix.getConfirmedBookingsInRange('2026-07-29T00:00:00.000Z', '2026-08-28T00:00:00.000Z');
    expect(result.map((b) => b.bookingId)).toEqual(['bk-confirmed']);
  });

  it('maps booking fields into BookingSummary shape', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          bookingsEntries: [
            bookingEntry({ id: 'bk-1', start: '2026-08-01T10:00:00.000Z', firstName: 'Ohad', phone: '+972547779188' }),
          ],
        }),
        { status: 200 },
      ),
    );
    const wix = createWixClient({ apiKey: 'k', siteId: 's', fetchFn: fetchFn as unknown as typeof fetch });
    const [b] = await wix.getConfirmedBookingsInRange('2026-07-29T00:00:00.000Z', '2026-08-28T00:00:00.000Z');
    expect(b).toMatchObject({
      bookingId: 'bk-1',
      tourId: 'svc-1',
      tourTitle: 'Gaudi Tour',
      clientName: 'Ohad',
      phone: '+972547779188',
      participantCount: 2,
    });
  });
});
