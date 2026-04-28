import { describe, it, expect } from 'vitest';
// .mjs ESM import — vitest resolves via the same loader as production code.
import { compare, formatMarkdown, parseNDJSON } from '../scripts/perf/compare.mjs';

/**
 * Pure-module unit coverage for the M10 perf-gate comparison logic.
 * Drives `compare()` + `parseNDJSON()` + `formatMarkdown()` against
 * hand-crafted records so the gate's pass/fail behaviour is pinned
 * before the workflow ever runs against real bench output.
 */

interface PerfRecord {
  span: string;
  transport: string;
  sizeBytes: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  stddev: number;
  n: number;
  filtered?: number;
}

function rec(span: string, transport: string, sizeBytes: number, p95: number, extras: Partial<PerfRecord> = {}): PerfRecord {
  return {
    span, transport, sizeBytes,
    p50: extras.p50 ?? p95 * 0.6,
    p95,
    p99: extras.p99 ?? p95 * 1.05,
    mean: extras.mean ?? p95 * 0.55,
    stddev: extras.stddev ?? 1,
    n: extras.n ?? 100,
    filtered: extras.filtered ?? 0,
  };
}

// ── parseNDJSON ──────────────────────────────────────────────────────────

describe('parseNDJSON', () => {
  it('returns [] for an empty document', () => {
    expect(parseNDJSON('')).toEqual([]);
    expect(parseNDJSON('\n\n')).toEqual([]);
  });

  it('parses well-formed records and ignores blank lines', () => {
    const text = JSON.stringify(rec('S.adp', 'rpc', 1024, 5)) + '\n\n'
               + JSON.stringify(rec('S.rpc', 'rpc', 1024, 10)) + '\n';
    const out = parseNDJSON(text);
    expect(out.map((r: PerfRecord) => r.span)).toEqual(['S.adp', 'S.rpc']);
  });

  it('throws on the first malformed JSON line, with the line number', () => {
    const bad = JSON.stringify(rec('S.adp', 'rpc', 1024, 5)) + '\n{not json\n';
    expect(() => parseNDJSON(bad)).toThrow(/line 2/);
  });

  it('throws on a record missing required fields', () => {
    const partial = JSON.stringify({ span: 'S.adp', transport: 'rpc' });
    expect(() => parseNDJSON(partial)).toThrow(/not a PerfRecord/);
  });
});

// ── compare: status semantics ────────────────────────────────────────────

