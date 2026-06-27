import type { Tour, BookingEvent } from '../types.js';
import type { ToursConfig, TemplatesConfig } from '../config/schemas.js';
import type { ReminderRow } from '../persistence/reminders.js';

const WEEKDAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function weekdayHe(dateIso: string): string {
  const [y, m, d] = dateIso.split('-').map((n) => Number(n));
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 12, 0, 0));
  return WEEKDAYS_HE[dt.getUTCDay()] ?? '';
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

export interface BroadcastInput {
  kind: 'night' | 'morning';
  date: string;
  tours: Tour[];
  toursConfig: ToursConfig;
  templates: TemplatesConfig;
}

function dateDDMMYYYY(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

export function buildBroadcastMessage(input: BroadcastInput): string {
  const header =
    input.kind === 'night' ? input.templates.night_header : input.templates.morning_header;
  const headerVars = { weekday_he: weekdayHe(input.date), date: dateDDMMYYYY(input.date) };
  const parts: string[] = [interpolate(header, headerVars)];

  const sorted = [...input.tours].sort((a, b) => a.startTime.localeCompare(b.startTime));
  for (const t of sorted) {
    const cfg = input.toursConfig.tours[t.id];
    const emoji = cfg?.emoji ?? '🌻';
    const nameHe = cfg?.name_he ?? t.tourTitle ?? 'סיור';
    const descriptionHe = cfg?.description_he?.trim() ?? '';
    const meetingPointHe = cfg?.meeting_point_he ?? t.location ?? '';
    const mapsUrl = cfg?.google_maps_url ?? '';
    const mapsUrlLine = mapsUrl ? `📍 ${mapsUrl}` : '';
    const block = interpolate(input.templates.tour_block, {
      emoji,
      time_range: `${t.startTime}-${t.endTime}`,
      name_he: nameHe,
      description_he: descriptionHe,
      meeting_point_he: meetingPointHe,
      maps_url_line: mapsUrlLine,
    });
    parts.push(block);
  }
  parts.push(input.templates.footer);
  return parts.join('\n\n');
}

export interface BookingConfirmationInput {
  event: BookingEvent;
  toursConfig: ToursConfig;
  templates: TemplatesConfig;
  /** true when tour starts within combine_threshold_hours — render the combined template. */
  combined?: boolean;
  /** Official contact number string shown in the anti-reply footer. */
  officialContactNumber: string;
}

export function buildBookingConfirmation(input: BookingConfirmationInput): string {
  const cfg = input.toursConfig.tours[input.event.tourId];
  const tourName = cfg?.name_he ?? input.event.tourTitle ?? 'הסיור';

  const [year, month, day] = input.event.date.split('-');
  const formattedDate = `${day}/${month}/${year?.slice(2)}`;

  const footer = interpolate(input.templates.anti_reply_footer, {
    official_contact_number: input.officialContactNumber,
  });

  const template = input.combined
    ? input.templates.booking_confirmation_lt24h
    : input.templates.booking_confirmation;

  return interpolate(template, {
    client_name: input.event.clientName,
    tour_name_he: tourName,
    date: formattedDate,
    time: input.event.time,
    participant_count: String(input.event.participantCount || 1),
    official_contact_number: input.officialContactNumber,
    anti_reply_footer: footer,
  });
}

export interface WorkerNightlySummaryInput {
  date: string; // YYYY-MM-DD, the tour date (tomorrow)
  tours: Tour[]; // from Wix (sorted by startTime)
  reminders: ReminderRow[]; // from RemindersStore.forDate(date)
  toursConfig: ToursConfig;
}

/**
 * Builds a Hebrew internal summary for the Barcelola BOT worker group, sent
 * alongside the nightly broadcast. Shows per-tour: confirmed, awaiting reply
 * (with phone numbers), and cancelled.
 */
export function buildWorkerNightlySummary(input: WorkerNightlySummaryInput): string {
  const { date, tours, reminders, toursConfig } = input;
  const day = weekdayHe(date);
  const [y, m, d] = date.split('-');
  const dateFmt = `${d}/${m}/${String(y).slice(2)}`;

  const lines: string[] = [`📋 *סיכום מחר — יום ${day} ${dateFmt}*`];

  if (tours.length === 0) {
    lines.push('אין סיורים מחר.');
    return lines.join('\n');
  }

  for (const tour of tours) {
    const cfg = toursConfig.tours[tour.id];
    const name = cfg?.name_he ?? tour.tourTitle ?? tour.id;
    const emoji = cfg?.emoji ?? '🌻';

    // Bucket this tour's reminders by status
    const tourReminders = reminders.filter((r) => r.tourId === tour.id);
    const confirmed = tourReminders.filter((r) => r.status === 'confirmed');
    const awaiting = tourReminders.filter(
      (r) => r.status === 'awaiting_reply' || r.status === 'awaiting_send',
    );
    const cancelled = tourReminders.filter((r) => r.status === 'cancelled');

    lines.push('');
    lines.push(`${emoji} *${name}* — ${tour.startTime}`);

    if (confirmed.length > 0) {
      const names = confirmed.map((r) => r.clientName ?? r.phone).join(', ');
      lines.push(`✅ מאשרים (${confirmed.length}): ${names}`);
    } else {
      lines.push(`✅ מאשרים: אין`);
    }

    if (awaiting.length > 0) {
      lines.push(`⏳ ממתינים לתשובה (${awaiting.length}):`);
      for (const r of awaiting) {
        const name = r.clientName ?? 'לא ידוע';
        lines.push(`   • ${name} — ${r.phone}`);
      }
    } else {
      lines.push(`⏳ ממתינים לתשובה: אין`);
    }

    if (cancelled.length > 0) {
      const names = cancelled.map((r) => r.clientName ?? r.phone).join(', ');
      lines.push(`❌ ביטולים (${cancelled.length}): ${names}`);
    }
  }

  return lines.join('\n');
}
