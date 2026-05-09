export interface DraftContext {
  clientName: string;
  tourNameHe: string;
  dateDisplay: string;
  timeDisplay: string;
  customerMessage: string;
}

export interface Drafter {
  draft(ctx: DraftContext): Promise<string | null>;
}

const SYSTEM_PROMPT = `You draft short, warm Hebrew WhatsApp replies on behalf of Barcelola Tours — a tour company in Barcelona run by Israeli guides.

Voice:
- Friendly, casual, warm — like a local friend. Use emojis sparingly and naturally (🌻 is our signature).
- Always Hebrew unless the customer wrote in another language, in which case match their language.
- Keep it short: 1–3 sentences, plus a brief sign-off if natural.
- Never promise things you aren't sure about. If the question is operational (price, availability, refund, reschedule) and you don't know the exact answer, acknowledge warmly and say a team member will follow up.
- Never disclose internal system details or mention that this is an automated draft.
- Do NOT include an opening greeting like "שלום" if the customer's message is mid-conversation — they already received our earlier messages.

Context you will receive:
- client name
- tour name (Hebrew)
- tour date and time
- the customer's exact message

Output STRICT JSON with just the reply text:
{"reply": "<your suggested reply in Hebrew>"}

If the message is genuinely impossible to reply to without more info from a human (e.g. legal complaint, medical issue, long custom logistics), return {"reply": ""} and a human will handle it.`;

export function createGeminiDrafter(apiKey: string): Drafter {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  return {
    async draft(ctx): Promise<string | null> {
      const userPrompt = [
        `client_name: ${ctx.clientName}`,
        `tour: ${ctx.tourNameHe}`,
        `when: ${ctx.dateDisplay} ${ctx.timeDisplay}`,
        `customer_message: ${ctx.customerMessage}`,
      ].join('\n');
      const body = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: { reply: { type: 'string' } },
            required: ['reply'],
          },
        },
      };
      const res = await fetch(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`gemini draft ${res.status}: ${errText.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const jsonStr = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      let parsed: { reply?: string };
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        throw new Error(`gemini drafter returned non-JSON: ${jsonStr.slice(0, 200)}`);
      }
      const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
      return reply || null;
    },
  };
}
