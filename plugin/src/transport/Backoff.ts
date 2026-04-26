/**
 * Exponential backoff with full jitter for the reconnect manager.
 *
 * The schedule starts at `initialMs`, multiplies by `multiplier` each
 * attempt up to `maxMs`, and adds a uniform `±jitterPct` shake on top.
 * Pure functions only — easy to unit-test with a deterministic RNG.
 */
export interface BackoffConfig {
  /** Delay before the first retry attempt, in ms. */
  initialMs: number;
  /** Multiplied into the previous delay to get the next nominal delay. */
  multiplier: number;
  /** Hard cap on the nominal delay; jitter can push beyond by jitterPct. */
  maxMs: number;
  /** Symmetric jitter as a fraction of the nominal delay. 0.2 = ±20%. */
  jitterPct: number;
  /** Hard cap on the number of attempts before giving up. */
  maxRetries: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  initialMs: 1000,
  multiplier: 1.5,
  maxMs: 30_000,
  jitterPct: 0.2,
  maxRetries: 5,
};

/**
 * Compute the delay before the n-th attempt (1-indexed). `prevMs` is
 * the delay used for the previous attempt, or `null` for the first
 * one. `rng` defaults to `Math.random` and is dependency-injected so
 * tests can pin the jitter.
 */
export function nextDelay(
  prevMs: number | null,
  cfg: BackoffConfig,
  rng: () => number = Math.random,
): number {
  const nominal = prevMs === null
    ? cfg.initialMs
    : Math.min(prevMs * cfg.multiplier, cfg.maxMs);
  const jitter = nominal * cfg.jitterPct * (rng() * 2 - 1);
  const v = nominal + jitter;
  return Math.max(0, Math.round(v));
}
