import { describe, it, expect, vi } from 'vitest';
import * as nodePath from 'path';
import { FsModulePatcher, type VaultEntry } from '../src/adapter/FsModulePatcher';

const ROOT = nodePath.resolve(nodePath.sep === '\\' ? 'C:\\shadow\\vault' : '/shadow/vault');
const abs = (rel: string) => nodePath.join(ROOT, ...rel.split('/'));

/**
 * A fake `fs` module plus a fake vault model.
 *
 * `onDisk` is what physically exists (the config tree, and whatever has
 * been materialised); `model` is the remote tree the vault knows about.
 * The whole point of the patch is that the second becomes visible
 * through the first without being copied into it.
 */
function harness(onDisk: Record<string, string> = {}, model: Record<string, VaultEntry> = {}) {
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });

  const fsModule: Record<string, unknown> = {
    readFileSync: vi.fn((p: string) => {
      if (!(p in onDisk)) throw enoent(p);
      return Buffer.from(onDisk[p]);
    }),
    readdirSync: vi.fn((p: string) => {
      const prefix = p.endsWith(nodePath.sep) ? p : p + nodePath.sep;
      const kids = new Set<string>();
      let isDir = false;
      for (const f of Object.keys(onDisk)) {
        if (!f.startsWith(prefix)) continue;
        isDir = true;
        kids.add(f.slice(prefix.length).split(nodePath.sep)[0]);
      }
      if (!isDir) throw enoent(p);
      return [...kids];
    }),
    existsSync: vi.fn((p: string) => p in onDisk
      || Object.keys(onDisk).some(f => f.startsWith(p + nodePath.sep))),
    statSync: vi.fn((p: string) => {
      if (!(p in onDisk)) throw enoent(p);
      return { size: onDisk[p].length, real: true, isFile: () => true, isDirectory: () => false };
    }),
    lstatSync: vi.fn((p: string) => {
      if (!(p in onDisk)) throw enoent(p);
      return { size: onDisk[p].length, real: true, isFile: () => true, isDirectory: () => false };
    }),
  };
  const originals = { ...fsModule };

  const materialize = vi.fn((rel: string) => {
    const entry = model[rel];
    if (!entry || entry.isDir) return false;
    onDisk[abs(rel)] = `content of ${rel}`;
    return true;
  });

  const patcher = new FsModulePatcher({
    fsModule,
    root: ROOT,
    configDir: '.obsidian',
    tree: {
      children: (relDir) => {
        const self = relDir === '' ? { isDir: true, size: 0, mtimeMs: 0 } : model[relDir];
        if (!self?.isDir) return null;
        const prefix = relDir === '' ? '' : `${relDir}/`;
        const seen = new Map<string, VaultEntry>();
        for (const [p, e] of Object.entries(model)) {
          if (!p.startsWith(prefix) || p === relDir) continue;
          const rest = p.slice(prefix.length);
          if (rest.includes('/')) continue;
          seen.set(rest, e);
        }
        return [...seen].map(([name, entry]) => ({ name, entry }));
      },
      entry: (rel) => model[rel] ?? null,
    },
    materialize,
  });

  return { patcher, fsModule, originals, onDisk, model, materialize };
}

const file = (size = 10, mtimeMs = 1700): VaultEntry => ({ isDir: false, size, mtimeMs });
const dir = (): VaultEntry => ({ isDir: true, size: 0, mtimeMs: 0 });

