import type { AppLogger } from '../log/logger.js';
import type { ControlState } from '../persistence/controlState.js';
import type { WhatsAppClient } from '../whatsapp/types.js';
import type { Emailer } from './emailer.js';

// control_state keys owned by this monitor.
const KEY_CONNECTED_SINCE = 'wa_connected_since_ms'; // start of the current connection streak
const KEY_DOWN_SINCE = 'wa_down_since_ms'; // start of the current outage
const KEY_DISCONNECTED_ALERTED = 'wa_disconnect_alert_sent'; // '1' once a reactive alert fired for the current outage
const KEY_PROACTIVE_ALERTED = 'wa_proactive_alert_sent'; // '1' once a proactive warning fired for the current streak

export interface SessionMonitorSettings {
  /** Recipient is configured on the emailer; these tune timing/copy. */
  reactiveAfterMinutes: number;
  proactiveWarnAfterDays: number;
  /** Public URL so the email can link the operator straight to /admin. */
  adminUrl?: string;
}

export interface SessionMonitorOpts {
  whatsapp: WhatsAppClient;
  emailer: Emailer;
  store: ControlState;
  logger: AppLogger;
  settings: SessionMonitorSettings;
}

export interface SessionMonitor {
  /** Run one evaluation tick. Safe to call from a cron on any interval. */
  tick(): Promise<void>;
}

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MIN;

/**
 * Watches the WhatsApp link and emails the operator out-of-band (email, NOT
 * WhatsApp — the whole point is that WhatsApp is what's down):
 *
 *  - REACTIVE: when the link has been down for >= reactiveAfterMinutes, send
 *    one "session dropped, re-link needed" email. Sent once per outage; resets
 *    when the link comes back.
 *  - PROACTIVE: when the link has been continuously up for >= proactiveWarnAfterDays,
 *    send one "re-link soon, expiry window approaching" email. WhatsApp unlinks
 *    devices whose primary phone has been offline ~14 days, and datacenter-hosted
 *    sessions get cut even sooner — so a heads-up before the streak ages out lets
 *    you re-link on your schedule instead of discovering it dead.
 *
 * State is persisted in control_state so dedup survives process restarts (the
 * Railway container can restart without re-spamming you).
 */
export function createSessionMonitor(opts: SessionMonitorOpts): SessionMonitor {
  const { whatsapp, emailer, store, logger, settings } = opts;
  const adminLine = settings.adminUrl ? `\nAdmin: ${settings.adminUrl}/admin\n` : '\n';

  const nowMs = () => Date.now();

  async function tick(): Promise<void> {
    const state = whatsapp.state();

    if (state.kind === 'connected') {
      // Clear any outage dedup + down-since marker so the next drop alerts afresh.
      if (store.get(KEY_DISCONNECTED_ALERTED)) store.set(KEY_DISCONNECTED_ALERTED, '');
      if (store.get(KEY_DOWN_SINCE)) store.set(KEY_DOWN_SINCE, '');

      // Establish/continue the connection streak.
      let connectedSince = Number(store.get(KEY_CONNECTED_SINCE) ?? '');
      if (!Number.isFinite(connectedSince) || connectedSince <= 0) {
        connectedSince = nowMs();
        store.set(KEY_CONNECTED_SINCE, String(connectedSince));
        store.set(KEY_PROACTIVE_ALERTED, '');
      }

      const ageDays = (nowMs() - connectedSince) / MS_PER_DAY;
      if (ageDays >= settings.proactiveWarnAfterDays && store.get(KEY_PROACTIVE_ALERTED) !== '1') {
        const sent = await emailer.send({
          subject: '🔔 BarcelolaBot: re-link WhatsApp soon',
          text:
            `The WhatsApp link has been active for ${ageDays.toFixed(1)} days.\n\n` +
            `WhatsApp unlinks devices once the primary phone has been offline for ~14 days, ` +
            `and datacenter-hosted sessions are often cut sooner. To avoid an unexpected outage, ` +
            `re-link from a residential connection at your convenience:\n\n` +
            `WhatsApp on your phone → Settings → Linked Devices → Link a device, ` +
            `then scan the QR shown in the bot's logs/admin.\n` +
            adminLine,
        });
        if (sent) {
          store.set(KEY_PROACTIVE_ALERTED, '1');
          logger.info({
            source: 'notify',
            eventType: 'proactive_relink_alerted',
            message: `proactive re-link warning emailed (streak=${ageDays.toFixed(1)}d)`,
            metadata: { ageDays },
          });
        }
      }
      return;
    }

    // Not connected (qr_pending or disconnected). End the streak.
    if (store.get(KEY_CONNECTED_SINCE)) store.set(KEY_CONNECTED_SINCE, '');

    // Track when the outage began.
    let downSince = Number(store.get(KEY_DOWN_SINCE) ?? '');
    if (!Number.isFinite(downSince) || downSince <= 0) {
      downSince = nowMs();
      store.set(KEY_DOWN_SINCE, String(downSince));
    }
    const downMinutes = (nowMs() - downSince) / MS_PER_MIN;

    if (downMinutes >= settings.reactiveAfterMinutes && store.get(KEY_DISCONNECTED_ALERTED) !== '1') {
      const sent = await emailer.send({
        subject: '⚠️ BarcelolaBot: WhatsApp disconnected — re-link needed',
        text:
          `The bot's WhatsApp link has been down for ${Math.round(downMinutes)} minutes ` +
          `(state: ${state.kind}).\n\n` +
          `No broadcasts or booking confirmations are being sent until it's re-linked.\n\n` +
          `To fix: WhatsApp on your phone → Settings → Linked Devices → Link a device, ` +
          `then scan the QR shown in the bot's logs/admin.\n` +
          adminLine,
      });
      if (sent) {
        store.set(KEY_DISCONNECTED_ALERTED, '1');
        logger.error({
          source: 'notify',
          eventType: 'disconnect_alerted',
          message: `WhatsApp disconnect emailed (down=${Math.round(downMinutes)}m)`,
          metadata: { downMinutes, state: state.kind },
        });
      }
    }
  }

  return { tick };
}
