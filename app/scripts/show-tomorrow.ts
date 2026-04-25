// Standalone script: fetches tomorrow's tours from Wix and prints everything.
//
// Usage:
//   cd app && npx tsx scripts/show-tomorrow.ts           # tomorrow
//   cd app && npx tsx scripts/show-tomorrow.ts today     # today
//   cd app && npx tsx scripts/show-tomorrow.ts 2026-04-28 # specific date
//
// Requires: WIX_API_KEY and WIX_SITE_ID in app/.env

import 'dotenv/config';
import { createWixClient } from '../src/wix/client.js';

function resolveDate(arg: string | undefined): string {
  const tz = 'Europe/Madrid';
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  if (!arg || arg === 'tomorrow') {
    const d = new Date(Date.now() + 24 * 3600 * 1000);
    return fmt.format(d);
  }
  if (arg === 'today') {
    return fmt.format(new Date());
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  throw new Error(`invalid date arg: ${arg} (use "today", "tomorrow", or YYYY-MM-DD)`);
}

async function main(): Promise<void> {
  const apiKey = process.env.WIX_API_KEY;
  const siteId = process.env.WIX_SITE_ID;
  if (!apiKey || !siteId) {
    console.error('FATAL: WIX_API_KEY and WIX_SITE_ID must be set in app/.env');
    process.exit(1);
  }

  const date = resolveDate(process.argv[2]);
  console.log(`\nFetching tours for ${date} (Europe/Madrid)...\n`);

  const wix = createWixClient({ apiKey, siteId });
  const tours = await wix.getToursForDate(date);

  if (tours.length === 0) {
    console.log('No tours found for this date.\n');
    return;
  }

  for (const t of tours) {
    const title = t.tourTitle ?? '(untitled)';
    console.log('━'.repeat(70));
    console.log(`Tour:         ${title}`);
    console.log(`Service ID:   ${t.id}`);
    console.log(`Date:         ${t.date}`);
    console.log(`Time:         ${t.startTime} – ${t.endTime} (Europe/Madrid)`);
    console.log(`Location:     ${t.location ?? '(not provided)'}`);
    console.log(`Participants: ${t.bookingCount} total across ${t.participants?.length ?? 0} bookings`);
    if (t.participants && t.participants.length > 0) {
      console.log('\n  Bookings:');
      for (const p of t.participants) {
        const extra = [
          p.phone ? `phone=${p.phone}` : null,
          p.email ? `email=${p.email}` : null,
          `count=${p.count}`,
          p.bookingId ? `bookingId=${p.bookingId}` : null,
          p.createdAt ? `booked=${p.createdAt}` : null,
        ].filter(Boolean).join('  ');
        console.log(`    • ${p.name}`);
        console.log(`        ${extra}`);
      }
    }
    console.log('');
  }
  console.log('━'.repeat(70));
  console.log(`Total: ${tours.length} session(s), ${tours.reduce((s, t) => s + t.bookingCount, 0)} participant(s)\n`);
}

main().catch((err) => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
