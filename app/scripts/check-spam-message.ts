// One-off diagnostic: run an arbitrary message body through the real spam
// detector using production config (real keywords/thresholds) and the real
// Gemini LLM tie-breaker, so we can see how a specific message WOULD have
// been scored without needing the bot connected/live in a group.
//
// Usage:
//   cd app && npx tsx scripts/check-spam-message.ts "<message body>" [senderAgeMinutes]
//
// Requires: GEMINI_API_KEY in app/.env (LLM tie-break only runs if the
// heuristic score lands in the review band; otherwise it's not needed).

import 'dotenv/config';
import path from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { createDetector } from '../src/moderation/detector.js';

async function main(): Promise<void> {
  const body = process.argv[2];
  if (!body) {
    console.error('Usage: npx tsx scripts/check-spam-message.ts "<message body>" [senderAgeMinutes]');
    process.exit(1);
  }
  const senderAgeMinutes = process.argv[3] ? Number(process.argv[3]) : null;

  const configDir = path.resolve(process.cwd(), 'config');
  const config = loadConfig(configDir);
  const mod = config.settings.moderation;
  if (!mod) {
    console.error('moderation not configured in settings.yaml');
    process.exit(1);
  }

  const geminiApiKey = process.env.GEMINI_API_KEY ?? '';
  const detector = createDetector(
    {
      keywords: mod.keywords,
      newJoinerWindowMinutes: mod.new_joiner_window_minutes,
      spamThreshold: mod.score_spam_threshold,
      reviewMin: mod.score_review_min,
    },
    geminiApiKey,
  );

  console.log('--- message ---');
  console.log(body);
  console.log('--- settings ---');
  console.log({
    spamThreshold: mod.score_spam_threshold,
    reviewMin: mod.score_review_min,
    newJoinerWindowMinutes: mod.new_joiner_window_minutes,
    geminiConfigured: Boolean(geminiApiKey),
    senderAgeMinutes,
  });

  const result = await detector.detect({ body, senderAgeMinutes });
  console.log('--- result ---');
  console.log(JSON.stringify(result, null, 2));

  const enforceGroups: string[] = mod.enforce_in_groups ?? [];
  console.log('--- what would happen in an enforce_in_groups group ---');
  if (result.verdict === 'spam') {
    console.log(`verdict=spam, score=${result.score} >= threshold=${mod.score_spam_threshold} -> message DELETED + sender KICKED (if bot is group admin)`);
  } else if (result.verdict === 'review') {
    console.log(`verdict=review (LLM unavailable/inconclusive) -> logged only, NO automatic action`);
  } else {
    console.log(`verdict=ham -> no action`);
  }
  console.log(`(enforcement only actually happens in these groups: ${enforceGroups.join(', ') || '(none configured)'})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

