import type { ToursConfig } from '../config/schemas.js';

export interface KeywordEntry {
  keyword: string;
  tourId: string;
}

/**
 * Hand-curated keyword → tourId table for inferring a private tour's meeting
 * point from its (LLM-parsed) name. Not fuzzy-matched against tours.yaml's
 * name_he directly — some entries there are literal English strings (e.g.
 * "Born to be Wild"), so Hebrew substring matching against name_he wouldn't
 * reliably work. Order doesn't matter here; resolveMeetingPointFromTourName
 * sorts by keyword length before matching so longer, more specific phrases
 * (e.g. "הר היהודים") are tried — and consumed — before shorter ones that
 * might otherwise spuriously match a substring of them (e.g. bare "יהודי").
 */
export const PRIVATE_TOUR_KEYWORD_TABLE: KeywordEntry[] = [
  { keyword: 'הר היהודים', tourId: 'abccdd90-4eae-4b1b-8f37-401a69236973' }, // must precede bare "יהודי"
  { keyword: 'הסיפור היהודי', tourId: '2a41c826-3038-4de7-b1bc-8c7783c36f65' },
  { keyword: 'יהודי', tourId: '2a41c826-3038-4de7-b1bc-8c7783c36f65' },
  { keyword: 'חפש את הדרקון', tourId: '85ed2080-ef9f-4b18-9c75-565910cc5326' },
  { keyword: 'דרקון', tourId: '85ed2080-ef9f-4b18-9c75-565910cc5326' },
  { keyword: 'גותי', tourId: '4422ee5f-957b-45c8-bf06-876482fd2b57' },
  { keyword: 'בורן', tourId: 'dc36e0c8-8ff7-423f-96d9-ed665f1c811b' }, // deliberately conflicts with גותי
  { keyword: 'גאודי', tourId: 'd9807937-2c23-4f57-9eec-232ba2360f37' },
  { keyword: 'שוקולולה', tourId: '45ad4093-4d64-45f0-b06b-7f4d5057151f' },
  { keyword: 'דאלי', tourId: '080f3740-493b-4904-88e0-81fc1d9edc86' },
  { keyword: 'אופניים', tourId: 'cb3cabd9-a49b-49e9-a0dc-98b6b06bc91e' },
  { keyword: 'רכוב', tourId: 'cb3cabd9-a49b-49e9-a0dc-98b6b06bc91e' },
  { keyword: 'מונטסראט', tourId: '65eaee7a-986d-4dc3-a354-4d5c7a43ff40' },
  { keyword: 'קוסטה בראווה', tourId: 'a0cc2580-243a-4769-ae18-d251d5138834' },
  { keyword: 'קאמפ נואו', tourId: '83faaa08-7ce3-4cf5-8743-637f2b92371b' },
  { keyword: 'גרפיטי', tourId: 'dd8af144-a2d1-437a-84b9-223b4c09ad8b' },
  { keyword: 'פלמנקו', tourId: '2938c20e-73bb-46c1-8230-241fd38180ed' },
];

export interface MeetingPointResolution {
  /** Distinct tourIds matched, for logging/debugging. */
  matchedTourIds: string[];
  /** The single resolved tourId, or null when zero or multiple distinct tours matched. */
  tourId: string | null;
  meetingPointHe: string | null;
  mapsUrl: string | null;
  /** True when 2+ DISTINCT tourIds matched — deliberately left unresolved rather than guessed. */
  ambiguous: boolean;
}

/**
 * Longest-keyword-first substring match with consumption: once a keyword
 * matches, its matched span is removed from the working string so shorter,
 * more generic keywords contained within it (e.g. "יהודי" inside "הר
 * היהודים") don't also register as a separate, spurious match. Ambiguity is
 * judged by the count of DISTINCT matched tourIds, not the count of matched
 * keywords — e.g. "גותי בורן" matches two keywords that resolve to two
 * different tours with different meeting points, so it's correctly flagged
 * ambiguous rather than guessed.
 */
export function resolveMeetingPointFromTourName(
  tourName: string | null | undefined,
  tours: ToursConfig,
): MeetingPointResolution {
  const empty: MeetingPointResolution = {
    matchedTourIds: [],
    tourId: null,
    meetingPointHe: null,
    mapsUrl: null,
    ambiguous: false,
  };
  if (!tourName) return empty;

  let remaining = tourName;
  const matched = new Set<string>();
  const byLength = [...PRIVATE_TOUR_KEYWORD_TABLE].sort((a, b) => b.keyword.length - a.keyword.length);
  for (const entry of byLength) {
    if (remaining.includes(entry.keyword)) {
      matched.add(entry.tourId);
      remaining = remaining.split(entry.keyword).join('');
    }
  }

  const ids = Array.from(matched);
  if (ids.length !== 1) {
    return { ...empty, matchedTourIds: ids, ambiguous: ids.length > 1 };
  }

  const tour = tours.tours[ids[0]!];
  return {
    matchedTourIds: ids,
    tourId: ids[0]!,
    meetingPointHe: tour?.meeting_point_he || null,
    mapsUrl: tour?.google_maps_url ?? null,
    ambiguous: false,
  };
}
