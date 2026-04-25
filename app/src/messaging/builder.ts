import type { Tour, BookingEvent } from '../types';
import type { ToursConfig, TemplatesConfig } from '../config/schemas';

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
    if (!cfg) continue;
    const block = interpolate(input.templates.tour_block, {
      emoji: cfg.emoji,
      time_range: `${t.startTime}-${t.endTime}`,
      name_he: cfg.name_he,
      description_he: cfg.description_he.trim(),
      meeting_point_he: cfg.meeting_point_he,
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
}

export function buildBookingConfirmation(input: BookingConfirmationInput): string {
  const cfg = input.toursConfig.tours[input.event.tourId];
  const tourName = cfg?.name_he ?? input.event.tourId;
  return interpolate(input.templates.booking_confirmation, {
    client_name: input.event.clientName,
    tour_name_he: tourName,
    date: input.event.date,
    time: input.event.time,
  });
}
