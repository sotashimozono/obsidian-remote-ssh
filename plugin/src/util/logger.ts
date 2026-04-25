import * as fs from 'fs';
import * as path from 'path';
import type { LogLine } from '../types';

type Level = LogLine['level'];

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_GENERATIONS = 3;

type ConsoleFn = (...args: unknown[]) => void;
interface ConsoleSnapshot {
  log: ConsoleFn;
  warn: ConsoleFn;
  error: ConsoleFn;
}

export class Logger {
  private lines: LogLine[] = [];
  private listeners: Array<(line: LogLine) => void> = [];

  private fileSink: fs.WriteStream | null = null;
  private fileSinkPath: string | null = null;
  private bytesWritten = 0;

  private originalConsole: ConsoleSnapshot | null = null;

  constructor(
    private maxLines: number,
    private debug: boolean,
  ) {}

  setDebug(v: boolean) { this.debug = v; }
  setMaxLines(n: number) { this.maxLines = n; }

  private emit(level: Level, message: string) {
    if (LEVELS[level] < LEVELS['info'] && !this.debug) return;
    const line: LogLine = { level, timestamp: Date.now(), message };
    this.lines.push(line);
    if (this.lines.length > this.maxLines) this.lines.shift();
    this.listeners.forEach(fn => fn(line));
    this.writeToFile(line);
    const echo = this.originalConsole ?? console;
    if (level === 'error') echo.error(`[RemoteSSH] ${message}`);
    else if (level === 'warn') echo.warn(`[RemoteSSH] ${message}`);
    else if (this.debug) echo.log(`[RemoteSSH][${level}] ${message}`);
  }

  debug_(msg: string) { this.emit('debug', msg); }
  info(msg: string)   { this.emit('info', msg); }
  warn(msg: string)   { this.emit('warn', msg); }
  error(msg: string)  { this.emit('error', msg); }

  getLines(): LogLine[] { return [...this.lines]; }
  clear() { this.lines = []; }

  onLine(fn: (line: LogLine) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  installFileSink(filePath: string): void {
    if (this.fileSink) this.uninstallFileSink();
    this.fileSinkPath = filePath;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (e) {
      this.fallbackError(`installFileSink mkdir failed: ${(e as Error).message}`);
      return;
    }
    this.maybeRotateOnOpen();
    this.openSinkStream();
  }

  uninstallFileSink(): void {
    if (this.fileSink) {
      try { this.fileSink.end(); } catch { /* ignore */ }
    }
    this.fileSink = null;
    this.fileSinkPath = null;
    this.bytesWritten = 0;
  }

  wrapConsole(): void {
    if (this.originalConsole) return;
    const snapshot: ConsoleSnapshot = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
    this.originalConsole = snapshot;
    console.log = (...args: unknown[]) => {
      snapshot.log(...args);
      this.captureExternal('debug', args);
    };
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
    console.log = this.originalConsole.log;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    this.originalConsole = null;
  }

  private captureExternal(level: Level, args: unknown[]): void {
    if (!this.fileSink) return;
    const msg = args.map(a => this.formatArg(a)).join(' ');
    if (msg.startsWith('[RemoteSSH]')) return;
    const line: LogLine = { level, timestamp: Date.now(), message: `[external] ${msg}` };
    this.writeToFile(line);
  }

  private formatArg(a: unknown): string {
    if (a instanceof Error) return a.stack ?? a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }

  private writeToFile(line: LogLine): void {
    if (!this.fileSink) return;
    const ts = new Date(line.timestamp).toISOString();
    const text = `[${ts}] [${line.level}] ${line.message}\n`;
    try {
      this.fileSink.write(text);
      this.bytesWritten += Buffer.byteLength(text);
      if (this.bytesWritten >= MAX_LOG_SIZE_BYTES) this.rotateNow();
    } catch (e) {
      this.fallbackError(`logger writeToFile failed: ${(e as Error).message}`);
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
      this.fallbackError(`openSinkStream failed: ${(e as Error).message}`);
      this.fileSink = null;
    }
  }

  private fallbackError(msg: string): void {
    const echo = this.originalConsole?.error ?? console.error;
    echo(`[RemoteSSH:logger-fallback] ${msg}`);
  }
}

export const logger = new Logger(500, false);
