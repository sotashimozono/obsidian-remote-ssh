import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../util/logger';

/**
 * Discriminated union of every adapter operation the queue can hold.
 * Mirrors `SftpDataAdapter`'s write-side surface — read-side ops are
 * intentionally NOT queueable (they'd lie about file presence to the
 * editor).
 *
 * Binary payloads are base64-encoded to keep the on-disk JSONL line-
 * delimited; the daemon's RPC schema already uses the same encoding,
 * so the queue's encoded form maps 1:1 onto a replayed `fs.write*`.
 */
export type QueuedOp =
  | { kind: 'write'; path: string; contentBase64: string; expectedMtime?: number }
  | { kind: 'writeBinary'; path: string; contentBase64: string; expectedMtime?: number }
  | { kind: 'append'; path: string; contentBase64: string }
  | { kind: 'appendBinary'; path: string; contentBase64: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'remove'; path: string }
  | { kind: 'rmdir'; path: string; recursive: boolean }
  | { kind: 'rename'; oldPath: string; newPath: string }
  | { kind: 'copy'; srcPath: string; dstPath: string }
  | { kind: 'trashLocal'; path: string };

export interface QueueEntry {
  /** Monotonically increasing within a queue's lifetime; survives restarts. */
  readonly id: number;
  /** Unix milliseconds when the op was enqueued. */
  readonly ts: number;
  readonly op: QueuedOp;
}

export interface QueueStats {
  /** Number of pending (un-completed) entries. */
  entries: number;
  /** Approx in-memory byte size of pending payloads (base64 included). */
  bytes: number;
  /** Configured cap. */
  maxBytes: number;
  /** Bytes the on-disk log currently occupies (pre-compaction overhead). */
  logFileBytes: number;
}

/**
 * Default cap on total in-memory payload bytes. 500 MB comfortably
 * holds a multi-day disconnect of typical text edits plus a few
 * attachments; small enough that a stuck queue doesn't quietly
 * consume the disk.
 */
export const DEFAULT_MAX_BYTES: number = 500 * 1024 * 1024;

/**
 * Append-only JSONL log of pending offline writes, persisted under
 * the plugin's queue directory so an Electron restart doesn't drop
 * the user's edits. The log holds two kinds of records:
 *
 *   {"type":"op","id":N,"ts":...,"op":{...}}     — enqueue
 *   {"type":"completed","id":N,"ts":...}          — replay/discard
 *
 * On `open()`, the log is replayed line-by-line; any `op` record
 * without a matching `completed` becomes a pending entry. When the
 * log file grows past 2× the live pending bytes, a compaction pass
 * rewrites it without the completed-and-tombstoned entries.
 *
 * Concurrency: this class assumes a single owner (the plugin
 * instance). Two writers to the same dir would interleave appends
 * and corrupt accounting.
 */
export class OfflineQueue {
  private readonly logFile: string;
  private readonly maxBytes: number;
  /** Pending entries in FIFO order. Mirror of the on-disk log minus completed ones. */
  private readonly pendingMap = new Map<number, QueueEntry>();
  private nextId = 1;
  /** Live byte total of pendingMap payloads (approximate). */
  private bytesUsed = 0;
  /** Bytes currently on disk in the log file (incl. tombstones, pre-compaction). */
  private logFileBytes = 0;

  private constructor(dir: string, maxBytes: number) {
    this.logFile = path.join(dir, 'log.jsonl');
    this.maxBytes = maxBytes;
  }

  /**
   * Open (or initialise) a queue rooted at `dir`. Replays the
   * existing log to seed the pending set.
   */
  static async open(dir: string, opts: { maxBytes?: number } = {}): Promise<OfflineQueue> {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    await fs.mkdir(dir, { recursive: true });
    const q = new OfflineQueue(dir, maxBytes);
    await q.replayLog();
    return q;
  }

  /**
   * Append `op` to the queue. Returns the assigned id. Throws if
   * adding `op`'s payload would push the in-memory byte total over
   * the configured cap (so the user gets a loud failure rather than
   * a silent disk fill).
   */
  async enqueue(op: QueuedOp): Promise<number> {
    const entry: QueueEntry = { id: this.nextId++, ts: Date.now(), op };
    const line = serialiseOp(entry);
    const lineBytes = byteLengthUtf8(line);
    if (this.bytesUsed + lineBytes > this.maxBytes) {
      this.nextId--; // give the id back so subsequent enqueues stay tight
      throw new Error(
        `OfflineQueue: enqueue would exceed cap (${this.bytesUsed + lineBytes} > ${this.maxBytes} bytes)`,
      );
    }
    await fs.appendFile(this.logFile, line + '\n', 'utf8');
    this.pendingMap.set(entry.id, entry);
    this.bytesUsed += lineBytes;
    this.logFileBytes += lineBytes + 1; // +1 for newline
    return entry.id;
  }

  /**
   * FIFO list of un-completed entries. The replayer iterates this
   * to drain the queue against the recovered remote.
   */
  pending(): QueueEntry[] {
    return Array.from(this.pendingMap.values()).sort((a, b) => a.id - b.id);
  }

