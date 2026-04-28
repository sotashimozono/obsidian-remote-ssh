import { describe, it, expect } from 'vitest';
import { PerfAggregator } from './integration/helpers/perfAggregator';

/**
 * Pure-module unit coverage for the bench-side aggregator. The path
 * lives under `tests/integration/helpers/` (consumer is the M6 bench)
 * but the module itself is integration-free, so it gets unit tests
 * here in the standard `tests/` directory.
 */

describe('PerfAggregator — keying & isolation', () => {
  it('starts empty', () => {
    const a = new PerfAggregator();
    expect(a.size()).toBe(0);
    expect(a.percentiles('S.adp', 'rpc', 1024)).toBeNull();
    expect(a.toNDJSON()).toBe('');
    expect(a.toMarkdownTable()).toBe('');
  });

  it('isolates samples across (span, transport, sizeBytes) tuples', () => {
    const a = new PerfAggregator();
    a.record('S.adp', 'rpc', 1024, 1.0);
    a.record('S.adp', 'rpc', 1024, 2.0);
    a.record('S.adp', 'rpc', 100_000, 5.0); // different size → different bucket
    a.record('S.adp', 'sftp', 1024, 7.0);   // different transport
    a.record('S.rpc', 'rpc', 1024, 0.5);    // different span

    expect(a.size()).toBe(4);
    expect(a.percentiles('S.adp', 'rpc', 1024)?.n).toBe(2);
    expect(a.percentiles('S.adp', 'rpc', 100_000)?.n).toBe(1);
    expect(a.percentiles('S.adp', 'sftp', 1024)?.n).toBe(1);
    expect(a.percentiles('S.rpc', 'rpc', 1024)?.n).toBe(1);
  });

  it('drops non-finite or negative samples', () => {
    const a = new PerfAggregator();
    a.record('S.adp', 'rpc', 1024, NaN);
    a.record('S.adp', 'rpc', 1024, -1);
    a.record('S.adp', 'rpc', 1024, Infinity);
    expect(a.size()).toBe(0);
    a.record('S.adp', 'rpc', 1024, 0); // 0 is allowed (sub-resolution)
    expect(a.percentiles('S.adp', 'rpc', 1024)?.n).toBe(1);
  });
});

describe('PerfAggregator — percentile math', () => {
  it('single-sample bucket: every percentile equals that sample', () => {
    const a = new PerfAggregator();
    a.record('S.adp', 'rpc', 1024, 7.0);
    const s = a.percentiles('S.adp', 'rpc', 1024);
    expect(s).not.toBeNull();
    expect(s!.p50).toBe(7);
    expect(s!.p95).toBe(7);
    expect(s!.p99).toBe(7);
    expect(s!.mean).toBe(7);
    expect(s!.stddev).toBe(0);
    expect(s!.n).toBe(1);
  });

  it('matches the R-7 / numpy linear-interpolated percentile on 1..10', () => {
    const a = new PerfAggregator();
    for (let i = 1; i <= 10; i++) a.record('S.adp', 'rpc', 1024, i);
    const s = a.percentiles('S.adp', 'rpc', 1024)!;
    // numpy: percentile([1..10], [50, 95, 99]) → [5.5, 9.55, 9.91]
    expect(s.p50).toBeCloseTo(5.5, 5);
    expect(s.p95).toBeCloseTo(9.55, 5);
    expect(s.p99).toBeCloseTo(9.91, 5);
    expect(s.mean).toBeCloseTo(5.5, 5);
    // population stddev of 1..10 ≈ 2.872
    expect(s.stddev).toBeCloseTo(2.8722813, 5);
    expect(s.n).toBe(10);
    expect(s.filtered).toBe(0); // no outlier filter applied
  });

  it('mean / stddev / n on a constant series', () => {
    const a = new PerfAggregator();
    for (let i = 0; i < 5; i++) a.record('S.adp', 'rpc', 1024, 4.0);
    const s = a.percentiles('S.adp', 'rpc', 1024)!;
    expect(s.mean).toBe(4);
    expect(s.stddev).toBe(0);
    expect(s.n).toBe(5);
  });
});

