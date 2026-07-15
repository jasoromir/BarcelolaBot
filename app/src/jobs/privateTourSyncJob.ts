import type { AppLogger } from '../log/logger.js';
import type { JobHistory } from '../persistence/jobHistory.js';
import type { JobOutcome } from '../types.js';
import type { PrivateTourEventsStore } from '../persistence/privateTourEvents.js';
import type { CalendarAuth } from '../google/calendarAuth.js';
import { fetchCalendarEventsInRange } from '../google/calendarEvents.js';
import { llmParsePrivateEvent } from '../reminders/privateEventParser.js';
import { looksLikePrivateTour } from '../reminders/privateTourDetector.js';
import { computeContentHash } from '../persistence/privateTourEvents.js';
import { runJob } from './runner.js';

// Gemini free tier is 15 requests/minute; pace calls so a backlog doesn't
// blow through the quota before the built-in 429 retries even kick in.
const GEMINI_CALL_DELAY_MS = 6_500;

export interface PrivateTourSyncInput {
  calendarId: string;
  auth: CalendarAuth;
  store: PrivateTourEventsStore;
  logger: AppLogger;
  history: JobHistory;
  geminiApiKey: string;
  windowDaysBack: number;
  windowDaysForward: number;
  dryRun: boolean;
  now?: () => Date;
  /** Override the inter-call delay (default GEMINI_CALL_DELAY_MS). Tests set this to 0. */
  callDelayMs?: number;
}

export async function runPrivateTourSyncJob(input: PrivateTourSyncInput): Promise<JobOutcome> {
  return runJob({
    jobName: 'private_tour_sync',
    dryRun: input.dryRun,
    history: input.history,
    logger: input.logger,
    fn: async () => {
      const now = (input.now ?? (() => new Date()))();
      const timeMin = new Date(now);
      timeMin.setDate(timeMin.getDate() - input.windowDaysBack);
      const timeMax = new Date(now);
      timeMax.setDate(timeMax.getDate() + input.windowDaysForward);

      const events = await fetchCalendarEventsInRange(input.auth, input.calendarId, timeMin, timeMax);
      const privateEvents = events.filter((e) => e.id && looksLikePrivateTour(e.summary));

      let parsedNew = 0;
      let parsedChanged = 0;
      let skippedCached = 0;
      let failed = 0;

      for (const event of privateEvents) {
        const eventId = event.id!;
        const summary = event.summary ?? '';
        const description = event.description ?? null;
        const location = event.location ?? null;
        const startIso = event.start?.dateTime || event.start?.date || '';
        const endIso = event.end?.dateTime || event.end?.date || '';

        const contentHash = computeContentHash({ summary, description, location, start: startIso, end: endIso });
        const existing = input.store.get(eventId);

        if (existing && input.store.isUpToDate(eventId, contentHash)) {
          skippedCached += 1;
          continue;
        }

        if (input.dryRun) {
          // Dry run previews what WOULD be (re)parsed, without spending LLM quota or writing.
          if (existing) parsedChanged += 1;
          else parsedNew += 1;
          continue;
        }

        // Pace Gemini calls — continue past individual failures rather than
        // aborting the whole batch; a burst of new bookings on a low-quota
        // day simply spills over to tomorrow's run.
        await new Promise((r) => setTimeout(r, input.callDelayMs ?? GEMINI_CALL_DELAY_MS));

        try {
          const fields = await llmParsePrivateEvent(input.geminiApiKey, { summary, description, location });
          input.store.upsert({
            eventId,
            contentHash,
            startAtIso: startIso,
            endAtIso: endIso,
            rawSummary: summary,
            rawDescription: description,
            rawLocation: location,
            ...fields,
          });
          if (existing) parsedChanged += 1;
          else parsedNew += 1;
        } catch (err) {
          failed += 1;
          input.logger.error({
            source: 'jobs',
            eventType: 'private_tour_parse_failed',
            message: (err as Error).message,
            metadata: { eventId, summary },
          });
        }
      }

      let staleRemoved = 0;
      if (!input.dryRun) {
        const currentIds = privateEvents.map((e) => e.id!);
        staleRemoved = input.store.deleteStaleInRange(timeMin.toISOString(), timeMax.toISOString(), currentIds);
      }

      const status = failed > 0 ? 'partial' : 'success';
      return {
        status,
        toursCount: privateEvents.length,
        groupsSent: 0,
        groupsClosed: 0,
        metadata: { parsedNew, parsedChanged, skippedCached, failed, staleRemoved },
      };
    },
  });
}
