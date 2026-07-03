import { describe, it, expect } from 'vitest';
import { createDetector, type DetectorSettings } from '../../src/moderation/detector.js';

const settings: DetectorSettings = {
  keywords: [
    'usdt',
    'binance',
    'crypto',
    'airdrop',
    'profit',
    'invest',
    'שוק המניות',
    'מניות',
    'משקיעים',
    'השקעות',
    'קבוצת ה-vip',
  ],
  newJoinerWindowMinutes: 60,
  spamThreshold: 0.8,
  reviewMin: 0.4,
};

// No API key → LLM disabled, so the ambiguous band resolves to 'review'
// (fail-open). This lets us test the heuristic deterministically.
const detector = createDetector(settings, '');

// The two real Hebrew spam messages the user provided.
const REAL_SPAM_1 =
  'זוהי קבוצת דיון להחלפת מידע בשוק המניות. משקיעים וחובבים מוזמנים להצטרף.\nhttps://chat.whatsapp.com/CxdePzvEWZKJ3N0ZlkdsNL';
const REAL_SPAM_2 =
  'שלום לכולם 👋\n\n✅ יצרנו קבוצת וואטסאפ ללמידה ודיון על השקעות. כל מי שמתעניין בשווקי ההון מוזמן להצטרף.\n\n✅ הפרופסור ישתף מידע על שוק המניות בקבוצה מדי יום בחינם.\n\n✅ השיבו למנהל הקבוצה כדי לקבל הזמנה להצטרף לקבוצת ה-VIP שלנו.\n\nhttps://chat.whatsapp.com/JGw7nwtdtdHESQsZgRFov9?s=cl&p=i&ilr=2&amv=1';

describe('spam detector heuristic', () => {
  it('flags real Hebrew stock-market spam (example 1) as spam', async () => {
    // Established sender (not a new joiner): invite link + investment keywords
    // must be enough on its own.
    const r = await detector.detect({ body: REAL_SPAM_1, senderAgeMinutes: 100000 });
    expect(r.verdict).toBe('spam');
    expect(r.score).toBeGreaterThanOrEqual(settings.spamThreshold);
    expect(r.reasons).toContain('invite_link');
  });

  it('flags real Hebrew investment spam (example 2) as spam', async () => {
    const r = await detector.detect({ body: REAL_SPAM_2, senderAgeMinutes: 100000 });
    expect(r.verdict).toBe('spam');
    expect(r.score).toBeGreaterThanOrEqual(settings.spamThreshold);
  });

  it('flags a new joiner posting a crypto link as spam', async () => {
    const r = await detector.detect({
      body: 'Join now https://t.me/cryptopump for guaranteed profit in USDT!',
      senderAgeMinutes: 2,
    });
    expect(r.verdict).toBe('spam');
    expect(r.score).toBeGreaterThanOrEqual(settings.spamThreshold);
    expect(r.usedLlm).toBe(false);
  });

  it('does NOT auto-spam a collaborator sharing a website/maps link', async () => {
    // Taxi/trip collaborators post plain website links with no investment
    // pitch and no group invite — must never be auto-kicked.
    const taxi = await detector.detect({
      body: 'Servicio de taxi al aeropuerto, reservas aquí https://taxibcn.com/reservar',
      senderAgeMinutes: 100000,
    });
    expect(taxi.verdict).not.toBe('spam');

    const trip = await detector.detect({
      body: 'Excursión a la Costa Brava este sábado 🌊 info: https://costabravatrips.com',
      senderAgeMinutes: 100000,
    });
    expect(trip.verdict).not.toBe('spam');
  });

  it('treats a normal customer question as ham', async () => {
    const r = await detector.detect({
      body: 'שלום, מה שעת המפגש למחר?',
      senderAgeMinutes: 5000,
    });
    expect(r.verdict).toBe('ham');
    expect(r.score).toBeLessThan(settings.reviewMin);
  });

  it('does not auto-spam an established member who shares one website link', async () => {
    // Long-standing member, single generic link, no keywords: link alone (0.25)
    // is below review — avoids nuking a customer sharing a map.
    const r = await detector.detect({
      body: 'Here is the meeting spot https://maps.app.goo.gl/abc',
      senderAgeMinutes: 100000,
    });
    expect(r.verdict).not.toBe('spam');
  });

  it('new joiner + keyword (no link) lands in review band, not auto-kick', async () => {
    const r = await detector.detect({
      body: 'best crypto signals here',
      senderAgeMinutes: 3,
    });
    // keywords(0.25) + new_joiner_boost(0.2) = 0.45 → review (LLM off)
    expect(r.score).toBeGreaterThanOrEqual(settings.reviewMin);
    expect(r.score).toBeLessThan(settings.spamThreshold);
    expect(r.verdict).toBe('review');
  });

  it('unknown sender age is treated as not-new (no new-joiner boost)', async () => {
    const r = await detector.detect({
      body: 'profit',
      senderAgeMinutes: null,
    });
    // single keyword only (0.25) → below reviewMin → ham
    expect(r.verdict).toBe('ham');
  });
});
