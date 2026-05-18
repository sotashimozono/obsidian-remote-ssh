import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Structured-log oracle for the connect-lifecycle e2e.
 *
 * The plugin's logger writes JSON-lines to
 * `<vault>/.obsidian/plugins/remote-ssh/console.log` (a rolling
 * buffer — NUL-padded, the last line may be partial). The connect
 * lifecycle leaves a deterministic trail there: `Adapter patched via
 * SFTP|RPC`, `populateVaultFromRemote(...): … built`,
 * `WindowSpawner: firing obsidian://open`, etc.
 *
 * The diagnosed production failure was precisely the *absence* of the
 * patch/populate lines plus a *runaway* count of the WindowSpawner
 * line. So a robust e2e asserts on this trail rather than on UI
 * timing alone — the log is the single source of truth for "did the
 * post-SFTP-open orchestration actually run".
 */

export interface LogEntry {
  ts?: string;
  level?: string;
  msg?: string;
}

export function logPathFor(vaultPath: string): string {
  return path.join(
    vaultPath,
    '.obsidian',
    'plugins',
    'remote-ssh',
    'console.log',
  );
}

/**
 * Parse the JSON-lines log. Tolerant of the rolling buffer's NUL
 * padding and a truncated final line — anything unparseable is
 * skipped rather than throwing, so a mid-write read just yields
 * fewer entries and the caller's poll retries.
 */
export function readLogEntries(logPath: string): LogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch {
    return []; // not created yet — caller polls
  }
  const out: LogEntry[] = [];
  for (const line of raw.replace(/\0/g, '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const parsed: unknown = JSON.parse(s);
      // A log line is a JSON *object*; `JSON.parse` also accepts bare
      // scalars (`123`, `"x"`, `null`) — casting those to LogEntry
      // would be a lie that silently yields `{msg: undefined}` rows.
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as LogEntry);
      }
    } catch {
      // partial / non-JSON line — skip
    }
  }
  return out;
}

/**
 * A timestamp cutoff for the oracle. The plugin logs `ts` as an
 * ISO-8601 UTC string (`2026-05-18T02:33:21.043Z`), which is
 * lexicographically ordered, so a string `>=` compare is a correct
 * chronological filter without parsing.
 *
 * `console.log` is an *append* buffer keyed by the (now per-spec)
 * profile id, but a Playwright RETRY of the same spec reuses the
 * `beforeAll` scaffold — so the retry inherits the first attempt's
 * lines in the same file. Capturing `new Date().toISOString()` right
 * before the shadow window launches and passing it as `since` makes
 * every oracle consider only THIS attempt's lines: a stale `SFTP
 * channel open` / `Adapter patched` from a prior attempt (or a prior
 * spec, or a cached runner) can no longer satisfy a wait or inflate a
 * count. Entries with no `ts` are excluded once a cutoff is set
 * (can't prove they're fresh). Omitting `since` keeps the legacy
 * unfiltered behaviour for the rpc specs that don't share this race.
 */
function entriesSince(logPath: string, since?: string): LogEntry[] {
  const all = readLogEntries(logPath);
  if (!since) return all;
  return all.filter((e) => typeof e.ts === 'string' && e.ts >= since);
}

/** Count entries whose `msg` matches `pattern` (optionally since a cutoff). */
export function countLog(
  logPath: string,
  pattern: RegExp,
  since?: string,
): number {
  return entriesSince(logPath, since).filter(
    (e) => typeof e.msg === 'string' && pattern.test(e.msg),
  ).length;
}

/**
 * Poll until at least one entry's `msg` matches `pattern`, or throw
 * after `timeoutMs`. The throw message includes the last few log
 * lines so a failure tells you *where* the lifecycle stalled — the
 * exact diagnostic the production incident lacked.
 */
export async function waitForLog(
  logPath: string,
  pattern: RegExp,
  timeoutMs: number,
  label: string,
  since?: string,
): Promise<LogEntry> {
  const deadline = Date.now() + timeoutMs;
  let entries: LogEntry[] = [];
  while (Date.now() < deadline) {
    entries = entriesSince(logPath, since);
    const hit = entries.find(
      (e) => typeof e.msg === 'string' && pattern.test(e.msg),
    );
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  const tail = entries
    .slice(-12)
    .map((e) => `  ${e.ts ?? '?'} [${e.level ?? '?'}] ${e.msg ?? ''}`)
    .join('\n');
  throw new Error(
    `log-oracle: ${label} — no log line matched ${pattern} within ` +
    `${timeoutMs}ms at ${logPath}.\nLast lines:\n${tail || '  (log empty / absent)'}`,
  );
}

/**
 * Poll until `pattern` has occurred at least `min` times, or throw
 * after `timeoutMs`. Used by the reconnect spec: a successful SFTP
 * reconnect emits a *fresh* `SFTP channel open` line, so "count grew
 * past the pre-drop baseline" is the reliable recovered-oracle for
 * the SFTP transport (setState doesn't log; recovery has no other
 * stable logged signal).
 */
export async function waitForCount(
  logPath: string,
  pattern: RegExp,
  min: number,
  timeoutMs: number,
  label: string,
  since?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let n = 0;
  while (Date.now() < deadline) {
    n = countLog(logPath, pattern, since);
    if (n >= min) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `log-oracle: ${label} — ${pattern} occurred ${n}× (< ${min}) within ` +
    `${timeoutMs}ms at ${logPath}`,
  );
}

/**
 * Assert `pattern` occurs at most `max` times — the spawn-loop guard.
 * In the broken build `WindowSpawner: firing obsidian://open` repeated
 * dozens of times; a healthy connect fires it a bounded number.
 */
export function assertAtMost(
  logPath: string,
  pattern: RegExp,
  max: number,
  label: string,
  since?: string,
): void {
  const n = countLog(logPath, pattern, since);
  if (n > max) {
    throw new Error(
      `log-oracle: ${label} — expected ${pattern} at most ${max}× but ` +
      `saw ${n}× at ${logPath} (runaway loop — the production symptom)`,
    );
  }
}
