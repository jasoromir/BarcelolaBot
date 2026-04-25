export interface RetryOpts {
  attempts: number;
  backoffMs: number[]; // indexed by (attempt-1); backoffMs[i] slept after attempt i fails
  onAttemptFailure?: (err: unknown, attempt: number) => void;
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      opts.onAttemptFailure?.(err, i);
      if (i < opts.attempts) {
        const waitMs = opts.backoffMs[i - 1] ?? 0;
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw lastErr;
}