describe('FsModulePatcher', () => {
  it('materialises a remote note on readFileSync and returns its bytes', () => {
    const h = harness({}, { 'note.md': file() });
    expect(h.patcher.patch()).toBe(true);

    const body = (h.fsModule.readFileSync as (p: string) => Buffer)(abs('note.md'));
    expect(h.materialize).toHaveBeenCalledWith('note.md');
    expect(body.toString()).toBe('content of note.md');
  });

  it('does not re-materialise a file that is already on disk', () => {
    const h = harness({ [abs('note.md')]: 'already here' }, { 'note.md': file() });
    h.patcher.patch();
    const body = (h.fsModule.readFileSync as (p: string) => Buffer)(abs('note.md'));
    expect(h.materialize).not.toHaveBeenCalled();
    expect(body.toString()).toBe('already here');
  });

  it('still throws ENOENT when the file cannot be materialised', () => {
    const h = harness({}, {});
    h.patcher.patch();
    expect(() => (h.fsModule.readFileSync as (p: string) => Buffer)(abs('ghost.md')))
      .toThrow(/ENOENT/);
  });

  it('lists the vault through readdirSync without downloading anything', () => {
    const h = harness(
      { [abs('.obsidian/app.json')]: '{}' },
      { 'note.md': file(), 'folder': dir(), 'folder/deep.md': file() },
    );
    h.patcher.patch();
    const entries = (h.fsModule.readdirSync as (p: string) => string[])(ROOT);

    expect(entries).toContain('note.md');
    expect(entries).toContain('folder');
    expect(entries, 'the real config dir disappeared from the listing').toContain('.obsidian');
    expect(h.materialize, 'listing a directory fetched content').not.toHaveBeenCalled();
  });

  it('lists a folder that exists only in the model', () => {
    const h = harness({}, { 'folder': dir(), 'folder/deep.md': file() });
    h.patcher.patch();
    expect((h.fsModule.readdirSync as (p: string) => string[])(abs('folder'))).toEqual(['deep.md']);
  });

  it('returns Dirent-shaped entries when asked for them', () => {
    const h = harness({}, { 'note.md': file(), 'folder': dir() });
    h.patcher.patch();
    const readdir = h.fsModule.readdirSync as
      (p: string, o: unknown) => { name: string; isDirectory(): boolean }[];
    const byName = Object.fromEntries(
      readdir(ROOT, { withFileTypes: true }).map(e => [e.name, e]),
    );
    expect(byName['note.md'].isDirectory()).toBe(false);
    expect(byName['folder'].isDirectory()).toBe(true);
  });

  it('does not duplicate a name that is both materialised and in the model', () => {
    const h = harness({ [abs('note.md')]: 'materialised' }, { 'note.md': file() });
    h.patcher.patch();
    const entries = (h.fsModule.readdirSync as (p: string) => string[])(ROOT);
    expect(entries.filter(e => e === 'note.md')).toHaveLength(1);
  });

  it('answers existsSync and statSync from the model, with the real size', () => {
    const h = harness({}, { 'note.md': file(4096, 1767225600000) });
    h.patcher.patch();
    expect((h.fsModule.existsSync as (p: string) => boolean)(abs('note.md'))).toBe(true);
    const st = (h.fsModule.statSync as (p: string) =>
      { size: number; isFile(): boolean; mtimeMs: number })(abs('note.md'));
    expect(st.size).toBe(4096);
    expect(st.mtimeMs).toBe(1767225600000);
    expect(st.isFile()).toBe(true);
    expect(h.materialize, 'stat fetched the file').not.toHaveBeenCalled();
  });

  it('leaves the config dir entirely to the real filesystem', () => {
    const h = harness({}, { '.obsidian/app.json': file() });
    h.patcher.patch();
    expect((h.fsModule.existsSync as (p: string) => boolean)(abs('.obsidian/app.json'))).toBe(false);
    expect(() => (h.fsModule.readFileSync as (p: string) => Buffer)(abs('.obsidian/app.json')))
      .toThrow(/ENOENT/);
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it('never answers for a path outside the shadow root', () => {
    const h = harness({}, { 'note.md': file() });
    h.patcher.patch();
    const outside = nodePath.resolve(ROOT, '..', 'somewhere-else', 'note.md');
    expect((h.fsModule.existsSync as (p: string) => boolean)(outside)).toBe(false);
    expect(() => (h.fsModule.readFileSync as (p: string) => Buffer)(outside)).toThrow(/ENOENT/);
    expect(h.materialize, 'a path outside the vault was materialised').not.toHaveBeenCalled();
  });

  it('cannot be tricked out of the root and back in with ..', () => {
    const h = harness({}, { 'note.md': file() });
    h.patcher.patch();
    const sneaky = nodePath.join(ROOT, '..', 'elsewhere', '..', 'vault-ish', 'note.md');
    expect((h.fsModule.existsSync as (p: string) => boolean)(sneaky)).toBe(false);
  });

  it('restore() puts the original functions back', () => {
    const h = harness({}, { 'note.md': file() });
    h.patcher.patch();
    expect(h.fsModule.readFileSync).not.toBe(h.originals.readFileSync);
    h.patcher.restore();
    for (const name of ['readFileSync', 'readdirSync', 'existsSync', 'statSync', 'lstatSync']) {
      expect(h.fsModule[name], `fs.${name} was not restored`).toBe(h.originals[name]);
    }
    expect(h.patcher.isPatched()).toBe(false);
  });

  it('refuses to patch a module that is missing one of the functions', () => {
    const h = harness();
    delete h.fsModule.statSync;
    expect(h.patcher.patch()).toBe(false);
    expect(h.fsModule.readFileSync, 'a partial patch was left behind').toBe(h.originals.readFileSync);
  });
});
