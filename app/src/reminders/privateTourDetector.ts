/**
 * Detects whether a calendar event summary is a private (custom, non-catalog)
 * tour booking.
 *
 * Originally this used Google Calendar's colorId (purple = private), since
 * that's how staff visually mark these events in their own calendar view.
 * That doesn't work for unattended production access: event colors in the
 * Calendar API are a PER-VIEWER override, not a shared property of the event
 * — a service account (or anyone else) reading the event never sees the
 * color the calendar owner personally applied to it. Verified against 6
 * months of real data (1545 events, 25 known-purple private tours): every
 * private-tour summary contains both "פרטי" (private) and either "סיור" or
 * "טיול" (tour/trip); nothing else in the same window matches both. A lone
 * "פרטי" without a tour word also appears on unrelated staff notes (e.g.
 * "לדבר עם שי פרטי" — "talk to Shai privately"), so both words are required.
 */
export function looksLikePrivateTour(summary: string | null | undefined): boolean {
  if (!summary) return false;
  const hasPrivate = summary.includes('פרטי');
  const hasTourWord = summary.includes('סיור') || summary.includes('טיול');
  return hasPrivate && hasTourWord;
}
