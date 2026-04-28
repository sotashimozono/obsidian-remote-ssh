import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { OfflineQueue, type QueuedOp } from '../src/offline/OfflineQueue';
import { QueueReplayer, type ReplayTarget } from '../src/offline/QueueReplayer';

async function tempQueue(label: string, ops: QueuedOp[] = []): Promise<OfflineQueue> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `remote-ssh-replayer-${label}-`));
  const q = await OfflineQueue.open(dir);
  for (const op of ops) await q.enqueue(op);
  return q;
}

function textWrite(p: string, content: string): QueuedOp {
  return { kind: 'write', path: p, contentBase64: Buffer.from(content, 'utf8').toString('base64') };
}

function makeTarget(answers: Array<Awaited<ReturnType<ReplayTarget['replayQueuedOp']>>>): {
  target: ReplayTarget;
  calls: QueuedOp[];
} {
  const calls: QueuedOp[] = [];
  let i = 0;
  return {
    calls,
    target: {
      async replayQueuedOp(op) {
        calls.push(op);
        if (i >= answers.length) {
          throw new Error(`fake target: no more answers programmed (call #${i + 1})`);
        }
        return answers[i++];
      },
    },
  };
}

describe('QueueReplayer', () => {
  // ─── happy paths ────────────────────────────────────────────────────────

  it('drains an empty queue without calling the target', async () => {
    const q = await tempQueue('empty');
    const { target, calls } = makeTarget([]);
    const report = await new QueueReplayer(q, target).run();
    expect(report).toEqual({ drained: 0, conflicts: 0, errors: [] });
    expect(calls).toHaveLength(0);
  });

  it('drains a 3-entry queue oldest-first when every op succeeds', async () => {
    const q = await tempQueue('happy', [
      textWrite('a.md', 'one'),
      textWrite('b.md', 'two'),
      textWrite('c.md', 'three'),
    ]);
    const { target, calls } = makeTarget([
      { result: 'ok' }, { result: 'ok' }, { result: 'ok' },
    ]);
    const report = await new QueueReplayer(q, target).run();
    expect(report.drained).toBe(3);
    expect(report.conflicts).toBe(0);
    expect(report.errors).toEqual([]);
    expect(calls.map(o => (o as { path: string }).path)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(q.pending()).toEqual([]);
  });

  // ─── conflict counts as decided, not queued ─────────────────────────────

  it('marks conflict-resolved entries completed (does not re-enqueue)', async () => {
    const q = await tempQueue('conflict', [
      textWrite('a.md', 'one'),
      textWrite('b.md', 'two'),
    ]);
    const { target } = makeTarget([
      { result: 'conflict' }, // user picked keep-theirs
      { result: 'ok' },
    ]);
    const report = await new QueueReplayer(q, target).run();
    expect(report.drained).toBe(1);
    expect(report.conflicts).toBe(1);
    expect(q.pending()).toEqual([]);
  });

  // ─── error stops the drain ──────────────────────────────────────────────

  it('stops on the first error and leaves later entries queued for next reconnect', async () => {
    const q = await tempQueue('error', [
      textWrite('a.md', 'one'),
      textWrite('b.md', 'two'),
      textWrite('c.md', 'three'),
    ]);
    const { target, calls } = makeTarget([
      { result: 'ok' },
      { result: 'error', message: 'connection reset' },
      { result: 'ok' }, // never reached
    ]);
    const report = await new QueueReplayer(q, target).run();
    expect(report.drained).toBe(1);
    expect(report.errors).toEqual([{ id: expect.any(Number), message: 'connection reset' }]);
    expect(calls).toHaveLength(2); // 'c.md' never attempted
    const remaining = q.pending().map(e => (e.op as { path: string }).path);
    expect(remaining).toEqual(['b.md', 'c.md']);
  });

  // ─── target throw treated as error ──────────────────────────────────────

  it('treats a thrown target as an error and stops', async () => {
    const q = await tempQueue('throw', [
      textWrite('a.md', 'one'),
      textWrite('b.md', 'two'),
    ]);
    const target: ReplayTarget = {
      async replayQueuedOp() { throw new Error('disk fire'); },
    };
    const report = await new QueueReplayer(q, target).run();
    expect(report.errors).toEqual([{ id: expect.any(Number), message: 'disk fire' }]);
    expect(report.drained).toBe(0);
    expect(q.pending()).toHaveLength(2);
  });

  // ─── partial drain across reconnects ────────────────────────────────────

  it('next reconnect resumes from the entry that errored', async () => {
    const q = await tempQueue('resume', [
      textWrite('a.md', 'one'),
      textWrite('b.md', 'two'),
      textWrite('c.md', 'three'),
    ]);
    // First attempt: 'a' ok, 'b' errors → stop.
    const first = makeTarget([
      { result: 'ok' },
      { result: 'error', message: 'transient' },
    ]);
    const r1 = await new QueueReplayer(q, first.target).run();
    expect(r1.drained).toBe(1);
    expect(q.pending()).toHaveLength(2);

    // Second attempt: 'b' ok, 'c' ok.
    const second = makeTarget([{ result: 'ok' }, { result: 'ok' }]);
    const r2 = await new QueueReplayer(q, second.target).run();
    expect(r2.drained).toBe(2);
    expect(q.pending()).toEqual([]);
    expect(second.calls.map(o => (o as { path: string }).path)).toEqual(['b.md', 'c.md']);
  });

  // ─── op dispatching is left to the target ───────────────────────────────

  it('passes every op kind through verbatim to the target', async () => {
    const allKinds: QueuedOp[] = [
      { kind: 'write',        path: 'a',  contentBase64: 'YQ==' },
      { kind: 'writeBinary',  path: 'b',  contentBase64: 'Yg==' },
      { kind: 'append',       path: 'c',  contentBase64: 'Yw==' },
      { kind: 'appendBinary', path: 'd',  contentBase64: 'ZA==' },
      { kind: 'mkdir',        path: 'e' },
      { kind: 'remove',       path: 'f' },
      { kind: 'rmdir',        path: 'g',  recursive: false },
      { kind: 'rename',       oldPath: 'h', newPath: 'i' },
      { kind: 'copy',         srcPath: 'j', dstPath: 'k' },
      { kind: 'trashLocal',   path: 'l' },
    ];
    const q = await tempQueue('kinds', allKinds);
    const { target, calls } = makeTarget(allKinds.map(() => ({ result: 'ok' as const })));
    await new QueueReplayer(q, target).run();
    expect(calls).toEqual(allKinds);
  });
});