describe('PerfAggregator — Tukey 1.5×IQR outlier filtering', () => {
  it('removes the obvious outlier from 1..10 + 1000', () => {
    const a = new PerfAggregator();
    for (let i = 1; i <= 10; i++) a.record('S.adp', 'rpc', 1024, i);
    a.record('S.adp', 'rpc', 1024, 1000);

    const raw = a.percentiles('S.adp', 'rpc', 1024)!;
    expect(raw.n).toBe(11);
    // mean of 1..10 + 1000 = 95.45..., dragged way up by the outlier
    expect(raw.mean).toBeGreaterThan(90);

    const filt = a.percentiles('S.adp', 'rpc', 1024, { filterOutliers: true })!;
    // Q1≈3.25, Q3≈8.5 (after sort), IQR≈5.25, hi-fence ≈ 16.4 → 1000 dropped
    expect(filt.n).toBe(10);
    expect(filt.filtered).toBe(1);
    expect(filt.mean).toBeCloseTo(5.5, 5);
  });

  it('skips the filter on series with fewer than 4 samples (IQR is meaningless)', () => {
    const a = new PerfAggregator();
    a.record('S.adp', 'rpc', 1024, 1);
    a.record('S.adp', 'rpc', 1024, 1);
    a.record('S.adp', 'rpc', 1024, 1000); // would be a clear outlier with more samples
    const filt = a.percentiles('S.adp', 'rpc', 1024, { filterOutliers: true })!;
    expect(filt.n).toBe(3);
    expect(filt.filtered).toBe(0);
  });
});

describe('PerfAggregator — output formats', () => {
  it('toNDJSON: one JSON object per bucket, trailing newline', () => {
    const a = new PerfAggregator();
    a.record('S.adp', 'rpc', 1024, 1.0);
    a.record('S.adp', 'rpc', 1024, 3.0);
    a.record('S.rpc', 'rpc', 1024, 0.5);

    const text = a.toNDJSON();
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ span: 'S.adp', transport: 'rpc', sizeBytes: 1024, n: 2 });
    expect(parsed[0].p50).toBeCloseTo(2.0, 5);
    expect(parsed[1]).toMatchObject({ span: 'S.rpc', transport: 'rpc', sizeBytes: 1024, n: 1 });
  });

  it('toNDJSON honours filterOutliers and reports the dropped count', () => {
    const a = new PerfAggregator();
    for (let i = 1; i <= 10; i++) a.record('S.adp', 'rpc', 1024, i);
    a.record('S.adp', 'rpc', 1024, 1000);

    const filtered = JSON.parse(a.toNDJSON({ filterOutliers: true }).trim());
    expect(filtered.n).toBe(10);
    expect(filtered.filtered).toBe(1);
  });

  it('toMarkdownTable: header + separator + per-bucket row', () => {
    const a = new PerfAggregator();
    a.record('S.adp', 'rpc', 1024, 1.0);
    a.record('S.adp', 'rpc', 1024, 3.0);

    const md = a.toMarkdownTable();
    const lines = md.split('\n');
    expect(lines[0]).toContain('| span | transport |');
    expect(lines[1]).toMatch(/\|---/); // separator
    expect(lines[2]).toContain('| S.adp | rpc | 1024 | 2 |');
  });

  it('toMarkdownTable: numeric formatting widens by magnitude', () => {
    const a = new PerfAggregator();
    a.record('A', 'rpc', 0, 0.123456); // sub-millisecond → 3 decimals
    a.record('B', 'rpc', 0, 12.345);   // sub-100ms → 2 decimals
    a.record('C', 'rpc', 0, 1234.5);   // ≥100ms → 1 decimal
    const md = a.toMarkdownTable();
    expect(md).toContain('0.123');
    expect(md).toContain('12.35');
    expect(md).toContain('1234.5');
  });
});

describe('PerfAggregator — buckets() introspection', () => {
  it('lists every (span, transport, sizeBytes) seen, with raw counts', () => {
    const a = new PerfAggregator();
    a.record('S.adp', 'rpc', 1024, 1);
    a.record('S.adp', 'rpc', 1024, 2);
    a.record('S.rpc', 'sftp', 0, 5);
    const bs = a.buckets();
    expect(bs).toEqual([
      { span: 'S.adp', transport: 'rpc',  sizeBytes: 1024, n: 2 },
      { span: 'S.rpc', transport: 'sftp', sizeBytes: 0,    n: 1 },
    ]);
  });
});
