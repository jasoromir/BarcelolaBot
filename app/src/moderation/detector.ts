import { fetchWithGeminiRetry } from '../reminders/classifier.js';

export interface DetectorSettings {
  /** Lowercased substrings that strongly indicate crypto/financial spam. */
  keywords: string[];
  /** A member is "new" for this many minutes after first being seen. */
  newJoinerWindowMinutes: number;
  /** score >= this → spam. */
  spamThreshold: number;
  /** score in [reviewMin, spamThreshold) → ask the LLM. Below reviewMin → ham. */
  reviewMin: number;
}

export interface DetectInput {
  body: string;
  /** Minutes since the sender first appeared in the group, or null if unknown. */
  senderAgeMinutes: number | null;
}

export type Verdict = 'spam' | 'ham' | 'review';

export interface DetectResult {
  verdict: Verdict;
  score: number;
  reasons: string[];
  /** True when the LLM was consulted to break a tie. */
  usedLlm: boolean;
}

// Group-invite links are the spammers' signature move — pulling customers into
// ANOTHER chat/channel. Collaborators (taxi, trips) link to websites, not group
// invites, so this is weighted much more heavily than a generic link.
const INVITE_LINK_RE = /chat\.whatsapp\.com\/|t\.me\/|t\.me$|telegram\.me\//i;
// Any other external link. Kept mild on purpose: legitimate collaborators share
// booking/website/maps links, so a plain link alone must not trigger a kick.
const GENERIC_LINK_RE = /https?:\/\/|www\.|wa\.me\//i;
const DOTTED_DOMAIN_RE = /\b[a-z0-9-]+\.(?:com|net|io|xyz|me|link|app|vip|club|live)\b/i;

export interface Detector {
  detect(input: DetectInput): Promise<DetectResult>;
}

/**
 * Hybrid spam detector. A cheap heuristic decides the clear cases for free;
 * only the ambiguous middle band is escalated to Gemini, keeping us far under
 * the free-tier quota. The LLM is optional — without an API key the middle
 * band resolves conservatively to ham (fail-open: never auto-kick on a guess).
 */
export function createDetector(settings: DetectorSettings, geminiApiKey: string): Detector {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  function heuristicScore(input: DetectInput): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;
    const text = input.body.toLowerCase();

    const matchedKeywords = settings.keywords.filter((k) => text.includes(k.toLowerCase()));
    if (matchedKeywords.length > 0) {
      score += Math.min(0.5, 0.25 * matchedKeywords.length);
      reasons.push(`keywords:${matchedKeywords.join('|')}`);
    }

    const hasInviteLink = INVITE_LINK_RE.test(input.body);
    const hasGenericLink =
      !hasInviteLink && (GENERIC_LINK_RE.test(input.body) || DOTTED_DOMAIN_RE.test(input.body));

    if (hasInviteLink) {
      // WhatsApp/Telegram group invite — the spammers' signature. On its own
      // it's already suspicious; combined with any investment keyword it's a
      // near-certain pitch. This is what collaborators do NOT do.
      score += 0.6;
      reasons.push('invite_link');
      if (matchedKeywords.length > 0) {
        score += 0.25;
        reasons.push('invite_link+keywords');
      }
    } else if (hasGenericLink) {
      // Plain website/maps link — legitimate collaborators (taxi, trips) share
      // these, so it's only a mild signal and never enough to act on alone.
      score += 0.25;
      reasons.push('generic_link');
    }

    const isNewJoiner =
      input.senderAgeMinutes !== null && input.senderAgeMinutes <= settings.newJoinerWindowMinutes;
    if (isNewJoiner) {
      reasons.push(`new_joiner:${input.senderAgeMinutes}m`);
      // A brand-new joiner posting a link or investment keyword is the classic
      // spam-bot pattern; nudge the score up. Real customers' first message is
      // usually a greeting/question with no link.
      if (hasInviteLink || hasGenericLink || matchedKeywords.length > 0) {
        score += 0.2;
        reasons.push('new_joiner_boost');
      }
    }

    return { score: Math.min(1, score), reasons };
  }

  async function llmVerdict(body: string): Promise<{ isSpam: boolean; confidence: number } | null> {
    if (!geminiApiKey) return null;
    const systemPrompt = `You are a spam filter for a Barcelona tour company's WhatsApp customer groups. Messages are usually Hebrew, sometimes Spanish/English. Real customers ask about tours, meeting points, times, and bookings. SPAM is unsolicited promotion — cryptocurrency, trading, investment, "earn money", adult content, or links inviting people to external channels/chats. Output STRICT JSON: {"is_spam": boolean, "confidence": number}. confidence is 0..1.`;
    const body_ = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: body }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            is_spam: { type: 'boolean' },
            confidence: { type: 'number' },
          },
          required: ['is_spam', 'confidence'],
        },
      },
    };
    try {
      const res = await fetchWithGeminiRetry(
        `${endpoint}?key=${encodeURIComponent(geminiApiKey)}`,
        body_,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const jsonStr = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const parsed = JSON.parse(jsonStr) as { is_spam: boolean; confidence: number };
      return { isSpam: Boolean(parsed.is_spam), confidence: parsed.confidence };
    } catch (err) {
      console.error('[moderation:llm] failed', err);
      return null;
    }
  }

  return {
    async detect(input): Promise<DetectResult> {
      const { score, reasons } = heuristicScore(input);

      if (score >= settings.spamThreshold) {
        return { verdict: 'spam', score, reasons, usedLlm: false };
      }
      if (score < settings.reviewMin) {
        return { verdict: 'ham', score, reasons, usedLlm: false };
      }

      // Ambiguous band — ask the LLM to break the tie.
      const llm = await llmVerdict(input.body);
      if (!llm) {
        // No LLM available or it failed: fail-open to avoid kicking a customer
        // on a guess. Surface as 'review' so it's still logged/alerted.
        return { verdict: 'review', score, reasons: [...reasons, 'llm_unavailable'], usedLlm: false };
      }
      const verdict: Verdict = llm.isSpam && llm.confidence >= 0.7 ? 'spam' : 'ham';
      return {
        verdict,
        score: Math.max(score, llm.isSpam ? llm.confidence : score),
        reasons: [...reasons, `llm:${llm.isSpam ? 'spam' : 'ham'}@${llm.confidence}`],
        usedLlm: true,
      };
    },
  };
}
