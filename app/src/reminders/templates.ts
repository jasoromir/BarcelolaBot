import type { TemplatesConfig, ToursConfig } from '../config/schemas.js';
import type { ReminderRow } from '../persistence/reminders.js';

export function interpolate(template: string, vars: Record<string, string>): string {
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
  /** Fallback Google Maps pin used when the tour has no google_maps_url of its own. */
  defaultGoogleMapsUrl?: string;
  /** When the booking has a deposit, include a payment reminder line; omit otherwise. */
  depositLine?: string;
}

export function buildReminder24h(input: ReminderTemplateInput): string {
  const tour = input.reminder.tourId ? input.tours.tours[input.reminder.tourId] : undefined;
  const tourName = resolveTourName(input.reminder, input.tours);
  const footer = antiReplyFooter(input.templates.anti_reply_footer, input.officialContactNumber);
  // Meeting point + Google Maps pin, mirroring the morning/night broadcasts.
  const meetingPoint = tour?.meeting_point_he ?? '';
  const mapsUrl = tour?.google_maps_url ?? input.defaultGoogleMapsUrl;
  const mapsUrlLine = mapsUrl ? `📍 ${mapsUrl}` : '';
  return interpolate(input.templates.reminder_24h, {
    client_name: input.reminder.clientName ?? 'Guest',
    tour_name_he: tourName,
    date: fmtDateDDMMYY(input.reminder.startAtIso),
    time: fmtTime(input.reminder.startAtIso),
    participant_count: String(input.reminder.participantCount),
    meeting_point_he: meetingPoint,
    maps_url_line: mapsUrlLine,
    official_contact_number: input.officialContactNumber,
    anti_reply_footer: footer,
    // Empty string when no deposit — the template `{deposit_line}` becomes invisible.
    deposit_line: input.depositLine ?? '',
  });
}

export interface ConfirmationAckInput {
  reminder: ReminderRow;
  templates: TemplatesConfig;
  tours: ToursConfig;
  officialContactNumber: string;
  defaultGoogleMapsUrl?: string;
  /**
   * True when the customer is updating a count on an already-confirmed booking.
   * Renders a shorter "we updated your booking to N people" ack instead of
   * repeating the full confirmation with meeting point + map.
   */
  isUpdate?: boolean;
}

export function buildConfirmationAck(input: ConfirmationAckInput): string {
  const tour = input.reminder.tourId
    ? input.tours.tours[input.reminder.tourId]
    : undefined;
  const tourName = resolveTourName(input.reminder, input.tours);

  if (input.isUpdate) {
    return interpolate(input.templates.confirmation_update_ack, {
      client_name: input.reminder.clientName ?? 'Guest',
      tour_name_he: tourName,
      date: fmtDateDDMMYY(input.reminder.startAtIso),
      time: fmtTime(input.reminder.startAtIso),
      participant_count: String(input.reminder.participantCount),
    });
  }

  const meetingPoint = tour?.meeting_point_he ?? '';
  const mapsUrl = tour?.google_maps_url ?? input.defaultGoogleMapsUrl;
  const mapsUrlLine = mapsUrl ? `📍 ${mapsUrl}` : '';
  return interpolate(input.templates.confirmation_ack, {
    client_name: input.reminder.clientName ?? 'Guest',
    tour_name_he: tourName,
    date: fmtDateDDMMYY(input.reminder.startAtIso),
    time: fmtTime(input.reminder.startAtIso),
    participant_count: String(input.reminder.participantCount),
    meeting_point_he: meetingPoint,
    maps_url_line: mapsUrlLine,
    official_contact_number: input.officialContactNumber,
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
  suggestedReply: string | null;
}

export function buildWorkerForward(input: WorkerForwardInput): string {
  return interpolate(input.templates.worker_forward, {
    client_name: input.reminder.clientName ?? 'Guest',
    phone: input.reminder.phone,
    tour_name_he: input.reminder.tourNameHe ?? '(unknown)',
    date: fmtDateDDMMYY(input.reminder.startAtIso),
    time: fmtTime(input.reminder.startAtIso),
    message: input.message,
    suggested_reply: input.suggestedReply ?? '(לא נוצרה הצעה — טפלו ידנית)',
  });
}

export interface ClientResponseNoticeInput {
  reminder: ReminderRow;
  templates: TemplatesConfig;
  tours: ToursConfig;
  /** Which way the customer answered. */
  outcome: 'confirm' | 'cancel';
  /**
   * How the answer arrived — a text/emoji reply, or a reaction on the reminder.
   * Rendered so staff can tell a 👍 reaction apart from someone typing "מאשר".
   */
  via: 'text' | 'reaction';
  /** The customer's raw message, or the reaction emoji when via === 'reaction'. */
  rawText: string;
}

/**
 * Heads-up DM to the manager every time a customer confirms or cancels, so the
 * decision is visible without opening the admin panel or the worker group.
 */
export function buildClientResponseNotice(input: ClientResponseNoticeInput): string {
  const confirmed = input.outcome === 'confirm';
  return interpolate(input.templates.client_response_notice, {
    status_emoji: confirmed ? '✅' : '❌',
    status_text: confirmed ? 'אישר/ה הגעה' : 'ביטל/ה הגעה',
    client_name: input.reminder.clientName ?? 'Guest',
    phone: input.reminder.phone,
    tour_name_he: resolveTourName(input.reminder, input.tours),
    date: fmtDateDDMMYY(input.reminder.startAtIso),
    time: fmtTime(input.reminder.startAtIso),
    participant_count: String(input.reminder.participantCount),
    // The emoji itself is rendered by {raw_text}, so via_text stays a plain label
    // and doesn't repeat it.
    via_text: input.via === 'reaction' ? 'תגובה (ריאקשן)' : 'הודעת טקסט',
    raw_text: input.rawText,
  });
}

export interface CancelNoticeInput {
  reminder: ReminderRow;
  templates: TemplatesConfig;
  customerMessage: string;
  wixStatus: string;
}

export function buildCancelNotice(input: CancelNoticeInput): string {
  return interpolate(input.templates.cancel_notice, {
    client_name: input.reminder.clientName ?? 'Guest',
    phone: input.reminder.phone,
    tour_name_he: input.reminder.tourNameHe ?? '(unknown)',
    date: fmtDateDDMMYY(input.reminder.startAtIso),
    time: fmtTime(input.reminder.startAtIso),
    customer_message: input.customerMessage,
    wix_status: input.wixStatus,
  });
}

function resolveTourName(reminder: ReminderRow, tours: ToursConfig): string {
  if (reminder.tourId && tours.tours[reminder.tourId]?.name_he) {
    return tours.tours[reminder.tourId]!.name_he;
  }
  return reminder.tourNameHe ?? 'הסיור';
}
