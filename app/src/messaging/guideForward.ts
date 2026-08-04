import type { WhatsAppClient } from '../whatsapp/types.js';

/**
 * DMs a guide two separate messages: an explanatory header, then the exact
 * client-facing message body on its own, unmixed, so it's copy-pasteable
 * as-is. Shared by every "redirect a client message to a guide instead of
 * sending it directly" path — deliveryNotifier's failure alert, and the
 * new_client_messages_enabled kill-switch redirect in bookingHandler.ts /
 * reminders/runner.ts (added 2026-07-24: WhatsApp's linked-device "new chat"
 * restriction — seen again after the 2026-07-20 ban — reported as lasting
 * "4 more days", so client-facing sends are paused and forwarded to ליאנה
 * to send manually from her own phone instead).
 */
export async function sendGuideForward(
  wa: WhatsAppClient,
  guidePhone: string,
  headerText: string,
  body: string,
): Promise<void> {
  await wa.sendDirect(guidePhone, headerText);
  await wa.sendDirect(guidePhone, body);
}
