import { fetchWithGeminiRetry } from './classifier.js';
import type { ParsedTourFields } from '../persistence/privateTourEvents.js';

const SYSTEM_PROMPT = `You extract structured booking data from private-tour calendar events for Barcelola Tours, a Barcelona tour company. Event summaries and descriptions are free-text Hebrew (occasionally English/Spanish) with no fixed format, written by staff.

You will receive the event's summary, description, and location. Extract:
- tour_name: the tour type/theme in Hebrew, e.g. "גותי בורן", "גאודי", "שוקולולה", "חפש את הדרקון", "הר היהודים", "דרקון". If multiple tours are combined (e.g. "משולב גותי בורן"), include both. If it's a custom/described itinerary with no named tour, summarize briefly (e.g. "טיול יום מותאם אישית"). null if truly undeterminable.
- guide_name: the guide's first name(s) exactly as written (e.g. "ליאנה", "אדיר", "ליאנה/עדי" if two guides are listed). null if not mentioned.
- client_name: the customer's name or family name (e.g. "דנה", "משפחת ורד"). This is a PERSON or FAMILY name, never a guide name, tour name, or generic word. null if not mentioned.
- people_count: the number of participants as written, including extra notes like "+ 2 children" if present (e.g. "5", "4-6", "20 + שני פעוטות"). null if not mentioned.
- phone: the client's phone number, normalized to just digits and a leading + if international (e.g. "+972544211402"). null if not present. NEVER confuse a guide's or staff phone with the client's — the client's phone appears near their name/booking details.
- email: the client's email address if present. null otherwise.
- meeting_point: the pickup/meeting location if explicitly mentioned (hotel name, address, "איסוף מהמלון", a maps link, or landmark). null if not mentioned — do NOT invent a default meeting point.

Output STRICT JSON matching this schema, nothing else:
{"tour_name": string|null, "guide_name": string|null, "client_name": string|null, "people_count": string|null, "phone": string|null, "email": string|null, "meeting_point": string|null}`;

export async function llmParsePrivateEvent(
  apiKey: string,
  input: { summary: string; description?: string | null; location?: string | null },
): Promise<ParsedTourFields> {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const userPrompt = [
    `summary: ${input.summary}`,
    `description: ${input.description ?? '(none)'}`,
    `location: ${input.location ?? '(none)'}`,
  ].join('\n');

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          tour_name: { type: 'string', nullable: true },
          guide_name: { type: 'string', nullable: true },
          client_name: { type: 'string', nullable: true },
          people_count: { type: 'string', nullable: true },
          phone: { type: 'string', nullable: true },
          email: { type: 'string', nullable: true },
          meeting_point: { type: 'string', nullable: true },
        },
        required: ['tour_name', 'guide_name', 'client_name', 'people_count', 'phone', 'email', 'meeting_point'],
      },
    },
  };

  const res = await fetchWithGeminiRetry(`${endpoint}?key=${encodeURIComponent(apiKey)}`, body);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`gemini private-event parse ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const jsonStr = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  let parsed: {
    tour_name?: string | null;
    guide_name?: string | null;
    client_name?: string | null;
    people_count?: string | null;
    phone?: string | null;
    email?: string | null;
    meeting_point?: string | null;
  };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`gemini private-event parse returned non-JSON: ${jsonStr.slice(0, 200)}`);
  }

  return {
    tourName: parsed.tour_name ?? null,
    guide: parsed.guide_name ?? null,
    clientName: parsed.client_name ?? null,
    peopleCount: parsed.people_count ?? null,
    phone: parsed.phone ?? null,
    email: parsed.email ?? null,
    meetingPoint: parsed.meeting_point ?? null,
  };
}
