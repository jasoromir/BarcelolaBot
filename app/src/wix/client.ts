import type { Tour } from '../types.js';
import type { WixClient } from './types.js';

export interface WixClientOpts {
  apiKey: string;
  siteId: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

interface WixBookingsApiResponse {
  sessions: Array<{
    session_id: string;
    service_id: string;
    start: string;
    end: string;
    total_participants: number;
  }>;
}

function toHHmm(iso: string, tz: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function toYYYYMMDD(iso: string, tz: string): string {
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

export function createWixClient(opts: WixClientOpts): WixClient {
  const base = opts.baseUrl ?? 'https://www.wixapis.com';
  const fetchFn = opts.fetchFn ?? fetch;
  const tz = 'Europe/Madrid';

  return {
    async getToursForDate(date: string): Promise<Tour[]> {
      const url = `${base}/bookings/v2/sessions/query`;
      const body = {
        query: {
          filter: {
            start: { $gte: `${date}T00:00:00.000Z`, $lt: `${date}T23:59:59.999Z` },
          },
        },
      };
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: opts.apiKey,
          'wix-site-id': opts.siteId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`Wix sessions query failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as WixBookingsApiResponse;
      return data.sessions.map((s) => ({
        id: s.service_id,
        date: toYYYYMMDD(s.start, tz),
        startTime: toHHmm(s.start, tz),
        endTime: toHHmm(s.end, tz),
        bookingCount: s.total_participants,
      }));
    },
  };
}
