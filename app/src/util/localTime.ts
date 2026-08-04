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

/**
 * Absolute UTC instant (ms) corresponding to a local "YYYY-MM-DD" date and
 * "HH:MM" time in the given timezone. `new Date(`${date}T${time}`)` parses in
 * the SERVER's local timezone, not `tz` — wrong whenever the two differ (e.g.
 * a UTC container computing a Europe/Madrid tour time). Probes a naive local
 * parse against Intl's rendering of that same instant in `tz`, then corrects
 * by the observed diff — robust across DST without a date library dependency.
 */
export function localDateTimeToUtcMs(date: string, hhmm: string, tz: string): number {
  const [hh, mm] = hhmm.split(':').map(Number);
  const probeLocal = new Date(`${date}T${hhmm}:00`); // naive local (wrong tz, but a stable anchor)
  const fmtProbe = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(probeLocal);
  const pDate = fmtProbe.find((p) => p.type === 'year')?.value + '-' +
    fmtProbe.find((p) => p.type === 'month')?.value + '-' +
    fmtProbe.find((p) => p.type === 'day')?.value;
  const pHH = Number(fmtProbe.find((p) => p.type === 'hour')?.value ?? 0);
  const pMM = Number(fmtProbe.find((p) => p.type === 'minute')?.value ?? 0);
  const diffMs =
    (pDate === date ? 0 : pDate < date ? 86400000 : -86400000) +
    ((pHH - hh!) * 60 + (pMM - mm!)) * 60000;
  return probeLocal.getTime() - diffMs;
}
