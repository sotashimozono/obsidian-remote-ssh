import { afterEach, describe, expect, it, vi } from 'vitest';
import { RETRY_MAX_MS } from '../src/constants';
import { withRetry } from '../src/util/retry';
import { logger } from '../src/util/logger';

describe('withRetry', () => {
  const originalSetTimeout = activeWindow.setTimeout.bind(activeWindow);
  const delays: number[] = [];

  afterEach(() => {
    delays.length = 0;
    activeWindow.setTimeout = originalSetTimeout;
    vi.restoreAllMocks();
  });

  function installImmediateSleep(): void {
    activeWindow.setTimeout = ((cb: TimerHandler, ms?: number) => {
      delays.push(Number(ms ?? 0));
      if (typeof cb === 'function') cb();
      return 0 as unknown as number;
    }) as typeof setTimeout;
  }

  it('returns immediately on first success without logging retries', async () => {
    installImmediateSleep();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const fn = vi.fn(async () => 'ok');

    await expect(withRetry(fn, 'rpc')).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(delays).toEqual([]);
  });

  it('retries after a failure and logs backoff details', async () => {
    installImmediateSleep();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce('done');

    await expect(withRetry(fn, 'fs.write', 3)).resolves.toBe('done');

    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1000]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('fs.write: attempt 1 failed (flaky), retry in 1000ms');
  });

  it('caps retry delay at RETRY_MAX_MS and rethrows the final error', async () => {
    installImmediateSleep();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const boom = new Error('still failing');
    const fn = vi.fn(async () => { throw boom; });

    await expect(withRetry(fn, 'deploy', 8)).rejects.toBe(boom);

    expect(fn).toHaveBeenCalledTimes(8);
    expect(warn).toHaveBeenCalledTimes(7);
    expect(delays.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(delays.slice(5)).toEqual([RETRY_MAX_MS, RETRY_MAX_MS]);
  });
});
