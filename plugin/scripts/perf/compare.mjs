// Pure comparison logic for the Phase C M10 perf gate.
// Reads two NDJSON datasets (baseline + head), joins by the bench
// matrix tuple `(span, transport, sizeBytes)`, computes deltas, and
// returns a structured result the CLI wrapper formats as Markdown
// for `gh pr comment`. Kept pure / dependency-free so the unit
// suite can exercise it without spawning a workflow.

/**
 * @typedef {object} PerfRecord
 * @property {string} span        - 'S.adp' | 'S.rpc' | 'S.app' | 'S.e2e' | …
 * @property {string} transport   - 'rpc' | 'sftp'
 * @property {number} sizeBytes
 * @property {number} p50
 * @property {number} p95
 * @property {number} p99
 * @property {number} mean
 * @property {number} stddev
 * @property {number} n
 * @property {number} [filtered]
 */

/**
 * @typedef {object} Tolerances
 * @property {{p95Tolerance: number}}                     default
 * @property {Record<string, {p95Tolerance: number}>}    [byName]
 */

/**
 * @typedef {object} ComparisonRow
 * @property {string}          span
 * @property {string}          transport
 * @property {number}          sizeBytes
 * @property {PerfRecord|null} base
 * @property {PerfRecord|null} head
 * @property {number|null}     p95DeltaMs
 * @property {number|null}     p95DeltaPct        - null when base p95 is 0 / NaN / missing
 * @property {'regressed'|'improved'|'unchanged'|'new'|'removed'} status
 * @property {number}          tolerancePct       - the p95 tolerance applied to this row
 */

const DEFAULT_TOLERANCES = Object.freeze({
  default: { p95Tolerance: 0.25 },
  byName: {
    // Disk-write variance on shared CI disks is high; let it breathe.
    'S.fs':   { p95Tolerance: 0.40 },
    // fsnotify debounce is timing-sensitive on a loaded runner.
    'S.note': { p95Tolerance: 0.50 },
  },
});

const UNCHANGED_BAND_PCT = 0.05; // ±5 % is "unchanged" so noise doesn't paint everything red

/**
 * Parse one NDJSON document into an array of PerfRecords. Tolerates
 * blank lines and ignores unknown fields. Throws on the first
 * malformed JSON line so a corrupt baseline doesn't silently degrade
 * the gate to "no diffs".
 *
 * @param {string} text
 * @returns {PerfRecord[]}
 */
export function parseNDJSON(text) {
  /** @type {PerfRecord[]} */
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new Error(`compare: NDJSON parse error at line ${i + 1}: ${e.message}`);
    }
    if (!isPerfRecord(obj)) {
      throw new Error(`compare: NDJSON line ${i + 1} is not a PerfRecord (got keys ${Object.keys(obj).join(',')})`);
    }
    out.push(obj);
  }
  return out;
}

function isPerfRecord(o) {
  return o
    && typeof o === 'object'
    && typeof o.span === 'string'
    && typeof o.transport === 'string'
    && typeof o.sizeBytes === 'number'
    && typeof o.p95 === 'number';
}

/**
 * Compare two datasets bucket-by-bucket. Buckets present in head but
 * not baseline are status='new' (no baseline to compare against);
 * buckets in baseline but not head are status='removed'.
 *
 * @param {PerfRecord[]} baseline
 * @param {PerfRecord[]} head
 * @param {Tolerances} [tolerances=DEFAULT_TOLERANCES]
 * @returns {{ rows: ComparisonRow[], regressions: ComparisonRow[] }}
 */
export function compare(baseline, head, tolerances = DEFAULT_TOLERANCES) {
  const baseByKey = indexByKey(baseline);
  const headByKey = indexByKey(head);

  /** @type {ComparisonRow[]} */
  const rows = [];
  const seenKeys = new Set();

  for (const [key, h] of headByKey.entries()) {
    seenKeys.add(key);
    const b = baseByKey.get(key) ?? null;
    rows.push(makeRow(h.span, h.transport, h.sizeBytes, b, h, tolerances));
  }
  for (const [key, b] of baseByKey.entries()) {
    if (seenKeys.has(key)) continue;
    rows.push(makeRow(b.span, b.transport, b.sizeBytes, b, null, tolerances));
  }

  // Sort: regressions first, then improvements, then unchanged/new/removed,
  // each group ordered by (span, transport, sizeBytes) for determinism.
  const statusOrder = { regressed: 0, improved: 1, unchanged: 2, new: 3, removed: 4 };
  rows.sort((a, b) => {
    const s = statusOrder[a.status] - statusOrder[b.status];
    if (s !== 0) return s;
    if (a.span !== b.span) return a.span < b.span ? -1 : 1;
    if (a.transport !== b.transport) return a.transport < b.transport ? -1 : 1;
    return a.sizeBytes - b.sizeBytes;
  });

  const regressions = rows.filter((r) => r.status === 'regressed');
  return { rows, regressions };
}

