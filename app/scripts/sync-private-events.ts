/**
 * Sync private tour bookings from guidesbarcelola@gmail.com into a local
 * cache, parsing each with an LLM call (Gemini) the first time it's seen —
 * or again if its content changed. Already-cached, unchanged events are
 * skipped, so a daily run only pays for genuinely new/edited bookings.
 *
 * Usage: npx tsx scripts/sync-private-events.ts
 * (intended to be run once/day, e.g. via cron or node-cron, once validated)
 */
import 'dotenv/config';
import * as path from 'path';
import { authorizeGoogleCalendar, fetchAllCalendarEvents } from './lib/google-calendar-auth.js';
import { PrivateEventsCache, computeContentHash } from './lib/privateEventsCache.js';
import { llmParsePrivateEvent } from '../src/reminders/privateEventParser.js';

const TARGET_CALENDAR = 'guidesbarcelola@gmail.com';
const PRIVATE_EVENT_COLOR_ID = '3'; // "Grape" — purple

const MONTHS_BACK = 2;
const MONTHS_FORWARD = 4;

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌ GEMINI_API_KEY not set (check .env)');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════');
  console.log('  Syncing private tour bookings');
  console.log('═══════════════════════════════════════════════\n');

  const auth = await authorizeGoogleCalendar();

  const now = new Date();
  const timeMin = new Date(now);
  timeMin.setMonth(timeMin.getMonth() - MONTHS_BACK);
  const timeMax = new Date(now);
  timeMax.setMonth(timeMax.getMonth() + MONTHS_FORWARD);

  const events = await fetchAllCalendarEvents(auth, TARGET_CALENDAR, timeMin, timeMax);
  const privateEvents = events.filter((e) => e.colorId === PRIVATE_EVENT_COLOR_ID);
  console.log(`Found ${privateEvents.length} private booking(s) in range.\n`);

  const dbPath = path.resolve(import.meta.dirname, '..', 'data', 'private-events.sqlite');
  const cache = new PrivateEventsCache(dbPath);

  let parsedNew = 0;
  let parsedChanged = 0;
  let skippedCached = 0;
  let failed = 0;

  for (const event of privateEvents) {
    const summary: string = event.summary ?? '';
    const description: string | null = event.description ?? null;
    const location: string | null = event.location ?? null;
    const startIso: string = event.start?.dateTime || event.start?.date || '';
    const endIso: string = event.end?.dateTime || event.end?.date || '';

    const contentHash = computeContentHash({ summary, description, location, start: startIso, end: endIso });
    const existing = cache.get(event.id);

    if (existing && cache.isUpToDate(event.id, contentHash)) {
      skippedCached += 1;
      continue;
    }

    // Gemini free tier is 15 requests/minute — pace calls so a large backlog
    // doesn't blow through the quota before the built-in 429 retries even kick in.
    await new Promise((r) => setTimeout(r, 6_500));

    try {
      const fields = await llmParsePrivateEvent(apiKey, { summary, description, location });
      cache.upsert({
        eventId: event.id,
        contentHash,
        startAtIso: startIso,
        endAtIso: endIso,
        rawSummary: summary,
        rawDescription: description,
        rawLocation: location,
        ...fields,
      });
      if (existing) {
        parsedChanged += 1;
        console.log(`🔄 Re-parsed (changed): ${summary}`);
      } else {
        parsedNew += 1;
        console.log(`✨ Parsed (new): ${summary}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`❌ Failed to parse "${summary}": ${(err as Error).message}`);
    }
  }

  console.log('\n───────────────────────────────────────────────');
  console.log(`New: ${parsedNew}  Changed: ${parsedChanged}  Cached (skipped): ${skippedCached}  Failed: ${failed}`);
  console.log('───────────────────────────────────────────────\n');

  const all = cache.listInRange(timeMin.toISOString(), timeMax.toISOString());
  console.log(`📋 All ${all.length} cached private bookings in range:\n`);
  for (const r of all) {
    const start = new Date(r.startAtIso);
    const end = new Date(r.endAtIso);
    console.log('─────────────────────────────────────────');
    console.log(`${r.rawSummary}`);
    console.log(`   Tour name:     ${r.tourName ?? '❓'}`);
    console.log(`   Date:          ${start.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`);
    console.log(`   Time:          ${start.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} - ${end.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`);
    console.log(`   Guide:         ${r.guide ?? '❓'}`);
    console.log(`   Client name:   ${r.clientName ?? '❓'}`);
    console.log(`   People count:  ${r.peopleCount ?? '❓'}`);
    console.log(`   Phone:         ${r.phone ?? '—'}`);
    console.log(`   Email:         ${r.email ?? '—'}`);
    console.log(`   Meeting point: ${r.meetingPoint ?? '—'}`);
  }

  cache.close();
  console.log('\n═══════════════════════════════════════════════');
  console.log('  Done!');
  console.log('═══════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message || err);
  process.exit(1);
});
