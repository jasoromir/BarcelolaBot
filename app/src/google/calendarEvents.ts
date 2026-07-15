import { google, type calendar_v3 } from 'googleapis';
import type { CalendarAuth } from './calendarAuth.js';

/** Fetches every event in [timeMin, timeMax], paginating through nextPageToken. */
export async function fetchCalendarEventsInRange(
  auth: CalendarAuth,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<calendar_v3.Schema$Event[]> {
  const calendar = google.calendar({ version: 'v3', auth });
  const events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;

  do {
    const res = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500,
      pageToken,
    });
    events.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return events;
}