function indexByKey(records) {
  const m = new Map();
  for (const r of records) m.set(`${r.span}|${r.transport}|${r.sizeBytes}`, r);
  return m;
}

function makeRow(span, transport, sizeBytes, base, head, tolerances) {
  const tolerancePct = toleranceFor(span, tolerances);
  if (!base && head)  return { span, transport, sizeBytes, base: null, head, p95DeltaMs: null, p95DeltaPct: null, status: 'new', tolerancePct };
  if (base && !head)  return { span, transport, sizeBytes, base, head: null, p95DeltaMs: null, p95DeltaPct: null, status: 'removed', tolerancePct };
  // Both present.
  const p95DeltaMs = head.p95 - base.p95;
  /** @type {number|null} */
  const p95DeltaPct = base.p95 > 0 && Number.isFinite(base.p95) ? p95DeltaMs / base.p95 : null;
  let status;
  if (p95DeltaPct === null)            status = 'new';     // can't compute relative — treat as new
  else if (p95DeltaPct > tolerancePct) status = 'regressed';
  else if (p95DeltaPct < -UNCHANGED_BAND_PCT) status = 'improved';
  else if (Math.abs(p95DeltaPct) <= UNCHANGED_BAND_PCT) status = 'unchanged';
  else status = 'unchanged'; // small positive within tolerance band
  return { span, transport, sizeBytes, base, head, p95DeltaMs, p95DeltaPct, status, tolerancePct };
}

function toleranceFor(span, tolerances) {
  return tolerances.byName?.[span]?.p95Tolerance ?? tolerances.default.p95Tolerance;
}

/**
 * Render the rows as a single Markdown comment body suitable for
 * `gh pr comment`. Status arrows + bolding mark regressions; a
 * trailing summary line states pass/fail and the gate threshold.
 *
 * @param {ComparisonRow[]} rows
 * @param {{ commitSha?: string, baselineSha?: string, runUrl?: string, gateEnabled?: boolean }} [meta]
 * @returns {string}
 */
export function formatMarkdown(rows, meta = {}) {
  const header = '## Phase C perf-bench diff';
  if (rows.length === 0) {
    return `${header}\n\n_No bench buckets in either head or baseline — nothing to compare._\n${footerLines(meta, 0)}`;
  }
  const lines = [
    header,
    '',
    '| span | transport | size | base p95 (ms) | head p95 (ms) | Δ ms | Δ % | tol % | status |',
    '|------|-----------|-----:|---------------:|---------------:|-----:|----:|------:|--------|',
  ];
  for (const r of rows) {
    lines.push(formatRow(r));
  }
  const regressed = rows.filter((r) => r.status === 'regressed').length;
  lines.push('');
  if (regressed === 0) {
    lines.push(`✅ no regressions over per-span p95 tolerance.`);
  } else {
    lines.push(`❌ **${regressed} bucket(s) regressed past their p95 tolerance.**`);
  }
  return lines.concat(footerLines(meta, regressed)).join('\n');
}

function formatRow(r) {
  const sym = { regressed: '🔴 ↑', improved: '🟢 ↓', unchanged: '−', new: '🆕', removed: '➖' }[r.status];
  const cells = [
    r.span,
    r.transport,
    humanBytes(r.sizeBytes),
    r.base ? fmt(r.base.p95) : '—',
    r.head ? fmt(r.head.p95) : '—',
    r.p95DeltaMs !== null ? signed(r.p95DeltaMs) : '—',
    r.p95DeltaPct !== null ? signedPct(r.p95DeltaPct) : '—',
    `${(r.tolerancePct * 100).toFixed(0)}%`,
    sym,
  ];
  if (r.status === 'regressed') {
    return `| **${cells.join('** | **')}** |`;
  }
  return `| ${cells.join(' | ')} |`;
}

function footerLines(meta, regressedCount) {
  const out = [''];
  if (meta.baselineSha || meta.commitSha) {
    out.push(
      `_baseline @ \`${shortSha(meta.baselineSha)}\` → head @ \`${shortSha(meta.commitSha)}\`_`,
    );
  }
  if (meta.runUrl) {
    out.push(`_[view CI run](${meta.runUrl})_`);
  }
  if (regressedCount > 0 && meta.gateEnabled) {
    out.push('');
    out.push(`_Gate is **enabled**; this run will fail. Set \`PERF_GATE=0\` in the workflow env to make it informational._`);
  }
  return out;
}

function shortSha(s) {
  if (!s) return 'unknown';
  return s.slice(0, 7);
}
function signed(n) {
  return (n > 0 ? '+' : '') + n.toFixed(2);
}
function signedPct(n) {
  return (n > 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
}
function humanBytes(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}KB`;
  return `${n}B`;
}
function fmt(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1)   return n.toFixed(3);
  if (n < 100) return n.toFixed(2);
  return n.toFixed(1);
}

export { DEFAULT_TOLERANCES, UNCHANGED_BAND_PCT };
