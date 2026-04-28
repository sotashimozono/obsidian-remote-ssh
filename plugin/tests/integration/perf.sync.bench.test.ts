import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import { perfTracer, type SpanRecord } from '../../src/util/PerfTracer';
import { SftpDataAdapter } from '../../src/adapter/SftpDataAdapter';
import { RpcRemoteFsClient } from '../../src/adapter/RpcRemoteFsClient';
import { ReadCache } from '../../src/cache/ReadCache';
import { DirCache } from '../../src/cache/DirCache';
import { deployTestDaemon, LOCAL_DAEMON_BINARY, type DeployedDaemon } from './helpers/deployDaemonOnce';
import { TEST_PRIVATE_KEY, TEST_VAULT } from './helpers/makeAdapter';
import { buildRpcClient, watchFor, type RpcClientHandle } from './helpers/multiclientRpc';
import { PerfAggregator } from './helpers/perfAggregator';

/**
 * Phase C MVP — sync-latency microbench (M6).
 *
 * Two RPC clients on a shared daemon (writer + reader, the same shape
 * Phase A3's `multiclient.rpc.test.ts` exercises but tuned for
 * percentile collection). For each (op × size) cell we drive N
 * iterations end-to-end:
 *
 *   1. Writer-side `SftpDataAdapter.write*` — emits S.adp + S.rpc
 *      via the M2 instrumentation that's already in production code.
 *   2. Daemon performs the disk write + fsnotify fans the change out
 *      to the reader's fs.watch subscription.
 *   3. Reader-side notification handler — emits T4a (point) + S.app
 *      (manually-wrapped span around a representative
 *      `adapter.stat()` call, mimicking what `applyFsChange` does in
 *      production main.ts but without an Obsidian Vault context).
 *   4. Bench-level wall clock — `performance.now()` around the whole
 *      round-trip records S.e2e directly into the aggregator.
 *
 * Spans flow through `perfTracer.onSpan(...)` into the same
 * `PerfAggregator` instance so the final NDJSON / Markdown table
 * carries p50/p95/p99 for every (span, transport, sizeBytes) tuple
 * across the matrix.
 *
 * Output: `plugin/perf-results/<branch>-<ts>.ndjson` (gitignored), plus
 * a Markdown table printed at end-of-suite for human review.
 *
 * Cross-process cid correlation (M3 daemon-side, plus the eventual
 * TS-side wire-meta send) is NOT exercised here because the bench
 * runs in one Node process and joins spans by time-ordered
 * occurrence; the per-iter cid would only matter if the writer +
 * reader were separate processes / machines. M3 + M9 (multi-process
 * E2E) will cash that in.
 *
 * Skipped automatically when the test keypair or daemon binary isn't
 * present; both come from `npm run sshd:start` + `npm run build:server`.
 */

if (!fs.existsSync(TEST_PRIVATE_KEY)) {
  throw new Error(
    `Integration test keypair missing at ${TEST_PRIVATE_KEY}. ` +
    'Run `npm run sshd:start` from the repo root before `npm run test:integration`.',
  );
}
if (!fs.existsSync(LOCAL_DAEMON_BINARY)) {
  throw new Error(
    `Daemon binary missing at ${LOCAL_DAEMON_BINARY}. ` +
    'Run `npm run build:server` before `npm run test:integration`.',
  );
}

// ── matrix configuration ──────────────────────────────────────────────

const TRANSPORT = 'rpc' as const;

/** Bytes per fixture file. MVP slice: 1KB + 100KB (the two regimes that
 *  separate "RPC overhead dominates" from "wire transfer dominates"). */
const SIZES = [1_024, 100_000] as const;

