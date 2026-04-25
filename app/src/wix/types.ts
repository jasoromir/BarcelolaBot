import type { Tour, BookingEvent } from '../types';

export type { Tour, BookingEvent };

export interface WixClient {
  getToursForDate(date: string): Promise<Tour[]>;
}
