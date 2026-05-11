import type { Tour, BookingEvent } from '../types.js';
import type { ToursConfig, TemplatesConfig } from '../config/schemas.js';

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

export function buildBroadcastMessage(input: BroadcastInput): string {
  const header =
    input.kind === 'night' ? input.templates.night_header : input.templates.morning_header;
  const headerVars = { weekday_he: weekdayHe(input.date), date: input.date };
  const parts: string[] = [interpolate(header, headerVars)];

  const sorted = [...input.tours].sort((a, b) => a.startTime.localeCompare(b.startTime));
  for (const t of sorted) {
    const cfg = input.toursConfig.tours[t.id];
    // Fallback to Wix-provided data when the service_id isn't in tours.yaml
    // yet. Guides can still read the broadcast; we just lose the emoji and
    // the human-written description/meeting point for that tour.
    const emoji = cfg?.emoji ?? '🌻';
    const nameHe = cfg?.name_he ?? t.tourTitle ?? 'סיור';
    const descriptionHe = cfg?.description_he?.trim() ?? '';
    const meetingPointHe = cfg?.meeting_point_he ?? t.location ?? '';
    const block = interpolate(input.templates.tour_block, {
      emoji,
      time_range: `${t.startTime}-${t.endTime}`,
      name_he: nameHe,
      description_he: descriptionHe,
      meeting_point_he: meetingPointHe,
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
