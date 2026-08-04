import { describe, it, expect, vi } from 'vitest';
import { createJobAlerter, isDeliveryFailure } from '../../src/notify/jobAlerts.js';

function outcome(over: any = {}): any {
  return {
    jobName: 'nightly',
    status: 'success',
    toursCount: 3,
    groupsSent: 2,
    groupsClosed: 2,
    dryRun: false,
    ...over,
  };
}

function makeAlerter(sendOk = true) {
  const emailer = { enabled: true, send: vi.fn(async () => sendOk) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    alerter: createJobAlerter({ emailer: emailer as any, logger: logger as any }),
    emailer,
    logger,
  };
}

describe('isDeliveryFailure', () => {
  it('flags a broadcast job that reached zero groups even when it says success', () => {
    // The 2026-08-03 nightly: ran, reported partial, sent to nobody.
    expect(isDeliveryFailure(outcome({ status: 'partial', groupsSent: 0 }))).toBe(true);
    expect(isDeliveryFailure(outcome({ status: 'success', groupsSent: 0 }))).toBe(true);
  });

  it('flags any explicitly failed job', () => {
    expect(isDeliveryFailure(outcome({ status: 'failed', groupsSent: 0 }))).toBe(true);
  });

  it('does not flag a healthy run', () => {
    expect(isDeliveryFailure(outcome())).toBe(false);
    // Partial with real delivery = some group isn't admin-managed; not an outage.
    expect(isDeliveryFailure(outcome({ status: 'partial', groupsSent: 2 }))).toBe(false);
  });

  it('does not flag a skipped run (paused, or nothing to announce)', () => {
    expect(isDeliveryFailure(outcome({ status: 'skipped', groupsSent: 0 }))).toBe(false);
  });

  it('never flags a dry run', () => {
    expect(isDeliveryFailure(outcome({ status: 'failed', groupsSent: 0, dryRun: true }))).toBe(false);
  });

  it('does not flag a non-broadcast job for sending to zero groups', () => {
    // private_tour_sync legitimately messages nobody.
    expect(
      isDeliveryFailure(outcome({ jobName: 'private_tour_sync', groupsSent: 0 })),
    ).toBe(false);
  });
});

describe('createJobAlerter', () => {
  it('emails with the job name, status and group count', async () => {
    const { alerter, emailer } = makeAlerter();
    await alerter.report(outcome({ status: 'partial', groupsSent: 0 }));

    expect(emailer.send).toHaveBeenCalledTimes(1);
    const msg = emailer.send.mock.calls[0][0];
    expect(msg.subject).toContain('nightly');
    expect(msg.text).toContain('Groups messaged: 0');
    // The operator needs the likely cause and the one-line fix.
    expect(msg.text).toContain('Runtime.callFunctionOn timed out');
    expect(msg.text).toContain('railway redeploy');
  });

  it('stays silent on a healthy run', async () => {
    const { alerter, emailer } = makeAlerter();
    await alerter.report(outcome());
    expect(emailer.send).not.toHaveBeenCalled();
  });

  it('includes the underlying error when the job reported one', async () => {
    const { alerter, emailer } = makeAlerter();
    await alerter.report(outcome({ status: 'failed', groupsSent: 0, error: 'boom' }));
    expect(emailer.send.mock.calls[0][0].text).toContain('boom');
  });

  it('logs at warn (not error) when the alert email itself could not be sent', async () => {
    const { alerter, logger } = makeAlerter(false);
    await alerter.report(outcome({ status: 'partial', groupsSent: 0 }));
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
