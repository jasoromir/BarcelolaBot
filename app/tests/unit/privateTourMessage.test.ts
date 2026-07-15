import { describe, it, expect } from 'vitest';
import { detectMissingInfo, buildPrivateTourReminder } from '../../src/messaging/privateTourMessage.js';
import { resolveMeetingPointFromTourName, type MeetingPointResolution } from '../../src/messaging/meetingPointResolver.js';
import type { TemplatesConfig, ToursConfig } from '../../src/config/schemas.js';
import type { PrivateTourEventRow } from '../../src/persistence/privateTourEvents.js';

const templates: TemplatesConfig = {
  night_header: '', morning_header: '', footer: '', tour_block: '',
  booking_confirmation: '', booking_confirmation_lt24h: '', reminder_24h: '',
  confirmation_ack: '', confirmation_update_ack: '', cancel_ack: '', anti_reply_footer: '',
  unmanaged_number_reply: '', no_reply_alert: '', worker_forward: '', cancel_notice: '',
  private_tour_guide_reminder:
    'היי {guide_name} 👋\n🚩 *{tour_name}*\n🕒 מחר בשעה *{time}*\n👤 *{client_name}* ({people_count} משתתפים)\n📞 {client_phone}\n{meeting_point_line}\n',
  private_tour_missing_info_block: '\n⚠️ *חסרים פרטים לבירור:*\n{missing_fields_list}\n',
};

// Must match the real tourId the production keyword table maps "גאודי" to
// (src/messaging/meetingPointResolver.ts) — resolveMeetingPointFromTourName
// matches against that hardcoded table, not against this fixture's own keys.
const GAUDI_ID = 'd9807937-2c23-4f57-9eec-232ba2360f37';
const tours: ToursConfig = {
  tours: {
    [GAUDI_ID]: {
      name_he: 'גאודי',
      emoji: '🌻',
      description_he: '',
      meeting_point_he: 'Hard Rock Cafe, Plaça de Catalunya',
      google_maps_url: 'https://maps.app.goo.gl/xyz',
    },
  },
};

