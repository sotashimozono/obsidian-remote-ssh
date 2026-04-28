/**
 * One contiguous run of same-kind lines in a diff. Adjacent ops of
 * different kinds are produced by `diffLines`; the consumer (the
 * 3-way merge UI) renders each chunk as a styled block.
 */
export interface DiffChunk {
  /** `eq` = unchanged, `add` = present in `b` but not `a`, `del` = present in `a` but not `b`. */
  kind: 'eq' | 'add' | 'del';
  /** Lines that make up this chunk, in source order. */
  lines: string[];
}

/**
 * Line-level diff of two strings. Powers the 3-way merge modal:
 * the modal shows three panes (ancestor / mine / theirs) with
 * `add` lines highlighted as additions and `del` lines as deletions
 * relative to the ancestor.
 *
 * Implementation: Longest Common Subsequence via DP, then
 * backtrack. O(N·M) time and memory where N, M are line counts.
 * Plain notes are typically a few hundred lines so this stays well
 * under a millisecond; for ten-thousand-line files it'd start to
 * cost real CPU. We accept that — if we ever ship to users with
 * gigantic notes the algorithm can be swapped for Myers.
 *
 * Empty inputs: an empty string is treated as zero lines (rather
 * than one empty line), so `diff('', '') === []` and
 * `diff('', 'x')` is a single `add` chunk with one line.
 */
export function diffLines(a: string, b: string): DiffChunk[] {
  const aLines = a === '' ? [] : a.split('\n');
  const bLines = b === '' ? [] : b.split('\n');
  return mergeAdjacent(lcsBacktrack(aLines, bLines));
}

// ─── internals ────────────────────────────────────────────────────────────

interface RawOp {
  kind: 'eq' | 'add' | 'del';
  line: string;
}

function lcsBacktrack(a: string[], b: string[]): RawOp[] {
  const N = a.length;
  const M = b.length;
  if (N === 0 && M === 0) return [];
  if (N === 0) return b.map<RawOp>(line => ({ kind: 'add', line }));
  if (M === 0) return a.map<RawOp>(line => ({ kind: 'del', line }));

  // dp[i * (M+1) + j] = length of the LCS of a[0..i) and b[0..j).
  // Flat Int32Array for locality + fast indexing on big inputs.
  const stride = M + 1;
  const dp = new Int32Array((N + 1) * stride);
  for (let i = 1; i <= N; i++) {
    const row = i * stride;
    const prev = (i - 1) * stride;
    const ai = a[i - 1];
    for (let j = 1; j <= M; j++) {
      if (ai === b[j - 1]) {
        dp[row + j] = dp[prev + (j - 1)] + 1;
      } else {
        const fromTop = dp[prev + j];
        const fromLeft = dp[row + (j - 1)];
        dp[row + j] = fromTop >= fromLeft ? fromTop : fromLeft;
      }
    }
  }

  const ops: RawOp[] = [];
  let i = N;
  let j = M;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ kind: 'eq', line: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i * stride + (j - 1)] >= dp[(i - 1) * stride + j])) {
      ops.push({ kind: 'add', line: b[j - 1] });
      j--;
    } else {
      ops.push({ kind: 'del', line: a[i - 1] });
      i--;
    }
  }
  ops.reverse();
  return ops;
}

function mergeAdjacent(ops: RawOp[]): DiffChunk[] {
  if (ops.length === 0) return [];
  const out: DiffChunk[] = [];
  let cur: DiffChunk = { kind: ops[0].kind, lines: [ops[0].line] };
  for (let i = 1; i < ops.length; i++) {
    if (ops[i].kind === cur.kind) {
      cur.lines.push(ops[i].line);
    } else {
      out.push(cur);
      cur = { kind: ops[i].kind, lines: [ops[i].line] };
    }
  }
  out.push(cur);
  return out;
}
