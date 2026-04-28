import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { OfflineQueue, type QueuedOp } from '../src/offline/OfflineQueue';

async function tempDir(label: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `remote-ssh-queue-${label}-`));
}

function textWrite(file: string, content: string): QueuedOp {
  return {
    kind: 'write',
    path: file,
    contentBase64: Buffer.from(content, 'utf8').toString('base64'),
  };
}

describe('OfflineQueue', () => {
  // ─── basic round-trip ───────────────────────────────────────────────────

  it('starts empty', async () => {
    const q = await OfflineQueue.open(await tempDir('empty'));
    expect(q.pending()).toEqual([]);
    expect(q.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it('enqueue assigns increasing ids and exposes the op', async () => {
    const q = await OfflineQueue.open(await tempDir('enqueue'));
    const id1 = await q.enqueue(textWrite('a.md', 'hi'));
    const id2 = await q.enqueue(textWrite('b.md', 'bye'));
    expect(id2).toBeGreaterThan(id1);
    const pending = q.pending();
    expect(pending).toHaveLength(2);
    expect(pending[0].id).toBe(id1);
    expect(pending[1].id).toBe(id2);
    expect(pending[0].op.kind).toBe('write');
    expect((pending[0].op as { path: string }).path).toBe('a.md');
  });

  it('markCompleted removes the entry from pending', async () => {
    const q = await OfflineQueue.open(await tempDir('mark'));
    const id1 = await q.enqueue(textWrite('a.md', 'hi'));
    const id2 = await q.enqueue(textWrite('b.md', 'bye'));
    await q.markCompleted(id1);
    const remaining = q.pending();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(id2);
  });

  it('markCompleted of an unknown id is a no-op', async () => {
    const q = await OfflineQueue.open(await tempDir('mark-unknown'));
    await q.enqueue(textWrite('a.md', 'hi'));
    await q.markCompleted(99999);
    expect(q.pending()).toHaveLength(1);
  });

  // ─── persistence across instances ───────────────────────────────────────

  it('persists pending entries across reopen', async () => {
    const dir = await tempDir('persist');
    const q1 = await OfflineQueue.open(dir);
    await q1.enqueue(textWrite('a.md', 'first'));
    await q1.enqueue(textWrite('b.md', 'second'));

    const q2 = await OfflineQueue.open(dir);
    const pending = q2.pending();
    expect(pending.map(e => (e.op as { path: string }).path)).toEqual(['a.md', 'b.md']);
  });

  it('replays past completions on reopen so already-drained ops do not resurface', async () => {
    const dir = await tempDir('persist-completed');
    const q1 = await OfflineQueue.open(dir);
    const id1 = await q1.enqueue(textWrite('a.md', 'first'));
    await q1.enqueue(textWrite('b.md', 'second'));
    await q1.markCompleted(id1);

    const q2 = await OfflineQueue.open(dir);
    const pending = q2.pending();
    expect(pending).toHaveLength(1);
    expect((pending[0].op as { path: string }).path).toBe('b.md');
  });

  it('preserves the monotonic id stream across reopen', async () => {
    const dir = await tempDir('id-stream');
    const q1 = await OfflineQueue.open(dir);
    const ids = [
      await q1.enqueue(textWrite('a.md', '1')),
      await q1.enqueue(textWrite('b.md', '2')),
      await q1.enqueue(textWrite('c.md', '3')),
    ];
    const q2 = await OfflineQueue.open(dir);
    const next = await q2.enqueue(textWrite('d.md', '4'));
    expect(next).toBeGreaterThan(Math.max(...ids));
  });

  // ─── compaction ─────────────────────────────────────────────────────────

  it('compaction shrinks the on-disk log after enough completions', async () => {
    const dir = await tempDir('compact');
    const q = await OfflineQueue.open(dir);
    // Push enough payload that the log gets fat, then complete most
    // of them so the slack triggers a rewrite.
    const big = 'x'.repeat(2000);
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await q.enqueue(textWrite(`note-${i}.md`, big)));
    }
    const before = q.stats();
    for (let i = 0; i < 5; i++) {
      await q.markCompleted(ids[i]);
    }
    const after = q.stats();
    // Compaction is triggered by the last markCompleted; after, the
    // log file should be ~ a single op's worth, much less than before.
    expect(after.entries).toBe(1);
    expect(after.logFileBytes).toBeLessThan(before.logFileBytes);
  });

  it('clear() drops every entry and writes an empty log', async () => {
    const dir = await tempDir('clear');
    const q = await OfflineQueue.open(dir);
    await q.enqueue(textWrite('a.md', 'one'));
    await q.enqueue(textWrite('b.md', 'two'));
    await q.clear();
    expect(q.pending()).toEqual([]);
    expect(q.stats().bytes).toBe(0);

    const reopened = await OfflineQueue.open(dir);
    expect(reopened.pending()).toEqual([]);
  });

  // ─── cap enforcement ────────────────────────────────────────────────────

  it('rejects an enqueue that would exceed the byte cap', async () => {
    const dir = await tempDir('cap');
    // Cap chosen so a small write fits but a 4 KB payload doesn't.
    const q = await OfflineQueue.open(dir, { maxBytes: 1000 });
    const ok = textWrite('small.md', 'x'.repeat(20));
    await q.enqueue(ok);
    const big = textWrite('big.md', 'x'.repeat(4000));
    await expect(q.enqueue(big)).rejects.toThrow(/exceed cap/);
    // The rejected enqueue must NOT consume an id slot or appear in pending.
    const pending = q.pending();
    expect(pending).toHaveLength(1);
    // Next enqueue should still get a small id (no gap from the rejected one).
    const next = await q.enqueue(textWrite('next.md', 'tiny'));
    expect(next).toBe(pending[0].id + 1);
  });

  // ─── malformed-line tolerance ───────────────────────────────────────────

  it('skips malformed lines in the log on reopen rather than failing to load', async () => {
    const dir = await tempDir('malformed');
    const q1 = await OfflineQueue.open(dir);
    await q1.enqueue(textWrite('good.md', 'ok'));

    // Append some garbage and a partially-broken record.
    const logPath = path.join(dir, 'log.jsonl');
    await fs.appendFile(logPath, 'not-json\n{"type":"unknown"}\n', 'utf8');
    await q1.enqueue(textWrite('also-good.md', 'ok2'));

    const q2 = await OfflineQueue.open(dir);
    const pending = q2.pending();
    expect(pending.map(e => (e.op as { path: string }).path)).toEqual(['good.md', 'also-good.md']);
  });

  // ─── all op kinds ───────────────────────────────────────────────────────

  it('persists every supported op kind verbatim', async () => {
    const dir = await tempDir('kinds');
    const q = await OfflineQueue.open(dir);
    const ops: QueuedOp[] = [
      { kind: 'write',        path: 'a.md', contentBase64: 'YQ==' },
      { kind: 'writeBinary',  path: 'a.bin', contentBase64: 'YQ==' },
      { kind: 'append',       path: 'a.md', contentBase64: 'YQ==' },
      { kind: 'appendBinary', path: 'a.bin', contentBase64: 'YQ==' },
      { kind: 'mkdir',        path: 'sub' },
      { kind: 'remove',       path: 'a.md' },
      { kind: 'rmdir',        path: 'sub', recursive: true },
      { kind: 'rename',       oldPath: 'a.md', newPath: 'b.md' },
      { kind: 'copy',         srcPath: 'a.md', dstPath: 'b.md' },
      { kind: 'trashLocal',   path: 'a.md' },
    ];
    for (const op of ops) await q.enqueue(op);

    const reopened = await OfflineQueue.open(dir);
    const got = reopened.pending().map(e => e.op);
    expect(got).toEqual(ops);
  });
});
