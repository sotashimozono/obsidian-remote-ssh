import { perfTracer, type SpanRecord } from '../../../src/util/PerfTracer';
import type { FakeFileExplorer, VaultEvent } from '../../helpers/FakeFileExplorer';

/**
 * `assertSyncReflect` — Phase C M8.
 *
 * The single assertion vocabulary used by every M9 E2E case:
 *
 *     1. Subscribe to the perfTracer span stream.
 *     2. Snapshot t0 = performance.now().
 *     3. Run `opts.op()` — the writer-side mutation. The closure
 *        captures whatever clients / adapters it needs (the helper
 *        intentionally doesn't take a Writer parameter — keeps the
 *        helper trivially unit-testable without an SSH session).
 *     4. Await `reader.fakeFE.awaitReflect(...)` — the M7 test
 *        double's history-aware T5 observation point.
 *     5. Compute e2eMs from t0 → reflect.atMs (FakeFileExplorer's
 *        `atMs` captures the `performance.now()` from when the
 *        underlying vault event fired, NOT when the await
 *        registered, so a late-await doesn't inflate the number).
 *     6. Enforce `budgetMs` as the upper bound on e2eMs (the
 *        explicit assertion catches the "reflect arrived but late"
 *        case that awaitReflect's per-call timeout doesn't).
 *     7. Return `{ spans, e2eMs, cid }` for the caller to feed into
 *        PerfAggregator (M4) — every per-iteration assertion
 *        contributes to the same percentile dataset the bench (M6)
 *        already produces, and a future M10 CI gate can compare
 *        against the perf-baseline branch.
 *
 * `cid` is a passthrough for the eventual cross-process correlation
 * (M3 daemon side + future TS wire-meta send). The helper doesn't
 * thread it into perfTracer.begin / point — that's the caller's
 * responsibility — but it echoes it back in the result so the M9
 * test can stitch this assertion's spans to its writer-side spans.
 *
 * Spec deviation from the plan: the plan signature lists `writer:
 * RpcClientHandle` and `reader: { vault: Vault; fakeFE }`. Neither
 * is load-bearing in the helper itself (op() captures the writer;
 * vault is only used by the FakeFileExplorer which the caller has
 * already attached). Dropping them keeps the helper unit-testable
 * without an SSH session or an Obsidian Vault stub. M9 composes the
 * full pipeline at the call site instead.
 */

export interface AssertSyncReflectOpts {
  /**
   * The mutation to perform on the writer side. Returning Promise<void>
   * — the helper measures from before this is called to when the
   * reader-side reflect arrives, so make sure all writer-side work
   * is awaited inside this closure.
   */
  op: () => Promise<void>;

  /**
   * The reader-side observation surface. Only `fakeFE` is needed; a
   * struct keeps the call site self-documenting and leaves room for
   * future fields (e.g. a real Vault when M11/Playwright lands).
   */
  reader: { fakeFE: FakeFileExplorer };

  /** What event/path to wait for on the reader's FakeFileExplorer. */
  expect: { path: string; event: VaultEvent };

  /** Maximum end-to-end latency in milliseconds (op + reflect, t0 → atMs). */
  budgetMs: number;

  /** Optional correlation id; passthrough for the M9 spans + result. */
  cid?: string;

  /** Optional label included in error messages so failures point to the case. */
  label?: string;
}

export interface AssertSyncReflectResult {
  /** Every span fired between t0 and reflect (caller filters as needed). */
  spans: SpanRecord[];
  /** End-to-end latency in milliseconds: reflect.atMs − t0. */
  e2eMs: number;
  /** Echoed back from `opts.cid`, undefined when the caller didn't supply one. */
  cid?: string;
}

export async function assertSyncReflect(opts: AssertSyncReflectOpts): Promise<AssertSyncReflectResult> {
  const captured: SpanRecord[] = [];
  const off = perfTracer.onSpan((s) => captured.push(s));

  const t0 = performance.now();
  try {
    // Run the mutation; if op() throws, surface immediately so the
    // E2E case sees the error rather than a vague "no reflect" timeout.
    try {
      await opts.op();
    } catch (e) {
      throw new Error(
        `${labelPrefix(opts.label)}op() threw before reflect: ${(e as Error).message}`,
      );
    }

    // Wait for the reader-side reflect. awaitReflect's own timeout
    // catches the "no event arrived" case; the explicit budget check
    // below catches the "event arrived but slow" case (op took most of
    // the budget, reflect arrived just inside its per-call window but
    // outside the e2e budget).
    let reflectAtMs: number;
    try {
      const r = await opts.reader.fakeFE.awaitReflect(opts.expect.path, opts.expect.event, opts.budgetMs);
      reflectAtMs = r.atMs;
    } catch (e) {
      throw new Error(
        `${labelPrefix(opts.label)}awaitReflect failed: ${(e as Error).message}`,
      );
    }

    const e2eMs = reflectAtMs - t0;
    if (e2eMs > opts.budgetMs) {
      throw new Error(
        `${labelPrefix(opts.label)}e2eMs ${e2eMs.toFixed(1)} exceeded budget ${opts.budgetMs}ms ` +
        `(op→${opts.expect.event}@"${opts.expect.path}")`,
      );
    }

    return { spans: captured, e2eMs, cid: opts.cid };
  } finally {
    off();
  }
}

function labelPrefix(label: string | undefined): string {
  return label ? `[${label}] ` : '';
}
