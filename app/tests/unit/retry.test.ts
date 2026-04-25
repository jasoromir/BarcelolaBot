import { describe, it, expect, vi } from 'vitest';
import { retry } from '../../src/messaging/retry';

describe('retry', () => {
  it('returns on first success', async () => {
    const fn = vi.fn(async () => 42);
    const r = await retry(fn, { attempts: 3, backoffMs: [0, 0] });
    expect(r).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on second attempt', async () => {
    let i = 0;
    const fn = vi.fn(async () => {
      i++;
      if (i < 2) throw new Error('boom');
      return 'ok';
    });
    const r = await retry(fn, { attempts: 3, backoffMs: [0, 0] });
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting attempts', async () => {
    const fn = vi.fn(async () => {
      throw new Error('always');
    });
    await expect(retry(fn, { attempts: 2, backoffMs: [0] })).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
