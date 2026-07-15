/** Local date (YYYY-MM-DD) in the given timezone. */
export function todayLocalDate(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

/** Local date (YYYY-MM-DD) shifted by +1 day, in the given timezone. */
export function tomorrowLocalDate(now: Date, tz: string): string {
  return todayLocalDate(new Date(now.getTime() + 24 * 60 * 60 * 1000), tz);
}

/** Current wall-clock time as "HH:MM" in the given timezone. */
export function localHHMM(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}
