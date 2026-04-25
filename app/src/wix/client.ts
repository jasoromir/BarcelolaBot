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

// Compute start/end of the given local date in the configured tz, as UTC instants.
function toUtcBoundary(
  date: string,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  tz: string,
): string {
  // Using the same trick: create a UTC instant, compute offset via Intl, adjust.
  const approx = new Date(
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`,
  );
  // Get what this instant looks like in the target tz
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(approx);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // Construct the "clock reading" we just observed as a UTC Date
  const observedAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
    ms,
  );
  const offsetMs = observedAsUtc - approx.getTime();
  return new Date(approx.getTime() - offsetMs).toISOString();
}

export function createWixClient(opts: WixClientOpts): WixClient {
  const base = opts.baseUrl ?? 'https://www.wixapis.com';
  const fetchFn = opts.fetchFn ?? fetch;
  const tz = 'Europe/Madrid';

  return {
    async getToursForDate(date: string): Promise<Tour[]> {
      const url = `${base}/bookings/v2/sessions/query`;
      const startUtc = toUtcBoundary(date, 0, 0, 0, 0, tz);
      const endUtc = toUtcBoundary(date, 23, 59, 59, 999, tz);
      const body = {
        query: {
          filter: {
            start: { $gte: startUtc, $lt: endUtc },
          },
        },
      };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetchFn(url, {
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
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
