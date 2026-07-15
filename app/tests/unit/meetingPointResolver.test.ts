import { describe, it, expect } from 'vitest';
import { resolveMeetingPointFromTourName } from '../../src/messaging/meetingPointResolver.js';
import type { ToursConfig } from '../../src/config/schemas.js';

const GOTI_ID = '4422ee5f-957b-45c8-bf06-876482fd2b57';
const BORN_ID = 'dc36e0c8-8ff7-423f-96d9-ed665f1c811b';
const GAUDI_ID = 'd9807937-2c23-4f57-9eec-232ba2360f37';
const HAR_YEHUDIM_ID = 'abccdd90-4eae-4b1b-8f37-401a69236973';
const YEHUDI_ID = '2a41c826-3038-4de7-b1bc-8c7783c36f65';

const tours: ToursConfig = {
  tours: {
    [GOTI_ID]: {
      name_he: 'גותיראמבלה ללא הפסקה',
      emoji: '🌻',
      description_he: '',
      meeting_point_he: 'Hard Rock Cafe, Plaça de Catalunya',
      google_maps_url: 'https://maps.app.goo.gl/3nbsJJytm6HnDGXL8',
    },
    [BORN_ID]: {
      name_he: 'Born to be Wild',
      emoji: '🍤',
      description_he: '',
      meeting_point_he: 'Hotel Suizo, Jaume I',
      google_maps_url: 'https://maps.app.goo.gl/BkAHf15vtccYCgJK8',
    },
    [GAUDI_ID]: {
      name_he: 'המסע בעקבות גאודי והמודרניסטה',
      emoji: '🌻',
      description_he: '',
      meeting_point_he: 'Hard Rock Cafe, Plaça de Catalunya',
      google_maps_url: 'https://maps.app.goo.gl/3nbsJJytm6HnDGXL8',
    },
    [HAR_YEHUDIM_ID]: {
      name_he: 'היהודים באים',
      emoji: '🏔️',
      description_he: '',
      meeting_point_he: 'Teatre Apolo, Paral·lel',
      google_maps_url: 'https://maps.app.goo.gl/yVfXg1haSD69Wbv78',
    },
    [YEHUDI_ID]: {
      name_he: 'הסיפור היהודי',
      emoji: '✡️',
      description_he: '',
      meeting_point_he: 'Hard Rock Cafe, Plaça de Catalunya',
      google_maps_url: 'https://maps.app.goo.gl/3nbsJJytm6HnDGXL8',
    },
  },
};

describe('resolveMeetingPointFromTourName', () => {
  it('resolves a single unambiguous keyword to its meeting point', () => {
    const r = resolveMeetingPointFromTourName('בורן', tours);
    expect(r.ambiguous).toBe(false);
    expect(r.tourId).toBe(BORN_ID);
    expect(r.meetingPointHe).toBe('Hotel Suizo, Jaume I');
  });

  it('resolves גאודי to its meeting point', () => {
    const r = resolveMeetingPointFromTourName('גאודי', tours);
    expect(r.tourId).toBe(GAUDI_ID);
    expect(r.meetingPointHe).toBe('Hard Rock Cafe, Plaça de Catalunya');
  });

  it('flags ambiguous when two distinct tours match (גותי בורן combines two tours with different meeting points)', () => {
    const r = resolveMeetingPointFromTourName('גותי בורן', tours);
    expect(r.ambiguous).toBe(true);
    expect(r.tourId).toBeNull();
    expect(r.meetingPointHe).toBeNull();
    expect(r.matchedTourIds.sort()).toEqual([GOTI_ID, BORN_ID].sort());
  });

  it('returns zero match (not ambiguous) for a custom itinerary with no known keyword', () => {
    const r = resolveMeetingPointFromTourName('טיול יום מותאם אישית', tours);
    expect(r.ambiguous).toBe(false);
    expect(r.tourId).toBeNull();
    expect(r.matchedTourIds).toEqual([]);
  });

  it('returns zero match for null/undefined tour name', () => {
    expect(resolveMeetingPointFromTourName(null, tours).tourId).toBeNull();
    expect(resolveMeetingPointFromTourName(undefined, tours).tourId).toBeNull();
  });

  it('resolves "הר היהודים" to the specific tour without spuriously also matching bare "יהודי"', () => {
    const r = resolveMeetingPointFromTourName('הר היהודים', tours);
    expect(r.ambiguous).toBe(false);
    expect(r.tourId).toBe(HAR_YEHUDIM_ID);
    expect(r.meetingPointHe).toBe('Teatre Apolo, Paral·lel');
  });

  it('resolves bare "יהודי" (without הר) to the general Jewish-story tour', () => {
    const r = resolveMeetingPointFromTourName('סיור יהודי פרטי', tours);
    expect(r.ambiguous).toBe(false);
    expect(r.tourId).toBe(YEHUDI_ID);
  });

  it('does not double-count the same tourId when two of its own keywords both match', () => {
    // "רכוב" and "אופניים" both map to the SAME real tourId (bike tour) in the
    // production keyword table — matching both should count as one distinct
    // id, not trigger a false ambiguity.
    const r = resolveMeetingPointFromTourName('סיור רכוב ואופניים', tours);
    expect(r.matchedTourIds.length).toBe(1);
    expect(r.ambiguous).toBe(false);
  });
});
