/**
 * Compute when the day-before reminder should fire for a tour: the fixed
 * clock time `reminder_send_time` (e.g. "10:00") on the calendar day before
 * the tour, in the given timezone. Falls back to `tourStart - leadTimeHours`
 * if reminder_send_time is not set. Shared by the booking webhook (which
 * schedules the reminder at booking time) and the Wix backfill sweep (which
 * schedules it retroactively for bookings that were never queued).
 */
export function computeReminderSendAtMs(input: {
  startAtMs: number;
  reminderSendTime?: string;
  leadTimeHours: number;
  timezone: string;
}): number {
  const { startAtMs, reminderSendTime, leadTimeHours, timezone: tz } = input;
  if (!reminderSendTime) return startAtMs - leadTimeHours * 3_600_000;
  // Get the tour date (YYYY-MM-DD) in the local timezone.
  const tourDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(startAtMs));
  const [tourY, tourM, tourD] = tourDateStr.split('-').map(Number);
  // Day before = subtract 1 from the day (Intl handles month rollover for us
  // by constructing from a Date).
  const dayBefore = new Date(Date.UTC(tourY!, tourM! - 1, tourD! - 1, 12, 0, 0));
  const dayBeforeStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(dayBefore);
  // Build "YYYY-MM-DDTHH:MM:00" in local time, then parse as UTC offset via
  // Intl so we get the correct absolute instant regardless of DST.
  const [hh, mm] = reminderSendTime.split(':').map(Number);
  // Find the UTC instant that corresponds to reminderSendTime on dayBeforeStr
  // in tz. Strategy: try candidate UTC offsets by bisecting on what the local
  // time would be at that instant. Simpler: use Date with a known-offset
  // approach. We approximate by formatting a probe instant and adjusting.
  const probeLocal = new Date(`${dayBeforeStr}T${reminderSendTime}:00`); // naive local (wrong tz)
  // Adjust for the difference between the probe's local interpretation and tz.
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
    (pDate === dayBeforeStr ? 0 : pDate < dayBeforeStr ? 86400000 : -86400000) +
    ((pHH - hh!) * 60 + (pMM - mm!)) * 60000;
  return probeLocal.getTime() - diffMs;
}