  /**
   * Mark an op as completed (replay succeeded, or user discarded it).
   * Idempotent: marking an unknown id is a no-op. Triggers
   * compaction when the on-disk log has grown past 2× the live
   * pending bytes.
   */
  async markCompleted(id: number): Promise<void> {
    const entry = this.pendingMap.get(id);
    if (!entry) return;
    const tombstone = serialiseTombstone(id);
    await fs.appendFile(this.logFile, tombstone + '\n', 'utf8');
    this.logFileBytes += byteLengthUtf8(tombstone) + 1;
    this.pendingMap.delete(id);
    this.bytesUsed -= byteLengthUtf8(serialiseOp(entry));
    if (this.bytesUsed < 0) this.bytesUsed = 0;

    if (this.shouldCompact()) {
      await this.compact();
    }
  }

  /** Drop everything. Atomic: a fresh log replaces the old one. */
  async clear(): Promise<void> {
    this.pendingMap.clear();
    this.bytesUsed = 0;
    await this.rewriteLog([]);
  }

  /**
   * Manually trigger a compaction pass. Useful in tests; production
   * code calls this implicitly via `markCompleted`.
   */
  async compact(): Promise<void> {
    await this.rewriteLog(this.pending());
  }

  stats(): QueueStats {
    return {
      entries: this.pendingMap.size,
      bytes: this.bytesUsed,
      maxBytes: this.maxBytes,
      logFileBytes: this.logFileBytes,
    };
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private async replayLog(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.logFile, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logFileBytes = 0;
        return;
      }
      throw e;
    }
    this.logFileBytes = byteLengthUtf8(raw);
    if (raw.length === 0) return;

    let lineNo = 0;
    for (const rawLine of raw.split('\n')) {
      lineNo++;
      const line = rawLine.trim();
      if (line === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        logger.warn(
          `OfflineQueue.replay: ${this.logFile}:${lineNo} malformed JSON; skipping (${(e as Error).message})`,
        );
        continue;
      }
      if (!isLogRecord(parsed)) {
        logger.warn(`OfflineQueue.replay: ${this.logFile}:${lineNo} unknown record shape; skipping`);
        continue;
      }
      if (parsed.type === 'op') {
        const entry: QueueEntry = { id: parsed.id, ts: parsed.ts, op: parsed.op };
        this.pendingMap.set(entry.id, entry);
        this.bytesUsed += byteLengthUtf8(serialiseOp(entry));
        if (entry.id >= this.nextId) this.nextId = entry.id + 1;
      } else {
        // tombstone: drop any pending entry with this id
        const dropped = this.pendingMap.get(parsed.id);
        if (dropped) {
          this.pendingMap.delete(parsed.id);
          this.bytesUsed -= byteLengthUtf8(serialiseOp(dropped));
          if (this.bytesUsed < 0) this.bytesUsed = 0;
        }
      }
    }
  }

  /**
   * Compact iff the on-disk log is more than 2× the live pending
   * bytes — a small queue with lots of completions thrashes the
   * file otherwise.
   */
  private shouldCompact(): boolean {
    // Always compact at least 4 KiB worth of slack so a tiny queue
    // doesn't pay the rewrite cost for individual tombstones.
    const slackFloor = 4 * 1024;
    return this.logFileBytes > Math.max(slackFloor, this.bytesUsed * 2);
  }

  /**
   * Atomically rewrite the log to contain only `entries` (in order)
   * and no tombstones. Tmp + rename so a crash mid-write never
   * orphans a half-written log.
   */
  private async rewriteLog(entries: QueueEntry[]): Promise<void> {
    const tmpPath = this.logFile + '.tmp';
    const lines = entries.map(e => serialiseOp(e));
    const body = lines.length === 0 ? '' : lines.join('\n') + '\n';
    await fs.writeFile(tmpPath, body, 'utf8');
    // fs.rename overwrites on POSIX; on Windows it errors if dest
    // exists, so use copyFile + unlink as a safe fallback. Try the
    // fast path first.
    try {
      await fs.rename(tmpPath, this.logFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST' || process.platform === 'win32') {
        // Best-effort overwrite: copy + unlink. Race window is small;
        // worst case the next compaction tries again.
        await fs.copyFile(tmpPath, this.logFile);
        await fs.unlink(tmpPath).catch(() => { /* ignore */ });
      } else {
        throw e;
      }
    }
    this.logFileBytes = byteLengthUtf8(body);
  }
}

// ─── (de)serialisation ───────────────────────────────────────────────────

interface OpRecord { type: 'op'; id: number; ts: number; op: QueuedOp }
interface TombstoneRecord { type: 'completed'; id: number; ts: number }
type LogRecord = OpRecord | TombstoneRecord;

function serialiseOp(entry: QueueEntry): string {
  return JSON.stringify({ type: 'op', id: entry.id, ts: entry.ts, op: entry.op });
}
function serialiseTombstone(id: number): string {
  return JSON.stringify({ type: 'completed', id, ts: Date.now() });
}

function isLogRecord(v: unknown): v is LogRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<LogRecord>;
  if (r.type === 'op') {
    return typeof r.id === 'number'
      && typeof r.ts === 'number'
      && r.op !== undefined
      && typeof (r.op as { kind?: unknown }).kind === 'string';
  }
  if (r.type === 'completed') {
    return typeof r.id === 'number' && typeof r.ts === 'number';
  }
  return false;
}

/**
 * UTF-8 byte length without depending on `Buffer` so this module
 * stays portable to environments that prefer the Web stdlib.
 */
function byteLengthUtf8(s: string): number {
  // Browser/Node both ship TextEncoder.
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).byteLength;
  }
  // Fallback: assume worst case (4 bytes/char), used only in
  // hypothetical environments without TextEncoder.
  return s.length * 4;
}

