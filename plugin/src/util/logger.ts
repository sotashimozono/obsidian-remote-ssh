import * as fs from 'fs';
import type { WriteStream } from 'fs';
import * as path from 'path';
import type { LogLine } from '../types';
import { redactFields, redactString } from './redact';
import { errorMessage } from "./errorMessage";

type Level = LogLine['level'];
export type LogFields = Record<string, unknown>;

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_GENERATIONS = 3;

type ConsoleFn = (...args: unknown[]) => void;
interface ConsoleSnapshot {
  warn: ConsoleFn;
  error: ConsoleFn;
}

export class Logger {
  private lines: LogLine[] = [];
  private listeners: Array<(line: LogLine) => void> = [];

  private fileSink: WriteStream | null = null;
  private fileSinkPath: string | null = null;
  private bytesWritten = 0;

  private originalConsole: ConsoleSnapshot | null = null;

  constructor(
    private maxLines: number,
    private debug: boolean,
  ) {}

  setDebug(v: boolean) { this.debug = v; }
  setMaxLines(n: number) { this.maxLines = n; }

  private emit(level: Level, message: string, fields?: LogFields) {
    if (LEVELS[level] < LEVELS['info'] && !this.debug) return;
    // Redact at the boundary so listeners + file sink + console
    // echo all see the sanitised payload — no secrets leak even
    // if a downstream sink starts persisting `LogLine` directly.
    const safeMessage = redactString(message);
    const safeFields = fields ? redactFields(fields) : undefined;
    const line: LogLine = {
      level,
      timestamp: Date.now(),
      message: safeMessage,
      ...(safeFields ? { fields: safeFields } : {}),
    };
    this.lines.push(line);
    if (this.lines.length > this.maxLines) this.lines.shift();
    this.listeners.forEach(fn => fn(line));
    this.writeToFile(line);
    const echo = this.originalConsole ?? console;
    // Console echo shows the human-friendly format (the file sink
    // gets the JSONL form via writeToFile). When fields are
    // present, render them as a compact JSON suffix so the dev
    // console scan stays one-line per emit.
    //
    // Note: info/debug emits route through `console.debug` (allowed
    // by `obsidianmd/rule-custom-message`). `console.log` would also
    // work for users but the rule disallows it; debug-level visibility
    // is identical in DevTools.
    const fieldsSuffix = safeFields ? ` ${JSON.stringify(safeFields)}` : '';
    if (level === 'error') echo.error(`[RemoteSSH] ${safeMessage}${fieldsSuffix}`);
    else if (level === 'warn') echo.warn(`[RemoteSSH] ${safeMessage}${fieldsSuffix}`);
    else if (this.debug) console.debug(`[RemoteSSH][${level}] ${safeMessage}${fieldsSuffix}`);
  }

  debug_(msg: string, fields?: LogFields) { this.emit('debug', msg, fields); }
  info(msg: string, fields?: LogFields)   { this.emit('info', msg, fields); }
  warn(msg: string, fields?: LogFields)   { this.emit('warn', msg, fields); }
  error(msg: string, fields?: LogFields)  { this.emit('error', msg, fields); }

  getLines(): LogLine[] { return [...this.lines]; }
  clear() { this.lines = []; }

