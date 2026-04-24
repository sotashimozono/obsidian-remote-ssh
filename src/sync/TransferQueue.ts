import type { TransferJob } from '../types';
import { TRANSFER_CONCURRENCY } from '../constants';
import { logger } from '../util/logger';
import { withRetry } from '../util/retry';

type Handler = (job: TransferJob) => Promise<void>;

export class TransferQueue {
  private queue: TransferJob[] = [];
  private inFlight: Set<string> = new Set();
  private running = 0;
  private handler: Handler | null = null;

  setHandler(fn: Handler) { this.handler = fn; }

  enqueue(job: TransferJob) {
    // Deduplicate by relativePath — replace existing pending job
    const idx = this.queue.findIndex(j => j.relativePath === job.relativePath);
    if (idx >= 0) {
      this.queue[idx] = job;
    } else {
      this.queue.push(job);
      this.queue.sort((a, b) => b.priority - a.priority);
    }
    this.drain();
  }

  bulkEnqueue(jobs: TransferJob[]) {
    for (const job of jobs) this.enqueue(job);
  }

  private drain() {
    if (!this.handler) return;
    while (this.running < TRANSFER_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (this.inFlight.has(job.relativePath)) {
        // Already in flight — re-queue for after completion
        this.queue.push(job);
        break;
      }
      this.inFlight.add(job.relativePath);
      this.running++;
      this.runJob(job);
    }
  }

  private runJob(job: TransferJob) {
    withRetry(() => this.handler!(job), `transfer(${job.direction}:${job.relativePath})`)
      .catch(err => logger.error(`Transfer failed after retries: ${job.relativePath}: ${err.message}`))
      .finally(() => {
        this.inFlight.delete(job.relativePath);
        this.running--;
        this.drain();
      });
  }

  get pendingCount() { return this.queue.length; }
  get inFlightCount() { return this.running; }
  get isIdle() { return this.queue.length === 0 && this.running === 0; }

  clear() { this.queue = []; }
}
