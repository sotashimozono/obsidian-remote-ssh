/**
 * Pure aggregator for span-duration samples produced by PerfTracer
 * during the Phase C sync-latency microbench (M6) and E2E suite (M9).
 *
 * Keyed by the bench-matrix tuple `(span, transport, sizeBytes)`:
 *
 * - **span**       — `'S.adp' | 'S.rpc' | 'S.app' | 'S.e2e' | …`
 * - **transport**  — `'rpc' | 'sftp'`
 * - **sizeBytes**  — fixture file size for the iteration (0 when N/A,
 *                    e.g. for `remove`/`rename` ops)
 *
 * Outlier filtering is opt-in per call so a single dataset can be
 * reported both raw (for transparency in CI logs) and filtered (for
 * the regression gate that compares against `perf-baseline`).
 *
 * Pure: no I/O, no clock reads, no module-level state. Safe to
 * instantiate fresh per bench iteration *or* hold across the whole
 * suite — the caller decides the granularity.
 */

export interface PerfStats {
  /** Median, p95, p99 in milliseconds (linear-interpolated, R-7 method). */
  p50: number;
  p95: number;
  p99: number;
  /** Arithmetic mean in milliseconds. */
  mean: number;
  /** Population standard deviation in milliseconds. */
  stddev: number;
  /** Sample count *after* outlier filtering (or the raw count when filtering is off). */
  n: number;
  /** Number of samples removed by the Tukey 1.5×IQR filter (0 when filtering is off). */
  filtered: number;
}

export interface PerfBucket {
  span: string;
  transport: string;
  sizeBytes: number;
  /** Raw sample count, before any outlier filtering. */
  n: number;
}

export interface PercentileOpts {
  /**
   * Drop samples outside Tukey's 1.5×IQR fences before computing
   * stats. Default `false`. Has no effect on series with fewer than
   * 4 samples (IQR is meaningless and we'd lose every point on a
   * 1- or 2-iter run).
   */
  filterOutliers?: boolean;
}

export class PerfAggregator {
  // Internal index keyed by joined tuple. Map preserves insertion
  // order so NDJSON / Markdown output is deterministic relative to
  // the order in which buckets were first seen.
  private readonly series = new Map<string, { key: SeriesKey; durs: number[] }>();

  record(span: string, transport: string, sizeBytes: number, durMs: number): void {
    if (!Number.isFinite(durMs) || durMs < 0) return;
    const key: SeriesKey = { span, transport, sizeBytes };
    const k = keyOf(key);
    let s = this.series.get(k);
    if (!s) {
      s = { key, durs: [] };
      this.series.set(k, s);
    }
    s.durs.push(durMs);
  }

  /** Number of distinct (span, transport, sizeBytes) tuples seen. */
  size(): number { return this.series.size; }

  buckets(): PerfBucket[] {
    return [...this.series.values()].map((s) => ({ ...s.key, n: s.durs.length }));
  }

  /**
   * Returns the percentile / mean / stddev for one bucket, or `null`
   * when the bucket has never been recorded.
   *
   * Note: a bucket with samples but where every sample was rejected
   * by the Tukey filter returns `n: 0` and NaN stats — caller should
   * treat that as "insufficient data after filtering" rather than as
   * an absent bucket.
   */
  percentiles(
    span: string,
    transport: string,
    sizeBytes: number,
    opts: PercentileOpts = {},
  ): PerfStats | null {
    const s = this.series.get(keyOf({ span, transport, sizeBytes }));
    if (!s) return null;
    return computeStats(s.durs, !!opts.filterOutliers);
  }

  /**
   * Newline-delimited JSON, one record per bucket. Trailing newline
   * present when at least one bucket emitted (matches the convention
   * used by `PerfTracer.flushNDJSON` so callers can `cat` the two).
   */
  toNDJSON(opts: PercentileOpts = {}): string {
    const lines: string[] = [];
    for (const s of this.series.values()) {
      const stats = computeStats(s.durs, !!opts.filterOutliers);
      lines.push(JSON.stringify({ ...s.key, ...stats }));
    }
    return lines.length === 0 ? '' : lines.join('\n') + '\n';
  }

  /**
   * Render as a Markdown table for PR comments / human review.
   * Numbers are formatted with width-aware precision (3 decimals for
   * sub-millisecond, 2 decimals for sub-100ms, 1 decimal otherwise).
   */
  toMarkdownTable(opts: PercentileOpts = {}): string {
    const rows = [...this.series.values()];
    if (rows.length === 0) return '';
    const header = '| span | transport | sizeBytes | n | p50 | p95 | p99 | mean | stddev |';
    const sep    = '|------|-----------|----------:|--:|----:|----:|----:|-----:|-------:|';
    const body = rows.map((s) => {
      const stats = computeStats(s.durs, !!opts.filterOutliers);
      return `| ${s.key.span} | ${s.key.transport} | ${s.key.sizeBytes} | ${stats.n} `
        + `| ${fmt(stats.p50)} | ${fmt(stats.p95)} | ${fmt(stats.p99)} `
        + `| ${fmt(stats.mean)} | ${fmt(stats.stddev)} |`;
    });
    return [header, sep, ...body].join('\n');
  }
}

// ─── internals ──────────────────────────────────────────────────────────

interface SeriesKey { span: string; transport: string; sizeBytes: number }

function keyOf(k: SeriesKey): string {
  // sizeBytes is bounded by the bench fixture sizes; the pipe separator
  // can't appear in span/transport names by convention, so this is
  // collision-free for our use.
  return `${k.span}|${k.transport}|${k.sizeBytes}`;
}

function computeStats(durs: number[], filterOutliers: boolean): PerfStats {
  if (durs.length === 0) {
    return { p50: NaN, p95: NaN, p99: NaN, mean: NaN, stddev: NaN, n: 0, filtered: 0 };
  }
  const sorted = [...durs].sort((a, b) => a - b);
  const filtered = filterOutliers ? tukeyFilter(sorted) : sorted;
  const droppedCount = sorted.length - filtered.length;
  const n = filtered.length;
  if (n === 0) {
    return { p50: NaN, p95: NaN, p99: NaN, mean: NaN, stddev: NaN, n: 0, filtered: droppedCount };
  }
  const mean = filtered.reduce((a, b) => a + b, 0) / n;
  const variance = filtered.reduce((acc, x) => acc + (x - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  return {
    p50: percentile(filtered, 0.50),
    p95: percentile(filtered, 0.95),
    p99: percentile(filtered, 0.99),
    mean,
    stddev,
    n,
    filtered: droppedCount,
  };
}

/**
 * Linear-interpolated percentile (R-7 / numpy default). `q` ∈ [0, 1].
 * Pre-condition: `sorted` is ascending and non-empty.
 */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const rank = q * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Tukey 1.5×IQR fences. Skipped (returns input unchanged) for series
 * with fewer than 4 samples — IQR isn't meaningful below that and
 * dropping points would zero out short bench runs.
 */
function tukeyFilter(sorted: number[]): number[] {
  if (sorted.length < 4) return sorted;
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return sorted.filter((x) => x >= lo && x <= hi);
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '-';
  if (n < 1)   return n.toFixed(3);
  if (n < 100) return n.toFixed(2);
  return n.toFixed(1);
}
