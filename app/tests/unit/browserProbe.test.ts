import { describe, it, expect, vi } from 'vitest';
import { createBrowserProbe } from '../../src/notify/browserProbe.js';

function makeProbe(over: any = {}) {
  const mem = new Map<string, string>();
  const store = {
    get: (k: string) => mem.get(k),
    set: (k: string, v: string) => void mem.set(k, v),
  };
  const emailer = { enabled: true, send: vi.fn(async () => true) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const probe = createBrowserProbe({
    probe: over.probe ?? (async () => 1),
    isConnected: over.isConnected ?? (() => true),
    emailer: emailer as any,
    store: store as any,
    logger: logger as any,
    settings: {
      timeoutMs: over.timeoutMs ?? 50,
      failuresBeforeAlert: over.failuresBeforeAlert ?? 2,
    },
  });
  return { probe, emailer, logger, store: mem };
}

/** A probe that never settles — models the wedged renderer. */
const hangs = () => new Promise<never>(() => {});

describe('browserProbe', () => {
  it('stays silent while the page answers', async () => {
    const { probe, emailer } = makeProbe();
    await probe.tick();
    await probe.tick();
    expect(emailer.send).not.toHaveBeenCalled();
  });

  it('does not alert on a single failure (avoids paging on one slow tick)', async () => {
    const { probe, emailer } = makeProbe({ probe: hangs });
    await probe.tick();
    expect(emailer.send).not.toHaveBeenCalled();
  });

  it('emails once the failure streak reaches the threshold', async () => {
    const { probe, emailer } = makeProbe({ probe: hangs });
    await probe.tick();
    await probe.tick();
    expect(emailer.send).toHaveBeenCalledTimes(1);
    const msg = emailer.send.mock.calls[0][0];
    expect(msg.text).toContain('Runtime.callFunctionOn timed out');
    expect(msg.text).toContain('railway redeploy');
  });

  it('does not re-email on every subsequent tick of the same outage', async () => {
    const { probe, emailer } = makeProbe({ probe: hangs });
    await probe.tick();
    await probe.tick();
    await probe.tick();
    await probe.tick();
    expect(emailer.send).toHaveBeenCalledTimes(1);
  });

  it('treats a probe that rejects as a failure, not a crash', async () => {
    const { probe, emailer } = makeProbe({
      probe: async () => {
        throw new Error('Target closed');
      },
    });
    await probe.tick();
    await probe.tick();
    expect(emailer.send).toHaveBeenCalledTimes(1);
  });

  it('resets after recovery so the next wedge alerts again', async () => {
    let wedged = true;
    const { probe, emailer, logger } = makeProbe({
      probe: () => (wedged ? hangs() : Promise.resolve(1)),
    });
    await probe.tick();
    await probe.tick();
    expect(emailer.send).toHaveBeenCalledTimes(1);

    // Container restarted; page answers again.
    wedged = false;
    await probe.tick();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'browser_probe_recovered' }),
    );

    // A fresh wedge must alert — the dedup flag has to have been cleared.
    wedged = true;
    await probe.tick();
    await probe.tick();
    expect(emailer.send).toHaveBeenCalledTimes(2);
  });

  it('skips probing while disconnected (sessionMonitor owns that alert)', async () => {
    const { probe, emailer } = makeProbe({ probe: hangs, isConnected: () => false });
    await probe.tick();
    await probe.tick();
    await probe.tick();
    expect(emailer.send).not.toHaveBeenCalled();
  });
});