function baseEvent(overrides: Partial<PrivateTourEventRow> = {}): PrivateTourEventRow {
  return {
    eventId: 'evt-1',
    contentHash: 'hash',
    startAtIso: '2026-07-14T08:00:00.000Z',
    endAtIso: '2026-07-14T11:00:00.000Z',
    rawSummary: 'סיור גאודי פרטי. דנה. 5 אנשים. מדריך אדיר',
    rawDescription: null,
    rawLocation: null,
    tourName: 'גאודי',
    guide: 'אדיר',
    clientName: 'דנה',
    peopleCount: '5',
    phone: '+972544211402',
    email: null,
    meetingPoint: null,
    parsedAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('detectMissingInfo', () => {
  it('flags nothing missing when guide, phone, and an inferred meeting point are all present', () => {
    const event = baseEvent();
    const resolution = resolveMeetingPointFromTourName(event.tourName, tours);
    const missing = detectMissingInfo(event, resolution, event.meetingPoint);
    expect(missing.any).toBe(false);
    expect(missing.labels).toEqual([]);
  });

  it('flags missing guide', () => {
    const event = baseEvent({ guide: null });
    const resolution = resolveMeetingPointFromTourName(event.tourName, tours);
    const missing = detectMissingInfo(event, resolution, event.meetingPoint);
    expect(missing.missingGuide).toBe(true);
    expect(missing.any).toBe(true);
  });

  it('flags missing phone', () => {
    const event = baseEvent({ phone: null });
    const resolution = resolveMeetingPointFromTourName(event.tourName, tours);
    const missing = detectMissingInfo(event, resolution, event.meetingPoint);
    expect(missing.missingPhone).toBe(true);
  });

  it('flags an ambiguous meeting point with a distinct message from a simply-unknown one', () => {
    const event = baseEvent({ tourName: 'גותי בורן', meetingPoint: null });
    const ambiguousResolution: MeetingPointResolution = {
      matchedTourIds: ['a', 'b'],
      tourId: null,
      meetingPointHe: null,
      mapsUrl: null,
      ambiguous: true,
    };
    const missing = detectMissingInfo(event, ambiguousResolution, null);
    expect(missing.missingMeetingPoint).toBe(true);
    expect(missing.labels[0]).toContain('לא ברורה');
  });

  it('does not flag missing meeting point when the event has its own explicit one', () => {
    const event = baseEvent({ tourName: null, meetingPoint: 'Some Hotel' });
    const resolution = resolveMeetingPointFromTourName(event.tourName, tours);
    const missing = detectMissingInfo(event, resolution, event.meetingPoint);
    expect(missing.missingMeetingPoint).toBe(false);
  });
});

describe('buildPrivateTourReminder', () => {
  it('renders the guide copy with tour, time, client, phone, and inferred meeting point', () => {
    const event = baseEvent();
    const resolution = resolveMeetingPointFromTourName(event.tourName, tours);
    const body = buildPrivateTourReminder({
      event,
      templates,
      resolution,
      timeLocal: '10:00',
      recipientGuideLabel: 'אדיר',
      forManager: false,
    });
    expect(body).toContain('היי אדיר');
    expect(body).toContain('גאודי');
    expect(body).toContain('10:00');
    expect(body).toContain('דנה');
    expect(body).toContain('+972544211402');
    expect(body).toContain('Hard Rock Cafe, Plaça de Catalunya');
    expect(body).toContain('https://maps.app.goo.gl/xyz');
    // Guide copy never gets the missing-info addendum, even if something were missing.
    expect(body).not.toContain('חסרים פרטים');
  });

  it('an explicit event meeting point wins over catalog inference, and omits the maps line (no catalog url to attach)', () => {
    const event = baseEvent({ meetingPoint: 'Hotel Custom, Some Street 5' });
    const resolution = resolveMeetingPointFromTourName(event.tourName, tours);
    const body = buildPrivateTourReminder({
      event, templates, resolution, timeLocal: '10:00', recipientGuideLabel: 'אדיר', forManager: false,
    });
    expect(body).toContain('Hotel Custom, Some Street 5');
    expect(body).not.toContain('Hard Rock Cafe');
    expect(body).not.toContain('maps.app.goo.gl');
  });

  it('omits the meeting-point line entirely when neither explicit nor inferred is available', () => {
    const event = baseEvent({ tourName: null, meetingPoint: null });
    const resolution = resolveMeetingPointFromTourName(event.tourName, tours);
    const body = buildPrivateTourReminder({
      event, templates, resolution, timeLocal: '10:00', recipientGuideLabel: 'אדיר', forManager: false,
    });
    expect(body).not.toContain('נקודת מפגש');
  });

  it('appends the missing-info block only for the manager copy, with correct labels', () => {
    const event = baseEvent({ guide: null, tourName: 'גותי בורן', meetingPoint: null });
    const ambiguousResolution: MeetingPointResolution = {
      matchedTourIds: ['a', 'b'],
      tourId: null,
      meetingPointHe: null,
      mapsUrl: null,
      ambiguous: true,
    };

    const guideCopy = buildPrivateTourReminder({
      event, templates, resolution: ambiguousResolution, timeLocal: '10:00',
      recipientGuideLabel: 'מדריך/ה', forManager: false,
    });
    expect(guideCopy).not.toContain('חסרים פרטים');

    const managerCopy = buildPrivateTourReminder({
      event, templates, resolution: ambiguousResolution, timeLocal: '10:00',
      recipientGuideLabel: 'ליאנה', forManager: true,
    });
    expect(managerCopy).toContain('⚠️ *חסרים פרטים לבירור:*');
    expect(managerCopy).toContain('מדריך/ה לא זוהה מהיומן');
    expect(managerCopy).toContain('נקודת מפגש לא ברורה');
  });

  it('the manager copy has no addendum when nothing is missing', () => {
    const event = baseEvent();
    const resolution = resolveMeetingPointFromTourName(event.tourName, tours);
    const managerCopy = buildPrivateTourReminder({
      event, templates, resolution, timeLocal: '10:00', recipientGuideLabel: 'ליאנה', forManager: true,
    });
    expect(managerCopy).not.toContain('חסרים פרטים');
  });
});
