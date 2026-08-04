import type { AppLogger } from '../log/logger.js';
import type { JobOutcome } from '../types.js';
import type { Emailer } from './emailer.js';

/**
 * Emails the operator when a scheduled broadcast job doesn't actually deliver.
 *
 * Why this exists: on 2026-08-03 the nightly job fired on time, ran for 27
 * minutes, and every WhatsApp send timed out against a wedged Chromium
 * renderer. It recorded status='partial' with groupsSent=0 and nobody was
 * told — the miss was only noticed the next morning. The session monitor
 * couldn't help: `whatsapp.state()` reads an internal flag that still said
 * "connected", because the socket was alive and only the browser was stuck.
 *
 * So we alert on the *outcome* rather than on connection state. A job that was
 * supposed to broadcast and sent to zero groups is an outage, whatever the
 * status field says.
 */

export interface JobAlerterOpts {
  emailer: Emailer;
  logger: AppLogger;
  /** Public URL so the email can link straight to /admin. */
  adminUrl?: string;
}

export interface JobAlerter {
  /** Inspect a finished job and email if it looks like a delivery failure. */
  report(outcome: JobOutcome): Promise<void>;
}

/** Jobs whose whole purpose is to broadcast — a zero-send run is a failure. */
const BROADCAST_JOBS = new Set(['nightly', 'morning']);

/**
 * True when this outcome means "the message did not go out".
 *
 * `skipped` is deliberately NOT an alert: it's the intended result when the bot
 * is paused or there are no tours to announce. Likewise a dry run never alerts.
 */
export function isDeliveryFailure(outcome: JobOutcome): boolean {
  if (outcome.dryRun) return false;
  if (outcome.status === 'failed') return true;
  if (outcome.status === 'skipped') return false;
  // A broadcast job that reached zero groups didn't do its job, even if it
  // reported 'success' or 'partial'.
  if (BROADCAST_JOBS.has(outcome.jobName) && outcome.groupsSent === 0) return true;
  return false;
}

export function createJobAlerter(opts: JobAlerterOpts): JobAlerter {
  const { emailer, logger } = opts;
  const adminLine = opts.adminUrl ? `\nAdmin: ${opts.adminUrl}/admin\n` : '\n';

  return {
    async report(outcome: JobOutcome): Promise<void> {
      if (!isDeliveryFailure(outcome)) return;

      const detail = [
        `Job: ${outcome.jobName}`,
        `Status: ${outcome.status}`,
        `Groups messaged: ${outcome.groupsSent}`,
        `Groups closed/opened: ${outcome.groupsClosed}`,
        `Tours found: ${outcome.toursCount}`,
        outcome.error ? `Error: ${outcome.error}` : null,
        outcome.metadata ? `Details: ${JSON.stringify(outcome.metadata)}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      const sent = await emailer.send({
        subject: `🚨 BarcelolaBot: ${outcome.jobName} broadcast did NOT go out`,
        text:
          `The ${outcome.jobName} job ran but delivered to ${outcome.groupsSent} groups.\n\n` +
          `${detail}\n\n` +
          `The most common cause is a wedged Chromium renderer: WhatsApp still reports ` +
          `"connected" but every send times out with "Runtime.callFunctionOn timed out". ` +
          `A container restart clears it and the session survives (no QR re-scan).\n\n` +
          `Restart: railway redeploy --yes\n` +
          adminLine,
      });

      logger[sent ? 'error' : 'warn']({
        source: 'notify',
        eventType: sent ? 'job_failure_alerted' : 'job_failure_alert_unsent',
        message: `${outcome.jobName} delivered to ${outcome.groupsSent} groups (status=${outcome.status})`,
        metadata: { jobName: outcome.jobName, status: outcome.status, groupsSent: outcome.groupsSent },
      });
    },
  };
}
