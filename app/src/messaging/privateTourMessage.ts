import type { TemplatesConfig } from '../config/schemas.js';
import type { PrivateTourEventRow } from '../persistence/privateTourEvents.js';
import type { MeetingPointResolution } from './meetingPointResolver.js';
import { interpolate } from '../reminders/templates.js';

export interface MissingInfoCheck {
  missingGuide: boolean;
  missingPhone: boolean;
  missingMeetingPoint: boolean;
  any: boolean;
  labels: string[];
}

/**
 * Flags what a private-tour booking is missing so the manager's copy can
 * carry a chase-it-down addendum. The guide's own copy never sees this — it
 * just renders whatever fields are present, staying clean.
 */
export function detectMissingInfo(
  event: Pick<PrivateTourEventRow, 'guide' | 'phone'>,
  resolution: MeetingPointResolution,
  explicitMeetingPoint: string | null,
): MissingInfoCheck {
  const missingGuide = !event.guide;
  const missingPhone = !event.phone;
  const missingMeetingPoint = !explicitMeetingPoint && !resolution.meetingPointHe;

  const labels: string[] = [];
  if (missingGuide) labels.push('• מדריך/ה לא זוהה מהיומן');
  if (missingPhone) labels.push('• לא נמצא מספר טלפון של הלקוח');
  if (missingMeetingPoint) {
    labels.push(
      resolution.ambiguous
        ? '• נקודת מפגש לא ברורה — הסיור תואם למספר סיורים קטלוגיים עם נקודות מפגש שונות'
        : '• נקודת מפגש לא ידועה',
    );
  }

  return { missingGuide, missingPhone, missingMeetingPoint, any: labels.length > 0, labels };
}

export interface BuildPrivateTourReminderOpts {
  event: PrivateTourEventRow;
  templates: TemplatesConfig;
  resolution: MeetingPointResolution;
  /** "HH:MM" local start time. */
  timeLocal: string;
  /** Display name used in the greeting (the recipient's own name, guide or manager). */
  recipientGuideLabel: string;
  /** When true, appends the missing-info block if anything is missing. */
  forManager: boolean;
}

/**
 * Builds the Hebrew day-before reminder for a single private tour booking.
 * The event's own explicit meeting point (LLM-extracted from the calendar
 * entry) always wins over catalog-based inference.
 */
export function buildPrivateTourReminder(opts: BuildPrivateTourReminderOpts): string {
  const { event, resolution } = opts;
  const explicitMeetingPoint = event.meetingPoint?.trim() || null;
  const meetingPointText = explicitMeetingPoint || resolution.meetingPointHe;
  const meetingPointLine = meetingPointText
    ? `📍 נקודת מפגש: ${meetingPointText}${!explicitMeetingPoint && resolution.mapsUrl ? `\n${resolution.mapsUrl}` : ''}`
    : '';

  let body = interpolate(opts.templates.private_tour_guide_reminder, {
    guide_name: opts.recipientGuideLabel,
    tour_name: event.tourName ?? 'סיור פרטי',
    time: opts.timeLocal,
    client_name: event.clientName ?? 'אורח/ת',
    people_count: event.peopleCount ?? '—',
    client_phone: event.phone ?? '—',
    meeting_point_line: meetingPointLine,
  });

  if (opts.forManager) {
    const missing = detectMissingInfo(event, resolution, explicitMeetingPoint);
    if (missing.any) {
      body += interpolate(opts.templates.private_tour_missing_info_block, {
        missing_fields_list: missing.labels.join('\n'),
      });
    }
  }

  return body;
}
