import { describe, it, expect } from 'vitest';
import { nextDelay, DEFAULT_BACKOFF, type BackoffConfig } from '../src/transport/Backoff';

const noJitterCfg: BackoffConfig = {
  initialMs: 1000,
  multiplier: 2,
  maxMs: 8000,
  jitterPct: 0,
  maxRetries: 5,
};

// Pinned RNG that always returns the midpoint, so jitter contributes 0.
const midRng = () => 0.5;

describe('Backoff.nextDelay', () => {
  it('returns initialMs for the first attempt (prevMs === null)', () => {
    expect(nextDelay(null, noJitterCfg, midRng)).toBe(1000);
  });

  it('multiplies the previous delay until maxMs', () => {
    expect(nextDelay(1000, noJitterCfg, midRng)).toBe(2000);
    expect(nextDelay(2000, noJitterCfg, midRng)).toBe(4000);
    expect(nextDelay(4000, noJitterCfg, midRng)).toBe(8000);
    expect(nextDelay(8000, noJitterCfg, midRng)).toBe(8000);
    expect(nextDelay(16000, noJitterCfg, midRng)).toBe(8000);
  });

  it('applies positive jitter when rng > 0.5', () => {
    const cfg: BackoffConfig = { ...noJitterCfg, jitterPct: 0.5 };
    // rng()=1 → jitter sample = 1 (max positive). delay = 1000 + 1000*0.5*1 = 1500.
    expect(nextDelay(null, cfg, () => 1)).toBe(1500);
  });

  it('applies negative jitter when rng < 0.5', () => {
    const cfg: BackoffConfig = { ...noJitterCfg, jitterPct: 0.5 };
    // rng()=0 → jitter sample = -1. delay = 1000 + 1000*0.5*(-1) = 500.
    expect(nextDelay(null, cfg, () => 0)).toBe(500);
  });

  it('never returns a negative delay even with maximal negative jitter', () => {
    const cfg: BackoffConfig = { ...noJitterCfg, jitterPct: 2 };
    // jitter would push to -1000; clamp to 0.
    expect(nextDelay(null, cfg, () => 0)).toBe(0);
  });

  it('DEFAULT_BACKOFF is sensible', () => {
    expect(DEFAULT_BACKOFF.initialMs).toBeGreaterThan(0);
    expect(DEFAULT_BACKOFF.multiplier).toBeGreaterThan(1);
    expect(DEFAULT_BACKOFF.maxMs).toBeGreaterThanOrEqual(DEFAULT_BACKOFF.initialMs);
    expect(DEFAULT_BACKOFF.jitterPct).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_BACKOFF.jitterPct).toBeLessThanOrEqual(1);
    expect(DEFAULT_BACKOFF.maxRetries).toBeGreaterThan(0);
  });
});
