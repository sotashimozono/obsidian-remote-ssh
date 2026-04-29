import type { BackoffConfig } from './Backoff';
import { DEFAULT_BACKOFF, nextDelay } from './Backoff';
import { logger } from '../util/logger';

/**
 * Externally-visible status of the reconnect loop. The host (main.ts)
 * listens via `onState` and updates the StatusBar accordingly.
 */
export type ReconnectState =
  | { kind: 'idle' }
  | { kind: 'waiting'; attempt: number; totalAttempts: number; delayMs: number }
  | { kind: 'attempting'; attempt: number; totalAttempts: number }
  | { kind: 'recovered' }
  | { kind: 'failed'; reason: string }
  | { kind: 'cancelled' };

export interface ReconnectManagerOptions {
  /**
   * Single attempt at re-establishing the session. Should reconcile
   * SSH + RPC + adapter rebind + fs.watch in one go. Throws to signal
   * a retryable failure; resolves to signal success.
   */
  attempt: () => Promise<void>;
  /** State-change callback. Always called from the manager's loop. */
  onState: (s: ReconnectState) => void;
  /** Override the default schedule; useful for tests / settings UI. */
  backoff?: BackoffConfig;
  /**
   * Injectable timer + random for tests. Defaults to global setTimeout
   * + Math.random.
   */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  rng?: () => number;
}

/**
 * Drives the retry loop after an unexpected disconnect.
 *
 * Lifecycle: at most one `run()` is in flight at a time; calling
 * `cancel()` cleanly aborts the loop on the next sleep boundary
 * (or immediately if currently sleeping).
 */
export class ReconnectManager {
  private cancelled = false;
  private current: ReconnectState = { kind: 'idle' };
  private activeTimer: unknown = null;
  private cfg: BackoffConfig;
  private setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private clearTimeoutFn: (h: unknown) => void;
  private rng: () => number;

  constructor(private opts: ReconnectManagerOptions) {
    this.cfg = opts.backoff ?? DEFAULT_BACKOFF;
    // Default to `activeWindow.setTimeout` / `activeWindow.clearTimeout`
    // (Obsidian's popout-window-aware timer API enforced by
    // `obsidianmd/prefer-active-window-timers`). Tests / non-DOM hosts
    // inject `setTimeoutFn` / `clearTimeoutFn` directly so they don't
    // touch the global at all.
    this.setTimeoutFn = opts.setTimeoutFn
      ?? ((cb, ms) => activeWindow.setTimeout(cb, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn
      ?? ((h) => { activeWindow.clearTimeout(h as number); });
    this.rng = opts.rng ?? Math.random;
  }

  /**
   * Run the retry loop. Resolves once the loop terminates (recovered
   * or exhausted or cancelled). It's safe to await this; callers that
   * want fire-and-forget can ignore the returned promise.
   */
  async run(): Promise<ReconnectState> {
    if (this.isActive()) {
      // Multiple unexpected closes shouldn't kick the loop again — the
      // first one is still trying.
      return this.current;
    }
    this.cancelled = false;
    let lastDelay: number | null = null;
    for (let attempt = 1; attempt <= this.cfg.maxRetries; attempt++) {
      if (this.cancelled) {
        this.transition({ kind: 'cancelled' });
        return this.current;
      }
      const delay = nextDelay(lastDelay, this.cfg, this.rng);
      lastDelay = delay;
      this.transition({
        kind: 'waiting',
        attempt,
        totalAttempts: this.cfg.maxRetries,
        delayMs: delay,
      });
      try {
        await this.sleep(delay);
      } catch {
        this.transition({ kind: 'cancelled' });
        return this.current;
      }
      if (this.cancelled) {
        this.transition({ kind: 'cancelled' });
        return this.current;
      }
      this.transition({
        kind: 'attempting',
        attempt,
        totalAttempts: this.cfg.maxRetries,
      });
      try {
        await this.opts.attempt();
        this.transition({ kind: 'recovered' });
        return this.current;
      } catch (e) {
        logger.warn(`reconnect attempt ${attempt}/${this.cfg.maxRetries} failed: ${(e as Error).message}`);
      }
    }
    this.transition({
      kind: 'failed',
      reason: `gave up after ${this.cfg.maxRetries} attempts`,
    });
    return this.current;
  }

  /**
   * Request the loop stop. If currently sleeping, the sleep is
   * interrupted; if currently mid-attempt, the attempt is allowed to
   * finish (we don't have a way to abort it cleanly) but the result
   * is discarded.
   */
  cancel(): void {
    this.cancelled = true;
    if (this.activeTimer) {
      this.clearTimeoutFn(this.activeTimer);
      this.activeTimer = null;
    }
  }

  /** True when a retry loop is in progress. */
  isActive(): boolean {
    return this.current.kind === 'waiting' || this.current.kind === 'attempting';
  }

  state(): ReconnectState {
    return this.current;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private transition(s: ReconnectState): void {
    this.current = s;
    try {
      this.opts.onState(s);
    } catch (e) {
      logger.warn(`ReconnectManager.onState threw: ${(e as Error).message}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Zero-ms sleeps still need the boundary so cancel() has a
      // chance to abort before the next attempt fires.
      this.activeTimer = this.setTimeoutFn(() => {
        this.activeTimer = null;
        if (this.cancelled) reject(new Error('cancelled'));
        else resolve();
      }, ms);
    });
  }
}
