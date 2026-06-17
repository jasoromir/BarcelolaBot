import type { AppLogger } from '../log/logger.js';

export interface EmailMessage {
  subject: string;
  text: string;
}

export interface Emailer {
  /** Returns true if an email was actually dispatched. */
  send(msg: EmailMessage): Promise<boolean>;
  /** Whether the emailer is configured well enough to send. */
  readonly enabled: boolean;
}

export interface EmailerOpts {
  /** Resend API key (RESEND_API_KEY). When absent, the emailer is a no-op. */
  apiKey: string | undefined;
  /** Recipient address for all alerts. */
  to: string;
  /** From address. Resend requires a verified domain; their shared sandbox
   *  sender `onboarding@resend.dev` works without domain setup for testing. */
  from?: string;
  logger: AppLogger;
}

/**
 * Minimal Resend-backed email sender. Uses Node 20's native fetch — no new
 * dependency. If no API key is configured it logs a warning and reports
 * `enabled=false` so callers can degrade gracefully (the bot still runs; it
 * just can't email you). All alert plumbing checks `enabled` before composing.
 */
export function createEmailer(opts: EmailerOpts): Emailer {
  const { apiKey, to, logger } = opts;
  const from = opts.from ?? 'BarcelolaBot <onboarding@resend.dev>';
  const enabled = Boolean(apiKey && to);

  return {
    enabled,
    async send(msg: EmailMessage): Promise<boolean> {
      if (!enabled) {
        logger.warn({
          source: 'notify',
          eventType: 'email_skipped_unconfigured',
          message: `email not sent (RESEND_API_KEY or recipient missing): ${msg.subject}`,
        });
        return false;
      }
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ from, to, subject: msg.subject, text: msg.text }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          logger.error({
            source: 'notify',
            eventType: 'email_send_failed',
            message: `Resend returned ${res.status}: ${body.slice(0, 300)}`,
            metadata: { status: res.status },
          });
          return false;
        }
        logger.info({
          source: 'notify',
          eventType: 'email_sent',
          message: `alert email sent: ${msg.subject}`,
        });
        return true;
      } catch (err) {
        logger.error({
          source: 'notify',
          eventType: 'email_send_error',
          message: (err as Error).message,
        });
        return false;
      }
    },
  };
}
