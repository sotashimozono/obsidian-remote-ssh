import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './logger';
import { errorMessage } from './errorMessage';

/**
 * F22 — opt-in anonymous telemetry. Local-only counters keyed by
 * error category and reconnect-state-machine kind. Never transmitted
 * over the network — the value of this surface is "the user (and
 * BRAT bug-bash testers) can paste a histogram into a bug report
 * without leaking vault content".
 *
 * The class is a no-op when `enabled === false`. Callers can fire
 * record* unconditionally; the gate is internal so observability
 * hooks don't have to know about the setting.
 *
 * Persistence: counters are kept in memory and flushed to a JSONL
 * append-log every {@link FLUSH_INTERVAL_MS} (or on `flush()`).
 * Each record carries `at` (unix ms), the counter `kind`, the key
 * fields, and the count delta since the last flush. The whole file
 * never grows unbounded — counters reset on each flush, so the JSONL
 * is a stream of deltas rather than a snapshot.
 */

export type TelemetryKind = 'error' | 'reconnect';

export interface TelemetryRecord {
  /** Unix ms when the record was flushed (NOT when the event happened). */
  at: number;
  kind: TelemetryKind;
  /** For `error` records: the ClassifiedError category. */
  category?: string;
  /** For `error` records: the underlying numeric / string code, if any. */
  code?: number | string;
  /** For `reconnect` records: the ReconnectState.kind. */
  state?: string;
  /** Delta count since the previous flush. */
  count: number;
}

const FLUSH_INTERVAL_MS = 60_000;

export class Telemetry {
  /** Composite-key → count. Reset on every flush. */
  private counters = new Map<string, number>();
  /** JSONL path — null while disabled. Set by `setEnabled(true, path)`. */
  private logPath: string | null = null;
  /**
   * Periodic-flush handle. Number when running under Obsidian (DOM
   * `activeWindow.setInterval`), Timeout under Node tests
   * (`globalThis.setInterval`); we don't read the value, only nullness.
   */
  private timer: number | null = null;
  private enabled = false;

  /**
   * Toggle the gate. When enabled, opens the JSONL file (creates the
   * parent dir if missing) and starts the periodic flush timer.
   * When disabled, flushes any buffered counts then closes.
   *
   * **Idempotent**: calling `setEnabled(true, newPath)` while already
   * enabled is a no-op — `newPath` is ignored. To re-point the log,
   * disable first then re-enable. The plugin always re-uses
   * {@link telemetryLogPath}, so this hasn't been an issue in practice.
   */
  async setEnabled(enabled: boolean, logPath?: string): Promise<void> {
    if (enabled === this.enabled) return;
    if (enabled) {
      if (!logPath) throw new Error('Telemetry.setEnabled(true) requires a logPath');
      this.logPath = logPath;
      try {
        await fs.mkdir(path.dirname(logPath), { recursive: true });
      } catch (e) {
        logger.warn(`Telemetry: mkdir failed for ${path.dirname(logPath)}: ${errorMessage(e)}`);
      }
      this.enabled = true;
      // activeWindow is Obsidian's popout-aware scheduler; vitest setup
      // shims it to globalThis so the call works in Node tests too.
      this.timer = window.setInterval(() => { void this.flush(); }, FLUSH_INTERVAL_MS);
    } else {
      await this.flush();
      if (this.timer !== null) {
        window.clearInterval(this.timer);
        this.timer = null;
      }
      this.enabled = false;
      this.logPath = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  recordError(category: string, code?: number | string): void {
    if (!this.enabled) return;
    this.bump(`error\t${category}\t${code ?? ''}`);
  }

  recordReconnect(state: string): void {
    if (!this.enabled) return;
    this.bump(`reconnect\t${state}`);
  }

  /**
   * Snapshot for the settings "view counters" modal.
   *
   * `at` on each returned record is set to the current wall-clock ms
   * (snapshot time, not the original event time — counters are
   * deltas and the per-event timestamps were never tracked). The UI
   * uses the records for category × code aggregation only, so the
   * `at` value is informational.
   */
  snapshot(): TelemetryRecord[] {
    const out: TelemetryRecord[] = [];
    const now = Date.now();
    for (const [key, count] of this.counters) {
      out.push(this.parseKey(key, count, now));
    }
    return out;
  }

  /** Drop in-memory counts without flushing. Used by the Reset button. */
  reset(): void {
    this.counters.clear();
  }

  /**
   * Append the current counters to the JSONL log and clear them.
   * Counters are cleared ONLY after the appendFile resolves — a
   * write failure (disk full, permissions) leaves the in-memory
   * deltas intact so the next flush retries them rather than
   * silently dropping data.
   */
  async flush(): Promise<void> {
    if (!this.enabled || !this.logPath || this.counters.size === 0) return;
    const now = Date.now();
    const lines: string[] = [];
    for (const [key, count] of this.counters) {
      lines.push(JSON.stringify(this.parseKey(key, count, now)));
    }
    try {
      await fs.appendFile(this.logPath, lines.join('\n') + '\n', 'utf8');
      this.counters.clear();
    } catch (e) {
      logger.warn(`Telemetry: appendFile failed for ${this.logPath}: ${errorMessage(e)}`);
    }
  }

  private bump(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  private parseKey(key: string, count: number, at: number): TelemetryRecord {
    const parts = key.split('\t');
    if (parts[0] === 'error') {
      const codeStr = parts[2] ?? '';
      const code = codeStr === '' ? undefined
        : Number.isFinite(Number(codeStr)) ? Number(codeStr) : codeStr;
      return { at, kind: 'error', category: parts[1], code, count };
    }
    return { at, kind: 'reconnect', state: parts[1], count };
  }
}

/** Singleton — wired in main.ts onload, observed by ConnectionManager + errorTaxonomy. */
export const telemetry = new Telemetry();

/**
 * Canonical on-disk location for the telemetry JSONL log. Single
 * source of truth shared by `main.ts` (initial open on `onload`) and
 * `SettingsTab.ts` (re-open when the user flips the toggle).
 *
 * Lives next to the rest of the plugin's state so users see all of
 * it under one folder when they look in their vault's `.obsidian/`.
 */
export function telemetryLogPath(
  basePath: string,
  configDir: string,
  manifestId: string,
): string {
  return path.join(basePath, configDir, 'plugins', manifestId, 'telemetry.jsonl');
}
