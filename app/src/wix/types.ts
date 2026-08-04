import type { Tour, BookingEvent, BookingSummary, GuideTourRoster } from '../types.js';

export type { Tour, BookingEvent, BookingSummary, GuideTourRoster };

export interface CancelBookingInput {
  bookingId: string;
  reason: string;
}

export interface CancelBookingResult {
  ok: boolean;
  alreadyCancelled?: boolean;
  error?: string;
}

export interface UpdateParticipantsInput {
  bookingId: string;
  totalParticipants: number;
}

export interface UpdateParticipantsResult {
  ok: boolean;
  unchanged?: boolean;
  error?: string;
}

export interface WixService {
  id: string;
  name: string;
  description?: string;
  category?: string;
  location?: string;
  hidden: boolean;
  type: string;
}

export interface OrderPaymentInfo {
  /** Amount already paid (deposit). */
  paid: string;
  /** Amount still due at the tour. */
  balance: string;
  /** Currency symbol/code as Wix formats it (e.g. "€"). Derived from formattedAmount. */
  currencySymbol: string;
}

export interface WixClient {
  getToursForDate(date: string): Promise<Tour[]>;
  /**
   * Returns each tour session on the given local date with its assigned guide
   * (slot.resource) and the list of confirmed attendees. Used by the guide
   * pre-tour notification job. Unlike getToursForDate, this uses the
   * extended-bookings v2 API so the guide resource is available.
   */
  getGuideRostersForDate(date: string): Promise<GuideTourRoster[]>;
  /**
   * All confirmed bookings whose tour starts within [fromIso, toIso), across
   * however many days that spans — a single continuous cursor walk over the
   * bookings API rather than one getToursForDate call per day. Used by the
   * reminder backfill sweep to check weeks ahead in one pass instead of
   * hundreds of per-day calls.
   */
  getConfirmedBookingsInRange(fromIso: string, toIso: string): Promise<BookingSummary[]>;
  cancelBooking(input: CancelBookingInput): Promise<CancelBookingResult>;
  updateNumberOfParticipants(
    input: UpdateParticipantsInput,
  ): Promise<UpdateParticipantsResult>;
  listServices(): Promise<WixService[]>;
  /** Returns payment info for a deposit booking, or null if not found / not a deposit. */
  getOrderPaymentInfo(orderId: string): Promise<OrderPaymentInfo | null>;
}
