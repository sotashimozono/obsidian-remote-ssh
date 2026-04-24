import type { LogLine } from '../types';

type Level = LogLine['level'];

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  private lines: LogLine[] = [];
  private listeners: Array<(line: LogLine) => void> = [];

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
    if (level === 'error') console.error(`[RemoteSSH] ${message}`);
    else if (level === 'warn') console.warn(`[RemoteSSH] ${message}`);
    else if (this.debug) console.log(`[RemoteSSH][${level}] ${message}`);
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
}

export const logger = new Logger(500, false);
