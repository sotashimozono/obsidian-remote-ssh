import { describe, it, expect } from 'vitest';
import type { EventRef, TAbstractFile, TFile } from 'obsidian';
import { FakeFileExplorer, type VaultLike } from './helpers/FakeFileExplorer';

// ── tiny FakeVault: enough surface for FakeFileExplorer.attach ──────────

interface Ref { name: string; cb: (...args: unknown[]) => void }

class FakeVault implements VaultLike {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private readonly refs = new Map<symbol, Ref>();

  on(name: string, cb: (...args: unknown[]) => unknown): EventRef {
    const set = this.listeners.get(name) ?? new Set();
    set.add(cb as (...args: unknown[]) => void);
    this.listeners.set(name, set);
    const sym = Symbol(name);
    this.refs.set(sym, { name, cb: cb as (...args: unknown[]) => void });
    return sym as unknown as EventRef;
  }

  offref(ref: EventRef): void {
    const sym = ref as unknown as symbol;
    const r = this.refs.get(sym);
    if (!r) return;
    this.listeners.get(r.name)?.delete(r.cb);
    this.refs.delete(sym);
  }

  trigger(name: string, ...args: unknown[]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const cb of [...set]) cb(...args);
  }

  listenerCount(name: string): number {
    return this.listeners.get(name)?.size ?? 0;
  }
}

function fakeFile(path: string, mtime = 0): TFile {
  // Cast through unknown — we only need the structural fields the
  // FakeFileExplorer reads (`path`, `stat?.mtime`).
  return {
    path,
    name: basename(path),
    stat: { ctime: 0, mtime, size: 0 },
  } as unknown as TFile;
}

