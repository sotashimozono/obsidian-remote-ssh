import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from '../src/util/retry';

// activeWindow is polyfilled to globalThis in vitest.setup.ts, so
// vi.useFakeTimers() intercepts activeWindow.setTimeout automatically.

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result when fn succeeds on the first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const p = withRetry(fn, 'op', 3);
    await vi.runAllTimersAsync();
    expect(await p).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries after a transient failure and resolves on the second attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');
    const p = withRetry(fn, 'op', 3);
    await vi.runAllTimersAsync();
    expect(await p).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after exhausting all attempts', async () => {
    const err = new Error('persistent');
    const fn = vi.fn().mockRejectedValue(err);
    const p = withRetry(fn, 'op', 3);
    // Attach rejection handler BEFORE running timers so the rejection is
    // never "unhandled" from Vitest's perspective.
    const assertion = expect(p).rejects.toThrow('persistent');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('calls fn exactly once when maxAttempts is 1 and fn fails', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    const p = withRetry(fn, 'op', 1);
    const assertion = expect(p).rejects.toThrow('boom');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses MAX_RETRY as default when maxAttempts is omitted', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const p = withRetry(fn, 'op');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxAttempts-1 times before the last attempt succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValueOnce('done');
    const p = withRetry(fn, 'op', 4);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