/**
 * Operations per the plan §C.4 matrix.
 *
 * `modify` is intentionally absent in this MVP: when the cell-level
 * `watchFor` is alive across the pre-create's atomic-write rename,
 * the Linux fsnotify backend in the test container drops the
 * `IN_MOVED_TO` event for the rename's destination — only the tmp
 * file's `created`/`modified`/`deleted` events make it through, and
 * the `awaitNext({path: targetRel})` for the pre-create times out.
 * The other ops are unaffected because `create` writes a
 * never-before-seen path (no pre-create), and `delete`/`rename`
 * accept any event on the target path so the pre-create's `created`
 * event suffices when it does fire — and where it doesn't, the
 * post-pre-create drain (introduced alongside this skip) prevents
 * stale events from false-matching the measured action.
 *
 * A future PR should either re-subscribe per iteration for modify
 * (~50 ms RPC overhead × N iters, but reliably reproduces the
 * "fresh watcher" condition that `multiclient.rpc.test.ts` already
 * passes under) or instrument the bench at the `SftpDataAdapter.write`
 * boundary instead of synchronising on fs.watch notifications.
 */
const OPS = ['create', 'delete', 'rename'] as const;
type Op = typeof OPS[number];

/** Iteration counts per fixture size — the plan's 200/30 schedule. */
function itersFor(sizeBytes: number): number {
  return sizeBytes >= 10 * 1024 * 1024 ? 30 : 200;
}

/** Discarded warm-up iterations per (op × size) cell, to skip JIT /
 *  page-cache cold starts. */
const WARMUP = 10;

/** Per-iter timeout — RPC RTT through Docker on a slow runner. */
const ITER_TIMEOUT_MS = 5_000;

// ── output paths ──────────────────────────────────────────────────────

function branchSlug(): string {
  // Honour CI-injected branch name; fall back to "local" for dev runs.
  const raw = process.env.REMOTE_SSH_PERF_BRANCH || process.env.GITHUB_HEAD_REF || 'local';
  return raw.replace(/[^A-Za-z0-9._-]/g, '_');
}

const RESULTS_DIR = path.resolve(__dirname, '..', '..', 'perf-results');

// ── shared bench state ────────────────────────────────────────────────

