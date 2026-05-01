import * as fs from 'fs';
import * as path from 'path';

// Span context returned by `begin()`. Keep it opaque to callers.
export interface SpanCtx {
  readonly id: string;
  readonly cid: string;
  readonly name: string;
  readonly t0: number;
}

// Emitted record. `durMs` is high-resolution if `performance.now()` is available.
export interface SpanRecord {
  name: string;
  cid: string;
  durMs: number;
  attrs?: Record<string, unknown>;
  at: number;
}

// Sentinel returned by `begin()` while disabled. `end()` checks identity to skip emit.
const NOOP_CTX: SpanCtx = Object.freeze({ id: '', cid: '', name: '', t0: 0 });

const HEX = '0123456789abcdef';
function makeHex(rng: () => number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += HEX[Math.floor(rng() * 16) & 15];
  return out;
}

const DEFAULT_MAX_BUFFER = 10_000;

interface PerfHostApi {
  now?: () => number;
  mark?: (n: string) => void;
  measure?: (n: string, s: string, e: string) => void;
}

function getHostPerf(): PerfHostApi | undefined {
  // We're probing for the cross-environment `performance` global (browser
  // and Node 16+). `performance` is a standard global in both runtimes,
  // so we reach for it directly instead of going through `globalThis`
  // (which the `prefer-active-doc` rule bans). The `typeof` guard keeps
  // us safe in unusual hosts that lack the global entirely.
  if (typeof performance === 'undefined') return undefined;
  return performance;
}

export class PerfTracer {
  private buffer: SpanRecord[] = [];
  private listeners: Array<(s: SpanRecord) => void> = [];
  private idSeq = 0;

  constructor(
    public enabled: boolean = false,
    private rng: () => number = Math.random,
    private maxBuffer: number = DEFAULT_MAX_BUFFER,
  ) {}

  setEnabled(v: boolean): void { this.enabled = v; }

  // 16-char hex correlation id. Not cryptographic — used to thread a
  // single logical change across writer→daemon→reader processes.
  newCid(): string {
    return makeHex(this.rng, 16);
  }

  begin(name: string, cid?: string): SpanCtx {
    if (!this.enabled) return NOOP_CTX;
    const id = `${++this.idSeq}-${makeHex(this.rng, 8)}`;
    const ctx: SpanCtx = {
      id,
      cid: cid ?? this.newCid(),
      name,
      t0: this.now(),
    };
    this.mark(`${name}.start.${id}`);
    return ctx;
  }

  // Safe to call even if `enabled` flipped to false mid-span: a real ctx
  // still emits, but a NOOP_CTX is a hard skip (no allocation, no emit).
  end(ctx: SpanCtx, attrs?: Record<string, unknown>): void {
    if (ctx === NOOP_CTX) return;
    const t1 = this.now();
    const durMs = t1 - ctx.t0;
    this.mark(`${ctx.name}.end.${ctx.id}`);
    this.measure(ctx.name, `${ctx.name}.start.${ctx.id}`, `${ctx.name}.end.${ctx.id}`);
    this.push({ name: ctx.name, cid: ctx.cid, durMs, attrs, at: Date.now() });
  }

  // Zero-duration event. Used for one-shot landmarks (e.g. T4a notify recv).
  point(name: string, cid: string, attrs?: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.mark(`${name}.point.${++this.idSeq}`);
    this.push({ name, cid, durMs: 0, attrs, at: Date.now() });
  }

  onSpan(fn: (s: SpanRecord) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  snapshot(): SpanRecord[] { return [...this.buffer]; }
  drain(): SpanRecord[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }
  clear(): void { this.buffer = []; }

  async flushNDJSON(filePath: string): Promise<number> {
    const recs = this.drain();
    if (recs.length === 0) return 0;
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const text = recs.map(r => JSON.stringify(r)).join('\n') + '\n';
    await fs.promises.appendFile(filePath, text, 'utf8');
    return recs.length;
  }

  private push(rec: SpanRecord): void {
    this.buffer.push(rec);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    for (const fn of this.listeners) {
      try { fn(rec); } catch { /* listener crash must not break tracer */ }
    }
  }

  private now(): number {
    const p = getHostPerf();
    return p?.now ? p.now() : Date.now();
  }

  private mark(name: string): void {
    const p = getHostPerf();
    try { p?.mark?.(name); } catch { /* ignore: e.g. duplicate mark in DOM perf */ }
  }

  private measure(name: string, start: string, end: string): void {
    const p = getHostPerf();
    try { p?.measure?.(name, start, end); } catch { /* ignore */ }
  }
}

const envEnabled =
  typeof process !== 'undefined' &&
  typeof process.env !== 'undefined' &&
  process.env.REMOTE_SSH_PERF === '1';

export const perfTracer = new PerfTracer(envEnabled);

/** Wrap an async operation with a perf trace span. */
export async function withPerfTrace<T>(
  label: string,
  meta: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = perfTracer.begin(label);
  try {
    return await fn();
  } finally {
    perfTracer.end(ctx, meta);
  }
}
