import { RETRY_BASE_MS, RETRY_MAX_MS, MAX_RETRY } from '../constants';
import { logger } from './logger';

// Plain setTimeout — this generic retry helper has no DOM context.
// eslint-disable-next-line obsidianmd/prefer-active-window-timers
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = MAX_RETRY,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const jitter = Math.random() * 500;
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1) + jitter, RETRY_MAX_MS);
      logger.warn(`${label}: attempt ${attempt} failed (${(err as Error).message}), retry in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
  throw new Error('unreachable');
}