describe('perf bench: sync latency (Phase C MVP)', () => {
  let daemon: DeployedDaemon;
  let writer: RpcClientHandle;
  let reader: RpcClientHandle;
  let writerAdapter: SftpDataAdapter;
  let readerAdapter: SftpDataAdapter;

  const aggregator = new PerfAggregator();

  /** Active iteration's size, read by the perfTracer.onSpan listener
   *  to bucket every fired span into the right (size) cell. Updated
   *  before each iteration. */
  let activeSize = 0;

  let unsubscribeSpan: (() => void) | null = null;

  /** Per-suite subdir; isolates this run from other integration tests
   *  and from prior bench runs that may have left files behind. */
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const subdirRel = `perf-bench-${stamp}`;

  beforeAll(async () => {
    perfTracer.clear();
    perfTracer.setEnabled(true);

    daemon = await deployTestDaemon({ label: 'perf-bench' });
    writer = await buildRpcClient(daemon.result.remoteSocketPath, daemon.result.token, 'perf-bench-writer');
    reader = await buildRpcClient(daemon.result.remoteSocketPath, daemon.result.token, 'perf-bench-reader');

    // Wrap each client in a real SftpDataAdapter so M2's S.adp / S.rpc
    // instrumentation fires from production code paths. remoteBasePath
    // is empty so paths stay vault-relative, matching the daemon's
    // contract.
    writerAdapter = new SftpDataAdapter(
      new RpcRemoteFsClient(writer.conn.rpc),
      '',
      new ReadCache({ maxBytes: 64 * 1024 * 1024 }),
      new DirCache(),
      'bench-writer',
    );
    readerAdapter = new SftpDataAdapter(
      new RpcRemoteFsClient(reader.conn.rpc),
      '',
      new ReadCache({ maxBytes: 64 * 1024 * 1024 }),
      new DirCache(),
      'bench-reader',
    );

    await writerAdapter.mkdir(subdirRel);

    // Span sink — every PerfTracer record on either side gets bucketed
    // into the aggregator under the iteration's active size.
    unsubscribeSpan = perfTracer.onSpan((rec: SpanRecord) => {
      aggregator.record(rec.name, TRANSPORT, activeSize, rec.durMs);
    });
  });

  afterAll(async () => {
    unsubscribeSpan?.();
    unsubscribeSpan = null;

    try { await writer.close(); } catch { /* best effort */ }
    try { await reader.close(); } catch { /* best effort */ }
    if (daemon) await daemon.teardown();

    perfTracer.setEnabled(false);
    perfTracer.clear();

    // Persist NDJSON for the M10 CI gate to diff against the
    // perf-baseline branch; print Markdown for immediate human review.
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const outFile = path.join(RESULTS_DIR, `${branchSlug()}-${Date.now()}.ndjson`);
    const ndjson = aggregator.toNDJSON({ filterOutliers: true });
    fs.writeFileSync(outFile, ndjson, 'utf8');

    const md = aggregator.toMarkdownTable({ filterOutliers: true });
    // eslint-disable-next-line no-console
    console.log(`\n[perf bench] ${aggregator.size()} buckets, results: ${outFile}\n${md}\n`);
  });

  // ── matrix ──────────────────────────────────────────────────────────

  for (const size of SIZES) {
    for (const op of OPS) {
      const iters = itersFor(size);
      it(
        `${op} ${humanBytes(size)} (${iters} iters + ${WARMUP} warmup)`,
        async () => {
          activeSize = size;
          const data = makeFixture(size);

          // One watcher for the whole cell; drained after every iter so
          // a stray notification can't leak into the next path.
          const watch = await watchFor(reader, subdirRel);
          try {
            for (let i = 0; i < WARMUP; i++) {
              await runOne(op, data, `${subdirRel}/warmup-${op}-${size}-${i}.bin`, watch);
            }
            for (let i = 0; i < iters; i++) {
              const target = `${subdirRel}/iter-${op}-${size}-${i}.bin`;
              await runOne(op, data, target, watch);
            }
          } finally {
            await watch.cleanup();
          }

          // Sanity: at least one S.e2e sample landed for this cell.
          const stats = aggregator.percentiles('S.e2e', TRANSPORT, size);
          expect(stats?.n ?? 0).toBeGreaterThan(0);
        },
        // Per-test timeout: iters × per-iter budget × 2-margin.
        Math.min(itersFor(size) * ITER_TIMEOUT_MS * 2, 600_000),
      );
    }
  }

  // ── per-iter driver ─────────────────────────────────────────────────

  async function runOne(
    op: Op,
    data: Buffer,
    targetRel: string,
    watch: Awaited<ReturnType<typeof watchFor>>,
  ): Promise<void> {
    // Set up reader-side T4a + S.app capture for this single iteration.
    // Detached from the global notification handler so each iter gets
    // a deterministic single firing — even if the watcher emits extras.
    const e2eAwait = oneShotApply(reader, readerAdapter, watch, op, targetRel);

    switch (op) {
      case 'create': {
        const t0 = performance.now();
        await writerAdapter.writeBinary(targetRel, asArrayBuffer(data));
        await e2eAwait;
        aggregator.record('S.e2e', TRANSPORT, activeSize, performance.now() - t0);
        // Cleanup so the next "create" iter starts from a clean state.
        await writerAdapter.remove(targetRel).catch(() => undefined);
        // Drain any lingering "deleted" notifications.
        await watch.awaitNext((n) => n.path === targetRel && n.event === 'deleted', 1_000).catch(() => undefined);
        break;
      }
      case 'delete': {
        // Pre-create + settle. Don't await the pre-create's fs.changed —
        // the writeBinary RPC promise resolves only after the daemon
        // finishes atomicWriteFile, so the file is on disk by then.
        // Drain so leftover pre-create events don't false-match the
        // measured action's awaitNext.
        await writerAdapter.writeBinary(targetRel, asArrayBuffer(data));
        await settle();
        watch.drain();
        const t0 = performance.now();
        await writerAdapter.remove(targetRel);
        await e2eAwait;
        aggregator.record('S.e2e', TRANSPORT, activeSize, performance.now() - t0);
        break;
      }
      case 'rename': {
        await writerAdapter.writeBinary(targetRel, asArrayBuffer(data));
        await settle();
        watch.drain();
        const newPath = `${targetRel}.renamed`;
        const t0 = performance.now();
        await writerAdapter.rename(targetRel, newPath);
        await e2eAwait;
        aggregator.record('S.e2e', TRANSPORT, activeSize, performance.now() - t0);
        await writerAdapter.remove(newPath).catch(() => undefined);
        await watch.awaitNext((n) => n.path === newPath && n.event === 'deleted', 1_000).catch(() => undefined);
        break;
      }
    }
  }
});

