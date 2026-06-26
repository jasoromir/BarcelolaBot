import type { Tour, BookingEvent } from '../types.js';

export type { Tour, BookingEvent };

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
  cancelBooking(input: CancelBookingInput): Promise<CancelBookingResult>;
  updateNumberOfParticipants(
    input: UpdateParticipantsInput,
  ): Promise<UpdateParticipantsResult>;
  listServices(): Promise<WixService[]>;
  /** Returns payment info for a deposit booking, or null if not found / not a deposit. */
  getOrderPaymentInfo(orderId: string): Promise<OrderPaymentInfo | null>;
}
