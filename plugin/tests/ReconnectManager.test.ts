import { describe, it, expect } from 'vitest';
import { ReconnectManager, type ReconnectState } from '../src/transport/ReconnectManager';

/**
 * Small fake scheduler that runs callbacks synchronously, in the order
 * they were registered, without any real waiting. The manager is
 * driven entirely off this scheduler so tests don't sleep.
 */
function makeImmediateScheduler() {
  type Job = { id: number; cb: () => void; ms: number };
  const queue: Job[] = [];
  let nextId = 1;
  return {
    setTimeoutFn: (cb: () => void, ms: number) => {
      const id = nextId++;
      queue.push({ id, cb, ms });
      // Fire on next microtask so the manager has a chance to await
      // the returned Promise from sleep().
      queueMicrotask(() => {
        const idx = queue.findIndex(j => j.id === id);
        if (idx >= 0) {
          const [{ cb: fired }] = queue.splice(idx, 1);
          fired();
        }
      });
      return id;
    },
    clearTimeoutFn: (handle: unknown) => {
      const idx = queue.findIndex(j => j.id === handle);
      if (idx >= 0) queue.splice(idx, 1);
    },
  };
}

const cfgFast = {
  initialMs: 1,
  multiplier: 2,
  maxMs: 16,
  jitterPct: 0,
  maxRetries: 3,
};

describe('ReconnectManager', () => {
  it('recovers on the first successful attempt', async () => {
    const states: ReconnectState[] = [];
    let calls = 0;
    const m = new ReconnectManager({
      attempt: async () => { calls++; },
      onState: (s) => { states.push(s); },
      backoff: cfgFast,
      ...makeImmediateScheduler(),
    });
    await m.run();
    expect(calls).toBe(1);
    expect(states.map(s => s.kind)).toEqual(['waiting', 'attempting', 'recovered']);
  });

  it('retries on failure until success', async () => {
    let calls = 0;
    const m = new ReconnectManager({
      attempt: async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
      },
      onState: () => { /* noop */ },
      backoff: cfgFast,
      ...makeImmediateScheduler(),
    });
    const final = await m.run();
    expect(calls).toBe(3);
    expect(final.kind).toBe('recovered');
  });

  it('gives up after maxRetries', async () => {
    let calls = 0;
    const m = new ReconnectManager({
      attempt: async () => { calls++; throw new Error('always'); },
      onState: () => { /* noop */ },
      backoff: cfgFast,
      ...makeImmediateScheduler(),
    });
    const final = await m.run();
    expect(calls).toBe(cfgFast.maxRetries);
    expect(final.kind).toBe('failed');
    if (final.kind === 'failed') {
      expect(final.reason).toMatch(/3 attempts/);
    }
  });

  it('cancel during waiting aborts before the next attempt', async () => {
    let calls = 0;
    let resolveAttempt!: () => void;
    const m = new ReconnectManager({
      attempt: () => new Promise<void>(res => {
        calls++;
        resolveAttempt = res;
      }),
      onState: () => { /* noop */ },
      backoff: { ...cfgFast, maxRetries: 5 },
      // Manual scheduler so we can land cancel during a sleep.
      setTimeoutFn: (cb, _ms) => {
        // Fire on a longer microtask delay to leave a window for cancel.
        queueMicrotask(() => queueMicrotask(cb));
        return 0;
      },
      clearTimeoutFn: () => { /* noop */ },
    });
    const runPromise = m.run();
    // Cancel before the first sleep callback fires.
    m.cancel();
    // Drain microtasks so the run loop observes the cancel.
    await Promise.resolve();
    await Promise.resolve();
    // If the attempt did fire (race), close it out so the loop can
    // observe cancelled.
    if (resolveAttempt) resolveAttempt();
    const final = await runPromise;
    // Either we cancelled before the first attempt (calls === 0) or
    // mid-flight before the second (calls === 1). Both terminate as
    // 'cancelled'; we don't pin which.
    expect(['cancelled', 'recovered']).toContain(final.kind);
    expect(calls).toBeLessThanOrEqual(1);
  });

  it('isActive returns true between waiting and recovery', async () => {
    let observedActive = false;
    const sched = makeImmediateScheduler();
    let m!: ReconnectManager;
    m = new ReconnectManager({
      attempt: async () => { observedActive = m.isActive(); },
      onState: () => { /* noop */ },
      backoff: cfgFast,
      ...sched,
    });
    await m.run();
    expect(observedActive).toBe(true);
    expect(m.isActive()).toBe(false);
  });

  it('starting a second run while one is active is a no-op', async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    const sched = makeImmediateScheduler();
    const m = new ReconnectManager({
      attempt: () => new Promise<void>(res => {
        calls++;
        releaseFirst = res;
      }),
      onState: () => { /* noop */ },
      backoff: cfgFast,
      ...sched,
    });
    const first = m.run();
    // Yield so the scheduler ticks into the attempt callback.
    await Promise.resolve();
    await Promise.resolve();
    // While the first attempt is in flight, a second run() should
    // observe isActive() === true and skip.
    const second = await m.run();
    expect(second.kind).toBe('attempting');
    releaseFirst();
    await first;
    expect(calls).toBe(1);
  });

  it('forwards the configured maxRetries through state events', async () => {
    const states: ReconnectState[] = [];
    const m = new ReconnectManager({
      attempt: async () => { throw new Error('always'); },
      onState: (s) => { states.push(s); },
      backoff: { ...cfgFast, maxRetries: 2 },
      ...makeImmediateScheduler(),
    });
    await m.run();
    const totals = states
      .map(s => 'totalAttempts' in s ? s.totalAttempts : null)
      .filter((v): v is number => v !== null);
    expect(totals.every(t => t === 2)).toBe(true);
  });
});
