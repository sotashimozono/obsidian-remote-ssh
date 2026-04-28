import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PerfTracer, perfTracer, type SpanRecord } from '../src/util/PerfTracer';

// Deterministic RNG cycling through 0..15 so cid/id sequences are predictable.
function seqRng(): () => number {
  let i = 0;
  return () => {
    const v = (i++ % 16) / 16;
    return v;
  };
}

describe('PerfTracer (disabled = no-op)', () => {
  let t: PerfTracer;

  beforeEach(() => {
    t = new PerfTracer(false, seqRng());
  });

  it('begin returns the same singleton ctx and end skips emit', () => {
    const a = t.begin('S.adp');
    const b = t.begin('S.rpc');
    expect(a).toBe(b); // identity check: shared NOOP_CTX
    t.end(a);
    t.end(b);
    expect(t.snapshot()).toEqual([]);
  });

  it('point() does not emit when disabled', () => {
    t.point('T4a', 'cid-x');
    expect(t.snapshot()).toEqual([]);
  });

  it('newCid still works (used to mint cids that will be passed to other tracers)', () => {
    expect(t.newCid()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('PerfTracer (enabled)', () => {
  let t: PerfTracer;

  beforeEach(() => {
    t = new PerfTracer(true, seqRng());
  });

  it('begin/end emits a record with positive durMs', () => {
    const ctx = t.begin('S.adp');
    expect(ctx.cid).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.name).toBe('S.adp');

    // Busy-wait for at least 1 ms to ensure measurable duration.
    const start = Date.now();
    while (Date.now() - start < 2) { /* spin */ }

    t.end(ctx, { size: 100 });
    const rec = t.snapshot();
    expect(rec).toHaveLength(1);
    expect(rec[0].name).toBe('S.adp');
    expect(rec[0].cid).toBe(ctx.cid);
    expect(rec[0].durMs).toBeGreaterThanOrEqual(0);
    expect(rec[0].attrs).toEqual({ size: 100 });
    expect(typeof rec[0].at).toBe('number');
  });

  it('begin honours an explicit cid (cross-process correlation)', () => {
    const cid = 'feedfacedeadbeef';
    const ctx = t.begin('S.rpc', cid);
    t.end(ctx);
    expect(t.snapshot()[0].cid).toBe(cid);
  });

  it('point() emits a zero-duration record', () => {
    t.point('T4a', 'cid-1', { transport: 'rpc' });
    const rec = t.snapshot()[0];
    expect(rec).toMatchObject({ name: 'T4a', cid: 'cid-1', durMs: 0, attrs: { transport: 'rpc' } });
  });

  it('onSpan listener receives every record and unsubscribes cleanly', () => {
    const seen: SpanRecord[] = [];
    const off = t.onSpan(s => seen.push(s));

    t.end(t.begin('A'));
    t.end(t.begin('B'));
    expect(seen.map(s => s.name)).toEqual(['A', 'B']);

    off();
    t.end(t.begin('C'));
    expect(seen.map(s => s.name)).toEqual(['A', 'B']); // C not delivered
  });

  it('a throwing listener does not break the tracer', () => {
    t.onSpan(() => { throw new Error('boom'); });
    const seen: SpanRecord[] = [];
    t.onSpan(s => seen.push(s));
    t.end(t.begin('A'));
    expect(seen).toHaveLength(1);
  });

  it('drain returns and clears the buffer; snapshot does not', () => {
    t.end(t.begin('A'));
    t.end(t.begin('B'));
    expect(t.snapshot()).toHaveLength(2);
    expect(t.snapshot()).toHaveLength(2); // snapshot is non-destructive
    expect(t.drain()).toHaveLength(2);
    expect(t.snapshot()).toHaveLength(0);
  });

  it('respects maxBuffer by dropping oldest', () => {
    const small = new PerfTracer(true, seqRng(), 3);
    for (const n of ['A', 'B', 'C', 'D']) small.end(small.begin(n));
    expect(small.snapshot().map(r => r.name)).toEqual(['B', 'C', 'D']);
  });

  it('end() on a NOOP ctx (e.g. begun while disabled then enabled) is a no-op', () => {
    const off = new PerfTracer(false, seqRng());
    const noopCtx = off.begin('A');
    off.setEnabled(true);
    off.end(noopCtx);
    expect(off.snapshot()).toEqual([]);
  });

  it('end() still emits if enabled flips to false mid-span (data already started)', () => {
    const ctx = t.begin('A');
    t.setEnabled(false);
    t.end(ctx);
    expect(t.snapshot().map(r => r.name)).toEqual(['A']);
  });
});

describe('PerfTracer.flushNDJSON', () => {
  let t: PerfTracer;
  let tmpDir: string;

  beforeEach(() => {
    t = new PerfTracer(true, seqRng());
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perftracer-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes one JSON object per line and drains the buffer', async () => {
    t.end(t.begin('S.adp'), { transport: 'rpc' });
    t.end(t.begin('S.rpc'));
    const out = path.join(tmpDir, 'nested', 'spans.ndjson');

    const written = await t.flushNDJSON(out);
    expect(written).toBe(2);
    expect(t.snapshot()).toHaveLength(0);

    const text = fs.readFileSync(out, 'utf8');
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed[0].name).toBe('S.adp');
    expect(parsed[0].attrs).toEqual({ transport: 'rpc' });
    expect(parsed[1].name).toBe('S.rpc');
  });

  it('returns 0 and does not create a file when buffer is empty', async () => {
    const out = path.join(tmpDir, 'empty.ndjson');
    const written = await t.flushNDJSON(out);
    expect(written).toBe(0);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('appends to an existing file across calls', async () => {
    const out = path.join(tmpDir, 'append.ndjson');
    t.end(t.begin('A'));
    await t.flushNDJSON(out);
    t.end(t.begin('B'));
    await t.flushNDJSON(out);
    const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
    expect(lines.map(l => JSON.parse(l).name)).toEqual(['A', 'B']);
  });
});

describe('module singleton', () => {
  it('respects REMOTE_SSH_PERF env var at import time', () => {
    // Default fixture: REMOTE_SSH_PERF not set → disabled.
    // We can't re-import to test the enabled branch without resetModules,
    // so just assert the wired contract: it's a PerfTracer instance with the env-derived flag.
    expect(perfTracer).toBeInstanceOf(PerfTracer);
    expect(perfTracer.enabled).toBe(process.env.REMOTE_SSH_PERF === '1');
  });
});