describe('compare — status semantics', () => {
  it('marks a head bucket with no baseline as `new`', () => {
    const { rows, regressions } = compare([], [rec('S.adp', 'rpc', 1024, 5)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('new');
    expect(rows[0].p95DeltaPct).toBeNull();
    expect(regressions).toEqual([]);
  });

  it('marks a baseline bucket with no head as `removed`', () => {
    const { rows } = compare([rec('S.adp', 'rpc', 1024, 5)], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('removed');
  });

  it('marks a stable bucket as `unchanged` (delta within ±5%)', () => {
    const base = rec('S.adp', 'rpc', 1024, 5);
    const head = rec('S.adp', 'rpc', 1024, 5.1); // +2% — within band
    const { rows, regressions } = compare([base], [head]);
    expect(rows[0].status).toBe('unchanged');
    expect(regressions).toEqual([]);
  });

  it('marks a regression past per-span tolerance as `regressed`', () => {
    const base = rec('S.adp', 'rpc', 1024, 5);
    const head = rec('S.adp', 'rpc', 1024, 7); // +40% — well past 25% default
    const { rows, regressions } = compare([base], [head]);
    expect(rows[0].status).toBe('regressed');
    expect(regressions).toHaveLength(1);
  });

  it('marks a clear improvement as `improved`', () => {
    const base = rec('S.adp', 'rpc', 1024, 10);
    const head = rec('S.adp', 'rpc', 1024, 6); // -40%
    const { rows } = compare([base], [head]);
    expect(rows[0].status).toBe('improved');
  });

  it('respects the per-span tolerance override (S.fs gets 40%)', () => {
    const base = rec('S.fs', 'rpc', 1024, 5);
    const head = rec('S.fs', 'rpc', 1024, 6.5); // +30% — over default 25%, under S.fs 40%
    const { rows, regressions } = compare([base], [head]);
    expect(rows[0].status).toBe('unchanged'); // wait — actually +30% is past the 5% band, so 'regressed' if above tolerance
    // Re-check: +30% < 40% (S.fs tolerance), so NOT regressed. But +30% > 5% UNCHANGED_BAND, so what is it?
    // Per the makeRow logic: if !regressed && !improved (sign), and outside ±5% band → 'unchanged'.
    // Confirmed: tolerance 40% means "regressed" only fires above 40%; +30% is above the band but
    // below tolerance → labelled 'unchanged'. Caller can still see Δ% in the table.
    expect(regressions).toEqual([]);
  });

  it('drops to `new` when baseline p95 is 0 (can\'t compute a percentage)', () => {
    const base = rec('S.adp', 'rpc', 1024, 0);
    const head = rec('S.adp', 'rpc', 1024, 5);
    const { rows } = compare([base], [head]);
    expect(rows[0].status).toBe('new');
    expect(rows[0].p95DeltaPct).toBeNull();
  });
});

// ── compare: ordering + per-bucket isolation ─────────────────────────────

describe('compare — ordering + isolation', () => {
  it('groups regressions first, then improvements, then the rest', () => {
    const out = compare(
      [
        rec('S.adp', 'rpc', 1024, 10),  // base for "improved"
        rec('S.rpc', 'rpc', 1024, 5),   // base for "regressed"
        rec('S.app', 'rpc', 1024, 5),   // base for "unchanged"
      ],
      [
        rec('S.adp', 'rpc', 1024, 6),   // -40% improved
        rec('S.rpc', 'rpc', 1024, 8),   // +60% regressed
        rec('S.app', 'rpc', 1024, 5.05),// unchanged
        rec('S.e2e', 'rpc', 1024, 50),  // new
      ],
    );
    expect(out.rows.map((r) => `${r.span}:${r.status}`)).toEqual([
      'S.rpc:regressed',
      'S.adp:improved',
      'S.app:unchanged',
      'S.e2e:new',
    ]);
  });

  it('isolates buckets across (span, transport, sizeBytes) tuples', () => {
    const base = [
      rec('S.adp', 'rpc',  1024,  5),
      rec('S.adp', 'rpc',  100_000, 10),  // different size → different bucket
      rec('S.adp', 'sftp', 1024,   5),     // different transport → different bucket
    ];
    const head = [
      rec('S.adp', 'rpc',  1024,  5.05),  // unchanged
      rec('S.adp', 'rpc',  100_000, 25),  // regressed 150%
      rec('S.adp', 'sftp', 1024,   5),     // unchanged
    ];
    const { regressions } = compare(base, head);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].sizeBytes).toBe(100_000);
    expect(regressions[0].transport).toBe('rpc');
  });
});

// ── formatMarkdown ───────────────────────────────────────────────────────

describe('formatMarkdown', () => {
  it('renders a header, table, and pass summary when no regressions', () => {
    const { rows } = compare(
      [rec('S.adp', 'rpc', 1024, 5)],
      [rec('S.adp', 'rpc', 1024, 5.05)],
    );
    const md = formatMarkdown(rows, { commitSha: 'abc1234', baselineSha: 'def5678' });
    expect(md).toMatch(/## Phase C perf-bench diff/);
    expect(md).toMatch(/\| span \| transport/);
    expect(md).toMatch(/✅ no regressions/);
    expect(md).toMatch(/baseline @ `def5678`/);
    expect(md).toMatch(/head @ `abc1234`/);
  });

  it('bolds regressed rows and emits a ❌ summary line', () => {
    const { rows } = compare(
      [rec('S.adp', 'rpc', 1024, 5)],
      [rec('S.adp', 'rpc', 1024, 10)], // +100%
    );
    const md = formatMarkdown(rows);
    expect(md).toMatch(/\*\*S\.adp\*\*/);
    expect(md).toMatch(/❌ \*\*1 bucket\(s\) regressed/);
  });

  it('emits a "no buckets" message when both inputs are empty', () => {
    const md = formatMarkdown([]);
    expect(md).toMatch(/_No bench buckets/);
  });

  it('includes a gate-enabled hint when the gate is on', () => {
    const { rows } = compare(
      [rec('S.adp', 'rpc', 1024, 5)],
      [rec('S.adp', 'rpc', 1024, 10)],
    );
    const md = formatMarkdown(rows, { gateEnabled: true });
    expect(md).toMatch(/Gate is \*\*enabled\*\*/);
  });

  it('omits the gate hint when not enabled', () => {
    const { rows } = compare(
      [rec('S.adp', 'rpc', 1024, 5)],
      [rec('S.adp', 'rpc', 1024, 10)],
    );
    const md = formatMarkdown(rows, { gateEnabled: false });
    expect(md).not.toMatch(/Gate is/);
  });
});

// ── round-trip: NDJSON in → table out ────────────────────────────────────

describe('round-trip', () => {
  it('parses two NDJSON inputs, compares, and emits a Markdown summary', () => {
    const baseText = [rec('S.adp', 'rpc', 1024, 5), rec('S.rpc', 'rpc', 1024, 30)]
      .map((r) => JSON.stringify(r)).join('\n') + '\n';
    const headText = [rec('S.adp', 'rpc', 1024, 5.1), rec('S.rpc', 'rpc', 1024, 50)]
      .map((r) => JSON.stringify(r)).join('\n') + '\n';

    const base = parseNDJSON(baseText);
    const head = parseNDJSON(headText);
    const { rows, regressions } = compare(base, head);

    expect(regressions).toHaveLength(1);
    expect(regressions[0].span).toBe('S.rpc');

    const md = formatMarkdown(rows, { commitSha: 'cafebabe', gateEnabled: true });
    expect(md).toMatch(/❌ \*\*1 bucket\(s\) regressed/);
    expect(md).toMatch(/cafebab/);
  });
});