// ── reader-side T4a + S.app simulator ─────────────────────────────────

/**
 * Awaits the *one* fs.changed notification matching the iteration's
 * expected event/path, mimicking the production reader pipeline:
 *
 *   1. Emit T4a point at notification receive time (the same wedge
 *      `main.ts handleFsChanged` instruments in production).
 *   2. Wrap a representative `adapter.stat()` call in an S.app span
 *      (in production main.ts `applyFsChange` does this stat through
 *      the patched adapter; without an Obsidian Vault we just
 *      execute the stat directly).
 *
 * Resolves once both have completed so the bench's S.e2e wall clock
 * captures the full pipeline (write → wire → daemon → fsnotify →
 * reader notify → reader stat).
 */
function oneShotApply(
  reader: RpcClientHandle,
  readerAdapter: SftpDataAdapter,
  watch: Awaited<ReturnType<typeof watchFor>>,
  op: Op,
  targetRel: string,
): Promise<void> {
  return (async () => {
    const expectedEvent = expectedEventFor(op);
    const expectedPath = op === 'rename' ? `${targetRel}.renamed` : targetRel;
    const evt = await watch.awaitNext(
      (n) => matchesIterEvent(n.path, n.event, expectedPath, expectedEvent),
      5_000,
    );

    perfTracer.point('T4a', perfTracer.newCid(), {
      path: evt.path,
      event: evt.event,
      subscriptionId: evt.subscriptionId,
    });

    const __t = perfTracer.begin('S.app');
    try {
      // Production main.ts.applyFsChange does an adapter.stat for
      // created/modified to feed VaultModelBuilder; for delete /
      // rename it skips the stat. Mirror that pattern so the S.app
      // numbers reflect realistic costs.
      if (evt.event === 'created' || evt.event === 'modified') {
        await readerAdapter.stat(evt.path).catch(() => null);
      }
    } finally {
      perfTracer.end(__t, { event: evt.event, path: evt.path });
    }
    void reader;
  })();
}

function expectedEventFor(op: Op): 'created' | 'deleted' {
  switch (op) {
    case 'create': return 'created';
    case 'delete': return 'deleted';
    // rename's IN_MOVED_TO surfaces as `created` on the destination,
    // which is the path the bench moves to (`<targetRel>.renamed`).
    case 'rename': return 'created';
  }
}

function matchesIterEvent(
  gotPath: string,
  gotEvent: string,
  expectedPath: string,
  expectedEvent: ReturnType<typeof expectedEventFor>,
): boolean {
  if (gotPath !== expectedPath) return false;
  return gotEvent === expectedEvent;
}

// ── tiny helpers ──────────────────────────────────────────────────────

/**
 * Brief breath after a setup write so the daemon's atomic-rename
 * notifications flush onto the watcher's queue before the next call
 * to `watch.drain()` clears them. 150 ms is generous enough for the
 * Docker test runner; the bench's per-iter cost is dominated by the
 * RPC RTT (~40 ms p50 in CI) so this isn't a meaningful tax.
 */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 150));
}

function makeFixture(size: number): Buffer {
  // Fill with a non-zero byte so the daemon has something to actually
  // serialise; zeros risk being optimised away on some filesystems.
  return Buffer.alloc(size, 0x61 /* 'a' */);
}

function asArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function humanBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}KB`;
  return `${n}B`;
}

void os; // imported for future use (per-OS conditional skips); silence unused
void TEST_VAULT;
