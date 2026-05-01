import type { OfflineQueue, QueuedOp } from './OfflineQueue';
import { logger } from '../util/logger';
import { errorMessage } from "../util/errorMessage";

/**
 * Slim adapter surface the replayer drives. Matches
 * `SftpDataAdapter.replayQueuedOp` so a fake adapter (test fixture)
 * can satisfy the same contract.
 */
export interface ReplayTarget {
  replayQueuedOp(op: QueuedOp): Promise<
    | { result: 'ok' }
    | { result: 'conflict' }
    | { result: 'error'; message: string }
  >;
}

export interface ReplayReport {
  /** Ops that landed cleanly (or whose conflict modal returned a definitive resolution). */
  drained: number;
  /** Ops the user resolved by picking `keep-theirs` / cancelling — counted as user-decided. */
  conflicts: number;
  /** Ops that errored; queue entry stays pending for the next reconnect to retry. */
  errors: Array<{ id: number; message: string }>;
}

/**
 * Drains an `OfflineQueue` against a connected adapter once an SSH
 * session has recovered. One-shot: instantiate, call `run()`, throw
 * away.
 *
 * Behaviour:
 *
 * - Replays oldest-first so a chain of edits to the same file lands
 *   in the order the user typed them.
 * - On a successful op (`ok`) or a user-resolved conflict
 *   (`conflict`), marks the queue entry completed and continues.
 * - On a transport error (`error`), logs and STOPS so the next
 *   reconnect retries from the same entry. We could choose to
 *   continue with later entries, but the user's mental model is
 *   "edits land in order" and skipping risks a write on a path that
 *   depends on an earlier rename / mkdir.
 */
export class QueueReplayer {
  constructor(
    private readonly queue: OfflineQueue,
    private readonly target: ReplayTarget,
  ) {}

  async run(): Promise<ReplayReport> {
    const report: ReplayReport = { drained: 0, conflicts: 0, errors: [] };
    const initialPending = this.queue.pending();
    if (initialPending.length === 0) return report;

    logger.info(`QueueReplayer: draining ${initialPending.length} pending entries`);

    for (const entry of initialPending) {
      let outcome;
      try {
        outcome = await this.target.replayQueuedOp(entry.op);
      } catch (e) {
        // The target should never throw — `replayQueuedOp` returns
        // a discriminated outcome — but if a fake's behaviour
        // diverges, surface it as an error rather than crashing the
        // whole drain.
        const message = errorMessage(e);
        report.errors.push({ id: entry.id, message });
        logger.error(`QueueReplayer: target threw on entry #${entry.id} (${entry.op.kind}): ${message}`);
        break;
      }

      if (outcome.result === 'ok') {
        await this.queue.markCompleted(entry.id);
        report.drained++;
        continue;
      }

      if (outcome.result === 'conflict') {
        // The user chose `keep-theirs` or cancelled the modal. Either
        // way the op is decided; mark complete so we don't re-prompt
        // on the next reconnect.
        await this.queue.markCompleted(entry.id);
        report.conflicts++;
        continue;
      }

      // outcome.result === 'error'
      report.errors.push({ id: entry.id, message: outcome.message });
      logger.warn(
        `QueueReplayer: entry #${entry.id} (${entry.op.kind}) failed: ${outcome.message}; ` +
        'leaving it queued for the next reconnect',
      );
      break;
    }

    logger.info(
      `QueueReplayer: drain complete — drained=${report.drained}, conflicts=${report.conflicts}, ` +
      `errors=${report.errors.length}, remaining=${this.queue.pending().length}`,
    );
    return report;
  }
}
