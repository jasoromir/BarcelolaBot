/**
 * Google Calendar — fetch all events from guidesbarcelola@gmail.com (raw dump).
 * See scripts/lib/google-calendar-auth.ts for OAuth setup instructions.
 *
 * For structured private-booking data, use scripts/sync-private-events.ts instead —
 * this script just prints everything, unparsed.
 */

import * as path from 'path';
import { authorizeGoogleCalendar, fetchAllCalendarEvents, getCalendarColorMap } from './lib/google-calendar-auth.js';

const TARGET_CALENDAR = 'guidesbarcelola@gmail.com';
const PRIVATE_EVENT_COLOR_ID = '3'; // "Grape" — purple

const MONTHS_BACK = 2;
const MONTHS_FORWARD = 4;

function printEvent(event: any, colorMap: Record<string, { background: string; foreground: string }>) {
  const start = event.start?.dateTime || event.start?.date || '?';
  const end = event.end?.dateTime || event.end?.date || '?';
  const startDate = new Date(start);
  const color = event.colorId ? colorMap[event.colorId] : undefined;
  const isPrivate = event.colorId === PRIVATE_EVENT_COLOR_ID;

  console.log(`   ─────────────────────────────────────────`);
  console.log(`   ${isPrivate ? '🟣' : '📌'} ${event.summary ?? '(no title)'}${isPrivate ? '  [PRIVATE]' : ''}`);
  console.log(`      Date:        ${startDate.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`);
  console.log(`      Time:        ${startDate.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} → ${new Date(end).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`);
  console.log(`      Status:      ${event.status ?? '?'}`);
  console.log(`      Color:       ${event.colorId ?? '(default)'}${color ? ` (${color.background})` : ''}`);
  if (event.description) console.log(`      Description: ${event.description.replace(/\n/g, ' | ')}`);
  if (event.location) console.log(`      Location:    ${event.location}`);
  if (event.creator) console.log(`      Creator:     ${event.creator.email ?? ''}${event.creator.displayName ? ` (${event.creator.displayName})` : ''}`);
  if (event.organizer) console.log(`      Organizer:   ${event.organizer.email ?? ''}${event.organizer.displayName ? ` (${event.organizer.displayName})` : ''}`);
  if (event.attendees?.length) {
    console.log(`      Attendees:   ${event.attendees.map((a: any) => `${a.email}${a.responseStatus ? ` [${a.responseStatus}]` : ''}`).join(', ')}`);
  }
  if (event.recurrence) console.log(`      Recurrence:  ${event.recurrence.join('; ')}`);
  if (event.recurringEventId) console.log(`      RecurringOf: ${event.recurringEventId}`);
  if (event.visibility) console.log(`      Visibility:  ${event.visibility}`);
  if (event.transparency) console.log(`      Transparency:${event.transparency}`);
  if (event.reminders) console.log(`      Reminders:   ${JSON.stringify(event.reminders)}`);
  if (event.extendedProperties) console.log(`      ExtendedProps: ${JSON.stringify(event.extendedProperties)}`);
  if (event.attachments?.length) console.log(`      Attachments: ${event.attachments.map((a: any) => a.title).join(', ')}`);
  console.log(`      Created:     ${event.created ?? '?'}`);
  console.log(`      Updated:     ${event.updated ?? '?'}`);
  console.log(`      HtmlLink:    ${event.htmlLink ?? '?'}`);
  console.log(`      iCalUID:     ${event.iCalUID ?? '?'}`);
  console.log(`      ID:          ${event.id}`);
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Google Calendar — guidesbarcelola@gmail.com Events');
  console.log('═══════════════════════════════════════════════');

  const auth = await authorizeGoogleCalendar();
  const colorMap = await getCalendarColorMap(auth);

  const now = new Date();
  const timeMin = new Date(now);
  timeMin.setMonth(timeMin.getMonth() - MONTHS_BACK);
  const timeMax = new Date(now);
  timeMax.setMonth(timeMax.getMonth() + MONTHS_FORWARD);

  console.log(`\n📆 Fetching ALL events from "${TARGET_CALENDAR}"`);
  console.log(`   Range: ${timeMin.toLocaleDateString()} → ${timeMax.toLocaleDateString()} (${MONTHS_BACK}mo back, ${MONTHS_FORWARD}mo forward)\n`);

  const events = await fetchAllCalendarEvents(auth, TARGET_CALENDAR, timeMin, timeMax);

  console.log(`   Found ${events.length} total event(s).\n`);

  const privateEvents = events.filter((e) => e.colorId === PRIVATE_EVENT_COLOR_ID);
  console.log(`   🟣 ${privateEvents.length} of them are PRIVATE (purple / colorId=${PRIVATE_EVENT_COLOR_ID}).\n`);

  console.log('═══════════════════════════════════════════════');
  console.log('  ALL EVENTS (full detail)');
  console.log('═══════════════════════════════════════════════');
  for (const event of events) {
    printEvent(event, colorMap);
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log('  PRIVATE EVENTS ONLY (purple, summary)');
  console.log('═══════════════════════════════════════════════');
  for (const event of privateEvents) {
    const start = event.start?.dateTime || event.start?.date || '?';
    console.log(`   🟣 ${new Date(start).toLocaleDateString('he-IL')}  ${event.summary}`);
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log('  Done!');
  console.log('═══════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message || err);
  process.exit(1);
});
