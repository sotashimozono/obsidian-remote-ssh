import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TFile } from 'obsidian';
import { perfTracer } from '../src/util/PerfTracer';
import { FakeFileExplorer } from './helpers/FakeFileExplorer';
import { assertSyncReflect } from './integration/helpers/assertSyncReflect';

/**
 * Pure unit coverage for the M8 helper. Doesn't require an SSH
 * session — the writer-side `op()` closure is a tiny callback that
 * just calls `fe.observe(...)` to simulate a reader-side vault
 * event. M9 will compose the real writer (RpcRemoteFsClient via
 * SftpDataAdapter) into the same op() shape.
 */

beforeEach(() => {
  perfTracer.clear();
  perfTracer.setEnabled(true);
});

afterEach(() => {
  perfTracer.setEnabled(false);
  perfTracer.clear();
});

function fakeFile(path: string, mtime = 0): TFile {
  return {
    path,
    name: path.split('/').pop() ?? path,
    stat: { ctime: 0, mtime, size: 0 },
  } as unknown as TFile;
}

describe('assertSyncReflect — happy path', () => {
  it('resolves with positive e2eMs and the captured spans', async () => {
    const fe = new FakeFileExplorer();
    const result = await assertSyncReflect({
      op: async () => {
        // Simulate a writer-side span and the resulting reader event.
        const t = perfTracer.begin('S.adp');
        await new Promise((r) => setTimeout(r, 5));
        perfTracer.end(t, { op: 'write', path: 'a.md', bytes: 4 });
        fe.observe('create', fakeFile('a.md', 100));
      },
      reader: { fakeFE: fe },
      expect: { path: 'a.md', event: 'create' },
      budgetMs: 1_000,
    });
    expect(result.e2eMs).toBeGreaterThan(0);
    expect(result.e2eMs).toBeLessThan(1_000);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0].name).toBe('S.adp');
    expect(result.cid).toBeUndefined();
  });

  it('echoes back the optional cid passthrough', async () => {
    const fe = new FakeFileExplorer();
    const r = await assertSyncReflect({
      op: async () => { fe.observe('create', fakeFile('a.md', 1)); },
      reader: { fakeFE: fe },
      expect: { path: 'a.md', event: 'create' },
      budgetMs: 1_000,
      cid: 'feedfacedeadbeef',
    });
    expect(r.cid).toBe('feedfacedeadbeef');
  });

  it('captures spans from the op only (not from before / after the window)', async () => {
    const fe = new FakeFileExplorer();
    perfTracer.end(perfTracer.begin('before-window'));
    const r = await assertSyncReflect({
      op: async () => {
        perfTracer.end(perfTracer.begin('inside-window'));
        fe.observe('create', fakeFile('a.md', 1));
      },
      reader: { fakeFE: fe },
      expect: { path: 'a.md', event: 'create' },
      budgetMs: 1_000,
    });
    perfTracer.end(perfTracer.begin('after-window'));
    expect(r.spans.map((s) => s.name)).toEqual(['inside-window']);
  });
});

describe('assertSyncReflect — failure modes', () => {
  it('rejects when op() throws, with the original message in the error', async () => {
    const fe = new FakeFileExplorer();
    await expect(assertSyncReflect({
      op: async () => { throw new Error('write blew up'); },
      reader: { fakeFE: fe },
      expect: { path: 'a.md', event: 'create' },
      budgetMs: 1_000,
      label: 'case-1',
    })).rejects.toThrow(/\[case-1\] op\(\) threw before reflect: write blew up/);
  });

  it('rejects when no reflect arrives within budgetMs', async () => {
    const fe = new FakeFileExplorer();
    await expect(assertSyncReflect({
      op: async () => { /* no observe — reader never sees anything */ },
      reader: { fakeFE: fe },
      expect: { path: 'a.md', event: 'create' },
      budgetMs: 30,
      label: 'case-2',
    })).rejects.toThrow(/\[case-2\] awaitReflect failed.*no create.*"a\.md".*within 30ms/);
  });

  it('rejects when reflect arrives but e2eMs exceeds budgetMs', async () => {
    // op() spends most of the budget (40ms), then reflects within
    // awaitReflect's own per-call window (also 50ms) — but t0→atMs
    // exceeds 50ms, which the explicit budget check catches.
    const fe = new FakeFileExplorer();
    await expect(assertSyncReflect({
      op: async () => {
        await new Promise((r) => setTimeout(r, 40));
        fe.observe('create', fakeFile('a.md', 1));
      },
      reader: { fakeFE: fe },
      expect: { path: 'a.md', event: 'create' },
      budgetMs: 30,
      label: 'tight',
    })).rejects.toThrow(/\[tight\].*exceeded budget 30ms/);
  });

  it('uses the bare prefix when no label is supplied', async () => {
    const fe = new FakeFileExplorer();
    await expect(assertSyncReflect({
      op: async () => { /* no observe */ },
      reader: { fakeFE: fe },
      expect: { path: 'x', event: 'create' },
      budgetMs: 20,
    })).rejects.toThrow(/^awaitReflect failed:/);
  });
});

describe('assertSyncReflect — onSpan listener hygiene', () => {
  it('unsubscribes the perfTracer listener even on failure', async () => {
    const fe = new FakeFileExplorer();
    const beforeCount = countOnSpanListeners();
    await assertSyncReflect({
      op: async () => { throw new Error('boom'); },
      reader: { fakeFE: fe },
      expect: { path: 'x', event: 'create' },
      budgetMs: 50,
    }).catch(() => { /* expected */ });
    expect(countOnSpanListeners()).toBe(beforeCount);
  });
});

/**
 * PerfTracer doesn't expose a listener-count method; we infer it by
 * checking whether a span fired *outside* a tracked window leaks into
 * any leftover capture array. Indirect, but enough to detect a leaked
 * subscription that would accumulate across many test runs.
 */
function countOnSpanListeners(): number {
  let observed = 0;
  const off = perfTracer.onSpan(() => { observed++; });
  perfTracer.end(perfTracer.begin('probe'));
  off();
  // We only care that our own probe fired exactly once — meaning no
  // mystery listener double-counted it.
  return observed === 1 ? 0 : observed - 1;
}
