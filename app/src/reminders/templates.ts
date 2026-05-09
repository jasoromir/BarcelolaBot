import type { TemplatesConfig, ToursConfig } from '../config/schemas.js';
import type { ReminderRow } from '../persistence/reminders.js';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

function fmtDateDDMMYY(iso: string, tz = 'Europe/Madrid'): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const d = parts.find((p) => p.type === 'day')?.value ?? '';
  const m = parts.find((p) => p.type === 'month')?.value ?? '';
  const y = parts.find((p) => p.type === 'year')?.value ?? '';
  return `${d}/${m}/${y}`;
}

function fmtTime(iso: string, tz = 'Europe/Madrid'): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function antiReplyFooter(template: string, officialContactNumber: string): string {
  return interpolate(template, { official_contact_number: officialContactNumber });
}

export interface ReminderTemplateInput {
  reminder: ReminderRow;
  templates: TemplatesConfig;
  tours: ToursConfig;
  officialContactNumber: string;
}

export function buildReminder24h(input: ReminderTemplateInput): string {
  const tourName = resolveTourName(input.reminder, input.tours);
  const footer = antiReplyFooter(input.templates.anti_reply_footer, input.officialContactNumber);
  return interpolate(input.templates.reminder_24h, {
    client_name: input.reminder.clientName ?? 'Guest',
    tour_name_he: tourName,
    date: fmtDateDDMMYY(input.reminder.startAtIso),
    time: fmtTime(input.reminder.startAtIso),
    participant_count: String(input.reminder.participantCount),
    anti_reply_footer: footer,
  });
}

export interface ConfirmationAckInput {
  reminder: ReminderRow;
  templates: TemplatesConfig;
  tours: ToursConfig;
  officialContactNumber: string;
}

export function buildConfirmationAck(input: ConfirmationAckInput): string {
  const tour = input.reminder.tourId
    ? input.tours.tours[input.reminder.tourId]
    : undefined;
  const tourName = resolveTourName(input.reminder, input.tours);
  const meetingPoint = tour?.meeting_point_he ?? '';
  const mapsUrlLine = tour?.google_maps_url ? `📍 ${tour.google_maps_url}` : '';
  const footer = antiReplyFooter(input.templates.anti_reply_footer, input.officialContactNumber);
  return interpolate(input.templates.confirmation_ack, {
    client_name: input.reminder.clientName ?? 'Guest',
    tour_name_he: tourName,
    date: fmtDateDDMMYY(input.reminder.startAtIso),
    time: fmtTime(input.reminder.startAtIso),
    participant_count: String(input.reminder.participantCount),
    meeting_point_he: meetingPoint,
    maps_url_line: mapsUrlLine,
    anti_reply_footer: footer,
  });
}

export interface CancelAckInput {
  reminder: ReminderRow;
  templates: TemplatesConfig;
  officialContactNumber: string;
}

export function buildCancelAck(input: CancelAckInput): string {
  return interpolate(input.templates.cancel_ack, {
    client_name: input.reminder.clientName ?? 'Guest',
    official_contact_number: input.officialContactNumber,
  });
}

export interface WorkerForwardInput {
  reminder: ReminderRow;
  templates: TemplatesConfig;
  message: string;
}

export function buildWorkerForward(input: WorkerForwardInput): string {
  return interpolate(input.templates.worker_forward, {
    client_name: input.reminder.clientName ?? 'Guest',
    phone: input.reminder.phone,
    tour_name_he: input.reminder.tourNameHe ?? '(unknown)',
    date: fmtDateDDMMYY(input.reminder.startAtIso),
    time: fmtTime(input.reminder.startAtIso),
    message: input.message,
  });
}

function resolveTourName(reminder: ReminderRow, tours: ToursConfig): string {
  if (reminder.tourId && tours.tours[reminder.tourId]?.name_he) {
    return tours.tours[reminder.tourId]!.name_he;
  }
  return reminder.tourNameHe ?? 'הסיור';
}
