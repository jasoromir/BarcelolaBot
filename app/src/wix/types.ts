import type { Tour, BookingEvent } from '../types.js';

export type { Tour, BookingEvent };

export interface WixClient {
  getToursForDate(date: string): Promise<Tour[]>;
}
