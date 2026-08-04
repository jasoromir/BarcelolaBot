import type { AppLogger } from '../log/logger.js';
import type { ControlState } from '../persistence/controlState.js';
import type { Emailer } from './emailer.js';

/**
 * Checks that the Chromium page actually answers, not just that the socket is up.
 *
 * `whatsapp.state()` only reflects lifecycle events ('ready', 'disconnected'), so
 * it reports "connected" indefinitely while the renderer is wedged. That is
 * exactly what happened on 2026-08-03: health checks logged wa=connected every
 * 15 minutes for hours while every send failed with
 * "Runtime.callFunctionOn timed out", and the nightly broadcast was lost.
 *
 * This probe evaluates a trivial expression in the page. If that can't complete,
 * no send will either. Two consecutive failures (default) trigger one email —
 * requiring two avoids paging on a single slow tick during heavy sends.
 */

const KEY_FAIL_STREAK = 'browser_probe_fail_streak';
const KEY_ALERTED = 'browser_probe_alert_sent';

export interface BrowserProbeSettings {
  /** Fail the probe if the page doesn't answer within this many ms. */
  timeoutMs: number;
  /** Consecutive failures required before emailing. */
  failuresBeforeAlert: number;
  adminUrl?: string;
}

export interface BrowserProbeOpts {
  /** Evaluates a function in the WhatsApp page. Rejects/hangs when wedged. */
  probe: () => Promise<unknown>;
  /** Only probe when the client believes it's connected. */
  isConnected: () => boolean;
  emailer: Emailer;
  store: ControlState;
  logger: AppLogger;
  settings: BrowserProbeSettings;
}

export interface BrowserProbe {
  tick(): Promise<void>;
}

/** Resolves to false if `p` doesn't settle within timeoutMs. Never rejects. */
async function within(p: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([p.then(() => true).catch(() => false), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createBrowserProbe(opts: BrowserProbeOpts): BrowserProbe {
  const { probe, isConnected, emailer, store, logger, settings } = opts;
  const adminLine = settings.adminUrl ? `\nAdmin: ${settings.adminUrl}/admin\n` : '\n';

  const readStreak = (): number => {
    const n = Number(store.get(KEY_FAIL_STREAK) ?? '');
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  async function tick(): Promise<void> {
    // While disconnected the session monitor owns the alerting; a dead page is
    // expected and would just duplicate that email.
    if (!isConnected()) return;

    const ok = await within(probe(), settings.timeoutMs);

    if (ok) {
      if (readStreak() > 0) {
        logger.info({
          source: 'notify',
          eventType: 'browser_probe_recovered',
          message: 'chromium page responding again',
        });
      }
      store.set(KEY_FAIL_STREAK, '0');
      store.set(KEY_ALERTED, '');
      return;
    }

    const streak = readStreak() + 1;
    store.set(KEY_FAIL_STREAK, String(streak));
    logger.warn({
      source: 'notify',
      eventType: 'browser_probe_failed',
      message: `chromium page did not answer within ${settings.timeoutMs}ms (streak=${streak})`,
      metadata: { streak },
    });

    if (streak < settings.failuresBeforeAlert || store.get(KEY_ALERTED) === '1') return;

    const sent = await emailer.send({
      subject: '🚨 BarcelolaBot: WhatsApp browser wedged — sends are failing',
      text:
        `The Chromium page behind WhatsApp has stopped responding (${streak} consecutive ` +
        `probe failures, ${settings.timeoutMs}ms timeout each).\n\n` +
        `WhatsApp still reports "connected" because the socket is alive, but every send ` +
        `will time out with "Runtime.callFunctionOn timed out" — broadcasts, reminders ` +
        `and booking confirmations are all silently failing.\n\n` +
        `Fix: restart the container. The session is on the persistent volume, so no QR ` +
        `re-scan is needed.\n\n` +
        `  railway redeploy --yes\n` +
        adminLine,
    });

    if (sent) {
      store.set(KEY_ALERTED, '1');
      logger.error({
        source: 'notify',
        eventType: 'browser_wedged_alerted',
        message: `chromium wedge emailed (streak=${streak})`,
        metadata: { streak },
      });
    }
  }

  return { tick };
}