  onLine(fn: (line: LogLine) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  installFileSink(filePath: string): void {
    if (this.fileSink) void this.uninstallFileSink();
    this.fileSinkPath = filePath;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (e) {
      this.fallbackError(`installFileSink mkdir failed: ${errorMessage(e)}`);
      return;
    }
    this.maybeRotateOnOpen();
    this.openSinkStream();
  }

  /**
   * Stop forwarding to the file sink and wait for the underlying
   * stream to flush to disk. Returns a Promise so callers (tests
   * + the plugin's onunload teardown) can `await` actual close;
   * fire-and-forget behaviour is preserved when the Promise is
   * discarded.
   *
   * Phase D-β change: previously this returned `void` and the
   * stream's `.end()` callback was never observed, so tests that
   * read the file immediately after calling uninstall would race
   * the buffered write.
   */
  uninstallFileSink(): Promise<void> {
    const sink = this.fileSink;
    this.fileSink = null;
    this.fileSinkPath = null;
    this.bytesWritten = 0;
    if (!sink) return Promise.resolve();
    return new Promise<void>((resolve) => {
      try {
        sink.end(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  wrapConsole(): void {
    if (this.originalConsole) return;
    // We intercept `console.warn` / `console.error` so that anything a
    // user (or a third-party plugin) logs at warn/error severity also
    // lands in our JSONL file sink, giving us complete forensic
    // context when triaging support reports.
    //
    // We deliberately do NOT wrap `console.log` / `console.info` /
    // `console.debug` — the Obsidian community guidelines (enforced by
    // `obsidianmd/rule-custom-message`) disallow gratuitous use of
    // those methods, so capturing them would encourage exactly the
    // anti-pattern the rule exists to prevent.
    const snapshot: ConsoleSnapshot = {
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
    this.originalConsole = snapshot;
    console.warn = (...args: unknown[]) => {
      snapshot.warn(...args);
      this.captureExternal('warn', args);
    };
    console.error = (...args: unknown[]) => {
      snapshot.error(...args);
      this.captureExternal('error', args);
    };
  }

  unwrapConsole(): void {
    if (!this.originalConsole) return;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    this.originalConsole = null;
  }

  private captureExternal(level: Level, args: unknown[]): void {
    if (!this.fileSink) return;
    const msg = args.map(a => this.formatArg(a)).join(' ');
    if (msg.startsWith('[RemoteSSH]')) return;
    const line: LogLine = {
      level,
      timestamp: Date.now(),
      message: redactString(msg),
      fields: { external: true },
    };
    this.writeToFile(line);
  }

  private formatArg(a: unknown): string {
    if (a instanceof Error) return a.stack ?? a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }

  private writeToFile(line: LogLine): void {
    if (!this.fileSink) return;
    // JSONL — one JSON object per line (Phase D-β / F20).
    // Schema: {"ts": ISO8601, "level": Level, "msg": string,
    //          "fields"?: object}
    // Replaces the old `[ts] [level] msg` text format. Existing
    // `tail -f <log>` works (it's still newline-delimited); for
    // post-mortem analysis pipe through `jq` instead of grep.
    const obj: {
      ts: string;
      level: Level;
      msg: string;
      fields?: Record<string, unknown>;
    } = {
      ts: new Date(line.timestamp).toISOString(),
      level: line.level,
      msg: line.message,
    };
    if (line.fields) obj.fields = line.fields;
    let text: string;
    try {
      text = JSON.stringify(obj) + '\n';
    } catch (e) {
      // A field that contains a circular reference would crash
      // JSON.stringify; fall back to a stringified version so
      // the line still lands in the log instead of vanishing.
      text = JSON.stringify({
        ts: obj.ts, level: obj.level, msg: obj.msg,
        fields: { _serialiseError: errorMessage(e) },
      }) + '\n';
    }
    try {
      this.fileSink.write(text);
      this.bytesWritten += Buffer.byteLength(text);
      if (this.bytesWritten >= MAX_LOG_SIZE_BYTES) this.rotateNow();
    } catch (e) {
      this.fallbackError(`logger writeToFile failed: ${errorMessage(e)}`);
    }
  }

  private maybeRotateOnOpen(): void {
    if (!this.fileSinkPath) return;
    try {
      const stat = fs.statSync(this.fileSinkPath);
      if (stat.size >= MAX_LOG_SIZE_BYTES) this.cascadeRotate();
    } catch { /* file does not exist yet */ }
  }

  private rotateNow(): void {
    if (!this.fileSinkPath) return;
    if (this.fileSink) {
      try { this.fileSink.end(); } catch { /* ignore */ }
      this.fileSink = null;
    }
    this.cascadeRotate();
    this.bytesWritten = 0;
    this.openSinkStream();
  }

  private cascadeRotate(): void {
    if (!this.fileSinkPath) return;
    const oldest = `${this.fileSinkPath}.${MAX_GENERATIONS}`;
    if (fs.existsSync(oldest)) {
      try { fs.unlinkSync(oldest); } catch { /* ignore */ }
    }
    for (let i = MAX_GENERATIONS - 1; i >= 1; i--) {
      const src = `${this.fileSinkPath}.${i}`;
      const dst = `${this.fileSinkPath}.${i + 1}`;
      if (fs.existsSync(src)) {
        try { fs.renameSync(src, dst); } catch { /* ignore */ }
      }
    }
    if (fs.existsSync(this.fileSinkPath)) {
      try { fs.renameSync(this.fileSinkPath, `${this.fileSinkPath}.1`); } catch { /* ignore */ }
    }
  }

  private openSinkStream(): void {
    if (!this.fileSinkPath) return;
    try {
      this.fileSink = fs.createWriteStream(this.fileSinkPath, { flags: 'a' });
      this.fileSink.on('error', (err) => {
        this.fallbackError(`fileSink stream error: ${err.message}`);
      });
    } catch (e) {
      this.fallbackError(`openSinkStream failed: ${errorMessage(e)}`);
      this.fileSink = null;
    }
  }

  private fallbackError(msg: string): void {
    const echo = this.originalConsole?.error ?? console.error;
    echo(`[RemoteSSH:logger-fallback] ${msg}`);
  }
}

export const logger = new Logger(500, false);