function fakeFolder(path: string): TAbstractFile {
  return {
    path,
    name: basename(path),
  } as unknown as TAbstractFile;
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

// ── observe(): direct event injection ───────────────────────────────────

describe('FakeFileExplorer — observe / snapshot', () => {
  it('starts empty', () => {
    const fe = new FakeFileExplorer();
    expect(fe.snapshot()).toEqual({ paths: [], mtimes: {} });
  });

  it('create adds path and records mtime when present', () => {
    const fe = new FakeFileExplorer();
    fe.observe('create', fakeFile('a.md', 100));
    expect(fe.snapshot()).toEqual({ paths: ['a.md'], mtimes: { 'a.md': 100 } });
  });

  it('create on a folder records the path with no mtime', () => {
    const fe = new FakeFileExplorer();
    fe.observe('create', fakeFolder('docs'));
    expect(fe.snapshot()).toEqual({ paths: ['docs'], mtimes: {} });
  });

  it('modify updates the mtime', () => {
    const fe = new FakeFileExplorer();
    fe.observe('create', fakeFile('a.md', 100));
    fe.observe('modify', fakeFile('a.md', 200));
    expect(fe.snapshot().mtimes['a.md']).toBe(200);
  });

  it('delete removes the path and any mtime', () => {
    const fe = new FakeFileExplorer();
    fe.observe('create', fakeFile('a.md', 100));
    fe.observe('delete', fakeFile('a.md'));
    expect(fe.snapshot()).toEqual({ paths: [], mtimes: {} });
  });

  it('folder delete also removes descendants', () => {
    const fe = new FakeFileExplorer();
    fe.observe('create', fakeFolder('docs'));
    fe.observe('create', fakeFile('docs/a.md', 100));
    fe.observe('create', fakeFile('docs/sub/b.md', 200));
    fe.observe('create', fakeFile('outside.md', 300));
    fe.observe('delete', fakeFolder('docs'));
    expect(fe.snapshot()).toEqual({ paths: ['outside.md'], mtimes: { 'outside.md': 300 } });
  });

  it('rename moves the path and preserves mtime when no new stat is available', () => {
    const fe = new FakeFileExplorer();
    fe.observe('create', fakeFile('old.md', 100));
    fe.observe('rename', fakeFolder('new.md'), 'old.md'); // no stat on the rename arg
    expect(fe.snapshot()).toEqual({ paths: ['new.md'], mtimes: { 'new.md': 100 } });
  });

  it('rename uses the new file\'s stat when present', () => {
    const fe = new FakeFileExplorer();
    fe.observe('create', fakeFile('old.md', 100));
    fe.observe('rename', fakeFile('new.md', 999), 'old.md');
    expect(fe.snapshot()).toEqual({ paths: ['new.md'], mtimes: { 'new.md': 999 } });
  });

  it('folder rename rewrites descendant paths', () => {
    const fe = new FakeFileExplorer();
    fe.observe('create', fakeFolder('docs'));
    fe.observe('create', fakeFile('docs/a.md', 100));
    fe.observe('create', fakeFile('docs/sub/b.md', 200));
    fe.observe('rename', fakeFolder('archive'), 'docs');
    expect(fe.snapshot()).toEqual({
      paths: ['archive', 'archive/a.md', 'archive/sub/b.md'],
      mtimes: { 'archive/a.md': 100, 'archive/sub/b.md': 200 },
    });
  });
});

// ── awaitReflect: history walk + late waiter + timeout ──────────────────

describe('FakeFileExplorer — awaitReflect', () => {
  it('resolves from history when the event already fired', async () => {
    const fe = new FakeFileExplorer();
    fe.observe('create', fakeFile('a.md', 100));
    const info = await fe.awaitReflect('a.md', 'create');
    expect(typeof info.atMs).toBe('number');
    expect(info.atMs).toBeGreaterThan(0);
  });

  it('a later awaitReflect for the same event does not double-consume', async () => {
    const fe = new FakeFileExplorer();
    fe.observe('create', fakeFile('a.md', 100));
    await fe.awaitReflect('a.md', 'create'); // consumes the history entry
    await expect(fe.awaitReflect('a.md', 'create', 50)).rejects.toThrow(/no create.*within 50ms/);
  });

  it('resolves a pending waiter when the event arrives later', async () => {
    const fe = new FakeFileExplorer();
    const p = fe.awaitReflect('a.md', 'create');
    queueMicrotask(() => fe.observe('create', fakeFile('a.md', 100)));
    const info = await p;
    expect(info.atMs).toBeGreaterThan(0);
  });

  it('the right event matches its pending waiter even when others fire', async () => {
    const fe = new FakeFileExplorer();
    const p = fe.awaitReflect('a.md', 'modify');
    fe.observe('create', fakeFile('a.md', 100));   // wrong event for waiter
    fe.observe('create', fakeFile('b.md', 100));   // different path
    fe.observe('modify', fakeFile('a.md', 200));   // ← match
    const info = await p;
    expect(info.atMs).toBeGreaterThan(0);
  });

  it('times out with a descriptive error when no event arrives', async () => {
    const fe = new FakeFileExplorer();
    await expect(fe.awaitReflect('a.md', 'create', 30))
      .rejects.toThrow(/no create.*"a\.md".*within 30ms/);
  });

  it('timeout leaves no leaked waiter (a later observe does not crash)', async () => {
    const fe = new FakeFileExplorer();
    await fe.awaitReflect('a.md', 'create', 20).catch(() => {});
    expect(() => fe.observe('create', fakeFile('a.md', 100))).not.toThrow();
  });
});

// ── attach(vault) round-trip ────────────────────────────────────────────

describe('FakeFileExplorer — attach()', () => {
  it('subscribes to all four events and tracks them', () => {
    const fe = new FakeFileExplorer();
    const v = new FakeVault();
    fe.attach(v);

    expect(v.listenerCount('create')).toBe(1);
    expect(v.listenerCount('modify')).toBe(1);
    expect(v.listenerCount('delete')).toBe(1);
    expect(v.listenerCount('rename')).toBe(1);

    v.trigger('create', fakeFile('a.md', 100));
    v.trigger('modify', fakeFile('a.md', 200));
    expect(fe.snapshot().mtimes['a.md']).toBe(200);
  });

  it('disposer detaches all four listeners', () => {
    const fe = new FakeFileExplorer();
    const v = new FakeVault();
    const dispose = fe.attach(v);
    dispose();

    expect(v.listenerCount('create')).toBe(0);
    expect(v.listenerCount('modify')).toBe(0);
    expect(v.listenerCount('delete')).toBe(0);
    expect(v.listenerCount('rename')).toBe(0);
  });

  it('after dispose, vault events are no longer reflected', () => {
    const fe = new FakeFileExplorer();
    const v = new FakeVault();
    const dispose = fe.attach(v);
    v.trigger('create', fakeFile('a.md', 100));
    dispose();
    v.trigger('create', fakeFile('b.md', 200));
    expect(fe.snapshot()).toEqual({ paths: ['a.md'], mtimes: { 'a.md': 100 } });
  });
});

// ── reset() ──────────────────────────────────────────────────────────────

describe('FakeFileExplorer — reset', () => {
  it('drops all state', () => {
    const fe = new FakeFileExplorer();
    fe.observe('create', fakeFile('a.md', 100));
    fe.reset();
    expect(fe.snapshot()).toEqual({ paths: [], mtimes: {} });
  });

  it('rejects any pending waiter', async () => {
    const fe = new FakeFileExplorer();
    const p = fe.awaitReflect('a.md', 'create');
    fe.reset();
    await expect(p).rejects.toThrow(/reset\(\) while awaiting/);
  });
});
