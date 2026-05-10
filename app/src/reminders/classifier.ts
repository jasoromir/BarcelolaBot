export type ReplyIntent = 'confirm' | 'cancel' | 'update_count' | 'other';

/**
 * Gemini free-tier quota is bursty (15 RPM, 1M TPD). When we hit 429 we back
 * off with a progressively longer wait and try again. Persistent 429 after
 * the final attempt propagates up and the reply handler forwards to the
 * worker group (fail-open).
 */
export async function fetchWithGeminiRetry(
  url: string,
  body: unknown,
  delaysMs: number[] = [2_000, 5_000, 15_000],
): Promise<Response> {
  let attempt = 0;
  // One initial try + delaysMs.length retries.
  while (true) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 429) return res;
    const wait = delaysMs[attempt];
    if (wait === undefined) return res; // exhausted retries
    console.log(`[gemini] 429 quota, retrying in ${wait}ms (attempt ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, wait));
    attempt += 1;
  }
}

export interface ClassificationResult {
  intent: ReplyIntent;
  participantCount: number | null;
  confidence: number;
  raw?: unknown;
}

export interface Classifier {
  classify(text: string, context: ClassifyContext): Promise<ClassificationResult>;
}

export interface ClassifyContext {
  // current participant count on file, so the model can tell if a number is a
  // new count vs. just a repetition of the existing one
  currentCount: number;
}

const SYSTEM_PROMPT = `You classify short WhatsApp replies from customers of a Barcelona tour company. Replies are usually in Hebrew, occasionally Spanish, English, or mixed. Customers are replying to a message that asks them to confirm, cancel, or update the number of participants for a tour booking.

Output STRICT JSON matching this schema, nothing else:
{"intent": "confirm" | "cancel" | "update_count" | "other", "participant_count": number | null, "confidence": number}

Rules:
- "confirm": customer says they are coming / attending. Examples in Hebrew: מאשר, מגיע, מגיעים, נגיע, בא, באים, רואים אותך, אישור, ok, yes, כן. They may also include a number — if the number differs from current_count, still use intent="confirm" AND set participant_count.
- "cancel": customer says they cannot come / wants to cancel. Examples: מבטל, לא נוכל, לא יכול, בוטל, ביטול, לא מגיע, cancel, no. If they offer an excuse ("סליחה לא אוכל") still classify as cancel.
- "update_count": customer provides ONLY a new participant count without confirming or cancelling (e.g. "3", "נהיינו 4", "אנחנו 2 אנשים"). If in doubt between update_count and confirm, prefer confirm.
- "other": anything else — questions, greetings, small talk, complaints, language the other three categories don't fit.

confidence is 0..1. If ambiguous or the message mixes topics, lower the confidence. If confidence < 0.7 caller may forward to a human.

participant_count: extract the integer count only when clearly stated by the user. null otherwise. Ignore phone numbers, street numbers, dates, times.`;

export function createGeminiClassifier(apiKey: string): Classifier {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  return {
    async classify(text, context): Promise<ClassificationResult> {
      const userPrompt = `current_count: ${context.currentCount}\nmessage: ${text}`;
      const body = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              intent: {
                type: 'string',
                enum: ['confirm', 'cancel', 'update_count', 'other'],
              },
              participant_count: { type: 'integer', nullable: true },
              confidence: { type: 'number' },
            },
            required: ['intent', 'confidence'],
          },
        },
      };
      const res = await fetchWithGeminiRetry(
        `${endpoint}?key=${encodeURIComponent(apiKey)}`,
        body,
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`gemini ${res.status}: ${errText.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const jsonStr = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      let parsed: { intent: ReplyIntent; participant_count?: number | null; confidence: number };
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        throw new Error(`gemini returned non-JSON: ${jsonStr.slice(0, 200)}`);
      }
      return {
        intent: parsed.intent,
        participantCount:
          typeof parsed.participant_count === 'number' ? parsed.participant_count : null,
        confidence: parsed.confidence,
        raw: data,
      };
    },
  };
}
