import { describe, it, expect, vi } from 'vitest';
import { VaultModelBuilder, type RemoteEntry, type ObsidianClassDeps } from '../src/vault/VaultModelBuilder';

/**
 * Minimal stubs that mirror the structural shape of TFile / TFolder
 * the builder reads / writes. We don't extend `obsidian`'s class
 * declarations because the package ships .d.ts only — at test time
 * there is no runtime to extend.
 *
 * Constructors record the args they were called with so the tests
 * can verify the builder always passes `(vault, path)` — Obsidian's
 * real TFile/TFolder constructors require those.
 */
class FakeTFile {
  vault!: unknown;
  path!: string;
  name!: string;
  basename!: string;
  extension!: string;
  parent!: FakeTFolder;
  stat!: { ctime: number; mtime: number; size: number };

  static lastConstructorArgs: { vault: unknown; path: string } | null = null;
  constructor(vault: unknown, path: string) {
    FakeTFile.lastConstructorArgs = { vault, path };
    this.vault = vault;
    this.path = path;
  }
}

class FakeTFolder {
  vault!: unknown;
  path: string = '';
  name: string = '';
  parent: FakeTFolder | null = null;
  children: Array<FakeTFile | FakeTFolder> = [];

  static lastConstructorArgs: { vault: unknown; path: string } | null = null;
  constructor(vault?: unknown, path?: string) {
    if (vault !== undefined && path !== undefined) {
      FakeTFolder.lastConstructorArgs = { vault, path };
      this.vault = vault;
      this.path = path;
    }
  }
}

const deps: ObsidianClassDeps = {
  // The shapes match what TFile/TFolder produce at runtime in Obsidian;
  // the cast satisfies the injected interface.
  TFile:   FakeTFile as unknown as ObsidianClassDeps['TFile'],
  TFolder: FakeTFolder as unknown as ObsidianClassDeps['TFolder'],
};

/**
 * Stand-in vault that just maintains `fileMap` + a real root folder
 * + records every `trigger` call, so tests can inspect what events
 * fired and which files now live in the model.
 */
function makeFakeVault() {
  const root = new FakeTFolder();
  const fileMap: Record<string, FakeTFile | FakeTFolder> = {};
  const triggers: Array<{ event: string; args: unknown[] }> = [];

  const vault = {
    fileMap,
    triggers,
    getRoot: () => root,
    getAbstractFileByPath: (p: string) => fileMap[p] ?? null,
    trigger: (event: string, ...args: unknown[]) => { triggers.push({ event, args }); },
  };
  return { vault, root, fileMap, triggers };
}

describe('VaultModelBuilder.build', () => {
  it('returns zero counts for empty entry list', async () => {
    const { vault } = makeFakeVault();
    const result = await new VaultModelBuilder(vault as never, deps).build([]);
    expect(result).toEqual({ filesAdded: 0, foldersAdded: 0, skipped: 0, errors: [] });
  });

  it('inserts a single file at root, in fileMap and root.children, and fires create', async () => {
    const { vault, root, fileMap, triggers } = makeFakeVault();
    const entry: RemoteEntry = { path: 'Notes.md', isDirectory: false, ctime: 100, mtime: 200, size: 42 };

    const result = await new VaultModelBuilder(vault as never, deps).build([entry]);

    expect(result.filesAdded).toBe(1);
    expect(result.errors).toEqual([]);
    expect(fileMap['Notes.md']).toBeInstanceOf(FakeTFile);
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toBe(fileMap['Notes.md']);

    const file = fileMap['Notes.md'] as FakeTFile;
    expect(file.path).toBe('Notes.md');
    expect(file.name).toBe('Notes.md');
    expect(file.basename).toBe('Notes');
    expect(file.extension).toBe('md');
    expect(file.parent).toBe(root);
    expect(file.stat).toEqual({ ctime: 100, mtime: 200, size: 42 });
    expect(file.vault).toBe(vault);

    expect(triggers).toEqual([{ event: 'create', args: [file] }]);
  });

  it('inserts folders before contained files even when given out of order', async () => {
    const { vault, root, fileMap } = makeFakeVault();
    const entries: RemoteEntry[] = [
      { path: 'sub/note.md',  isDirectory: false, ctime: 0, mtime: 0, size: 0 },
      { path: 'sub',          isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
    ];

    const result = await new VaultModelBuilder(vault as never, deps).build(entries);

    expect(result.foldersAdded).toBe(1);
    expect(result.filesAdded).toBe(1);
    expect(result.errors).toEqual([]);
    expect(fileMap['sub']).toBeInstanceOf(FakeTFolder);
    expect(fileMap['sub/note.md']).toBeInstanceOf(FakeTFile);

    const folder = fileMap['sub'] as FakeTFolder;
    expect(folder.children).toHaveLength(1);
    expect(folder.children[0]).toBe(fileMap['sub/note.md']);
    expect(root.children).toContain(folder);
  });

  it('handles deeply nested paths once intermediate folders exist', async () => {
    const { vault, fileMap } = makeFakeVault();
    const entries: RemoteEntry[] = [
      { path: 'a',             isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
      { path: 'a/b',           isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
      { path: 'a/b/c',         isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
      { path: 'a/b/c/leaf.md', isDirectory: false, ctime: 1, mtime: 2, size: 3 },
    ];

    const result = await new VaultModelBuilder(vault as never, deps).build(entries);

    expect(result).toEqual({ filesAdded: 1, foldersAdded: 3, skipped: 0, errors: [] });
    const leaf = fileMap['a/b/c/leaf.md'] as FakeTFile;
    expect(leaf.parent).toBe(fileMap['a/b/c']);
    expect(leaf.stat).toEqual({ ctime: 1, mtime: 2, size: 3 });
  });

  it('reports an error (and does not insert) when a file\'s parent folder is missing', async () => {
    const { vault, fileMap } = makeFakeVault();
    const entries: RemoteEntry[] = [
      { path: 'orphan/file.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
    ];

    const result = await new VaultModelBuilder(vault as never, deps).build(entries);

    expect(result.filesAdded).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe('orphan/file.md');
    expect(result.errors[0].message).toMatch(/parent folder/);
    expect(fileMap['orphan/file.md']).toBeUndefined();
  });

  it('skips entries whose path is already present (second build is idempotent)', async () => {
    const { vault, fileMap } = makeFakeVault();
    const entry: RemoteEntry = { path: 'note.md', isDirectory: false, ctime: 0, mtime: 0, size: 1 };
    const builder = new VaultModelBuilder(vault as never, deps);

    const first = await builder.build([entry]);
    expect(first.filesAdded).toBe(1);
    const original = fileMap['note.md'];

    const second = await builder.build([entry]);
    expect(second.filesAdded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(fileMap['note.md']).toBe(original);
  });

  it('rejects empty path with an error rather than throwing', async () => {
    const { vault } = makeFakeVault();
    const result = await new VaultModelBuilder(vault as never, deps).build([
      { path: '', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
    ]);
    expect(result.filesAdded).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/empty path/);
  });

  it('fires create for both files and folders, in folders-first order', async () => {
    // Discovered during Phase 4 smoke: File Explorer\'s view.onCreate
    // is the only path that registers a folder in view.fileItems, and
    // without that the folder\'s DOM never gets built — so files
    // inside also stay hidden even when correctly inserted into
    // vault.fileMap. Fire create for folders too; sort guarantees
    // each file\'s create event finds its parent already registered.
    const { vault, triggers } = makeFakeVault();
    const entries: RemoteEntry[] = [
      { path: 'd1',         isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
      { path: 'd1/file.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
      { path: 'd2',         isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
    ];
    await new VaultModelBuilder(vault as never, deps).build(entries);

    // 3 create events, all named 'create'.
    expect(triggers).toHaveLength(3);
    expect(triggers.every(t => t.event === 'create')).toBe(true);
    // Folders fire before the file inside them so File Explorer can
    // build the parent DOM before adding children.
    const paths = triggers.map(t => (t.args[0] as { path: string }).path);
    expect(paths.indexOf('d1')).toBeLessThan(paths.indexOf('d1/file.md'));
    expect(paths).toContain('d2');
  });

  it('correctly extracts basename and extension for files with multiple dots and no extension', async () => {
    const { vault, fileMap } = makeFakeVault();
    const entries: RemoteEntry[] = [
      { path: 'archive.tar.gz', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
      { path: 'README',         isDirectory: false, ctime: 0, mtime: 0, size: 0 },
      { path: '.dotfile',       isDirectory: false, ctime: 0, mtime: 0, size: 0 },
    ];
    await new VaultModelBuilder(vault as never, deps).build(entries);

    const tar = fileMap['archive.tar.gz'] as FakeTFile;
    expect(tar.basename).toBe('archive.tar');
    expect(tar.extension).toBe('gz');

    const readme = fileMap['README'] as FakeTFile;
    expect(readme.basename).toBe('README');
    expect(readme.extension).toBe('');

    const dot = fileMap['.dotfile'] as FakeTFile;
    // Leading dot is treated as part of the name, no extension.
    expect(dot.basename).toBe('.dotfile');
    expect(dot.extension).toBe('');
  });

  it('continues processing later entries when an earlier one errors', async () => {
    const { vault, fileMap } = makeFakeVault();
    const entries: RemoteEntry[] = [
      { path: 'no-such/parent/file.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
      { path: 'good.md',                isDirectory: false, ctime: 0, mtime: 0, size: 0 },
    ];

    const result = await new VaultModelBuilder(vault as never, deps).build(entries);

    expect(result.filesAdded).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(fileMap['good.md']).toBeDefined();
    expect(fileMap['no-such/parent/file.md']).toBeUndefined();
  });

  it('passes (vault, path) to TFile / TFolder constructors so Obsidian-side initialisers never see undefined', async () => {
    const { vault } = makeFakeVault();
    FakeTFile.lastConstructorArgs = null;
    FakeTFolder.lastConstructorArgs = null;
    const entries: RemoteEntry[] = [
      { path: 'sub',         isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
      { path: 'sub/leaf.md', isDirectory: false, ctime: 1, mtime: 2, size: 3 },
    ];
    await new VaultModelBuilder(vault as never, deps).build(entries);

    // Real Obsidian's TFolder constructor calls `path.lastIndexOf('/')`
    // and throws on undefined, so the builder must never fall back to
    // the no-arg form.
    expect(FakeTFolder.lastConstructorArgs).toEqual({ vault, path: 'sub' });
    expect(FakeTFile.lastConstructorArgs).toEqual({ vault, path: 'sub/leaf.md' });
  });

  it('treats a colliding non-folder parent as an error rather than silently inserting', async () => {
    const { vault, fileMap } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);

    // First insert "parent.md" as a file.
    await builder.build([
      { path: 'parent.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
    ]);
    expect(fileMap['parent.md']).toBeInstanceOf(FakeTFile);

    // Then try to nest under it as if it were a folder.
    const result = await builder.build([
      { path: 'parent.md/child.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
    ]);
    expect(result.filesAdded).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(fileMap['parent.md/child.md']).toBeUndefined();
  });
});

describe('VaultModelBuilder.insertOne', () => {
  it('inserts a single file at root and fires create', () => {
    const { vault, root, fileMap, triggers } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    const out = builder.insertOne({ path: 'note.md', isDirectory: false, ctime: 1, mtime: 2, size: 3 });
    expect(out).not.toBeNull();
    expect(fileMap['note.md']).toBe(out);
    expect(root.children).toContain(out);
    expect(triggers).toEqual([{ event: 'create', args: [out] }]);
  });

  it('inserts a folder and fires create', () => {
    const { vault, fileMap, triggers } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    const out = builder.insertOne({ path: 'sub', isDirectory: true, ctime: 0, mtime: 0, size: 0 });
    expect(out).toBeInstanceOf(FakeTFolder);
    expect(fileMap['sub']).toBe(out);
    expect(triggers).toEqual([{ event: 'create', args: [out] }]);
  });

  it('returns null and does not fire create when the path is already in the model', () => {
    const { vault, triggers } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    builder.insertOne({ path: 'note.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 });
    triggers.length = 0;
    const second = builder.insertOne({ path: 'note.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 });
    expect(second).toBeNull();
    expect(triggers).toEqual([]);
  });

  it('returns null when the parent folder is missing', () => {
    const { vault, fileMap, triggers } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    const out = builder.insertOne({ path: 'orphan/file.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 });
    expect(out).toBeNull();
    expect(fileMap['orphan/file.md']).toBeUndefined();
    expect(triggers).toEqual([]);
  });
});

describe('VaultModelBuilder.removeOne', () => {
  it('removes a file from fileMap + parent.children and fires delete', async () => {
    const { vault, root, fileMap, triggers } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    await builder.build([
      { path: 'note.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
    ]);
    const file = fileMap['note.md'];
    triggers.length = 0;

    const removed = builder.removeOne('note.md');
    expect(removed).toBe(true);
    expect(fileMap['note.md']).toBeUndefined();
    expect(root.children).not.toContain(file);
    expect(triggers).toEqual([{ event: 'delete', args: [file] }]);
  });

  it('removes a folder AND every descendant from fileMap', async () => {
    const { vault, fileMap } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    await builder.build([
      { path: 'sub',          isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
      { path: 'sub/note.md',  isDirectory: false, ctime: 0, mtime: 0, size: 0 },
      { path: 'sub/inner',    isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
      { path: 'sub/inner/x.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
      { path: 'other.md',     isDirectory: false, ctime: 0, mtime: 0, size: 0 },
    ]);

    builder.removeOne('sub');

    expect(fileMap['sub']).toBeUndefined();
    expect(fileMap['sub/note.md']).toBeUndefined();
    expect(fileMap['sub/inner']).toBeUndefined();
    expect(fileMap['sub/inner/x.md']).toBeUndefined();
    // Sibling untouched.
    expect(fileMap['other.md']).toBeDefined();
  });

  it('returns false and does not fire delete when the path is not in the model', () => {
    const { vault, triggers } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    expect(builder.removeOne('does-not-exist.md')).toBe(false);
    expect(triggers).toEqual([]);
  });
});

describe('VaultModelBuilder.modifyOne', () => {
  it('updates stat and fires modify for an existing file', async () => {
    const { vault, fileMap, triggers } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    await builder.build([
      { path: 'note.md', isDirectory: false, ctime: 1, mtime: 2, size: 3 },
    ]);
    triggers.length = 0;

    const ok = builder.modifyOne('note.md', { ctime: 10, mtime: 20, size: 30 });
    expect(ok).toBe(true);
    const file = fileMap['note.md'] as FakeTFile;
    expect(file.stat).toEqual({ ctime: 10, mtime: 20, size: 30 });
    expect(triggers).toEqual([{ event: 'modify', args: [file] }]);
  });

  it('fires modify but leaves stat untouched when called without a stat arg', async () => {
    const { vault, fileMap, triggers } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    await builder.build([
      { path: 'note.md', isDirectory: false, ctime: 1, mtime: 2, size: 3 },
    ]);
    triggers.length = 0;

    builder.modifyOne('note.md');
    expect((fileMap['note.md'] as FakeTFile).stat).toEqual({ ctime: 1, mtime: 2, size: 3 });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].event).toBe('modify');
  });

  it('returns false for folders and missing paths', async () => {
    const { vault, triggers } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    await builder.build([
      { path: 'sub', isDirectory: true, ctime: 0, mtime: 0, size: 0 },
    ]);
    triggers.length = 0;

    expect(builder.modifyOne('sub')).toBe(false);
    expect(builder.modifyOne('does-not-exist')).toBe(false);
    expect(triggers).toEqual([]);
  });
});

describe('VaultModelBuilder.renameOne', () => {
  it('renames a file in fileMap + parent.children and fires rename with the old path', async () => {
    const { vault, root, fileMap, triggers } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    await builder.build([
      { path: 'old.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
    ]);
    const file = fileMap['old.md'] as FakeTFile;
    triggers.length = 0;

    const ok = builder.renameOne('old.md', 'new.md');
    expect(ok).toBe(true);
    expect(fileMap['old.md']).toBeUndefined();
    expect(fileMap['new.md']).toBe(file);
    expect(file.path).toBe('new.md');
    expect(file.name).toBe('new.md');
    expect(file.basename).toBe('new');
    expect(file.extension).toBe('md');
    expect(root.children).toContain(file);
    expect(triggers).toEqual([{ event: 'rename', args: [file, 'old.md'] }]);
  });

  it('moves a file across folders and updates parent references', async () => {
    const { vault, fileMap } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    await builder.build([
      { path: 'src',         isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
      { path: 'dst',         isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
      { path: 'src/note.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
    ]);
    const src = fileMap['src'] as FakeTFolder;
    const dst = fileMap['dst'] as FakeTFolder;
    const file = fileMap['src/note.md'] as FakeTFile;

    expect(src.children).toContain(file);
    expect(dst.children).not.toContain(file);

    builder.renameOne('src/note.md', 'dst/note.md');

    expect(src.children).not.toContain(file);
    expect(dst.children).toContain(file);
    expect(file.parent).toBe(dst);
    expect(file.path).toBe('dst/note.md');
  });

  it('renames a folder AND rewrites every descendant\'s path', async () => {
    const { vault, fileMap } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    await builder.build([
      { path: 'old',          isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
      { path: 'old/note.md',  isDirectory: false, ctime: 0, mtime: 0, size: 0 },
      { path: 'old/inner',    isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
      { path: 'old/inner/x.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
    ]);

    builder.renameOne('old', 'new');

    expect(fileMap['old']).toBeUndefined();
    expect(fileMap['old/note.md']).toBeUndefined();
    expect(fileMap['old/inner']).toBeUndefined();
    expect(fileMap['old/inner/x.md']).toBeUndefined();
    expect(fileMap['new']).toBeDefined();
    expect(fileMap['new/note.md']).toBeDefined();
    expect(fileMap['new/inner']).toBeDefined();
    expect(fileMap['new/inner/x.md']).toBeDefined();
    // Path field on each descendant matches the new key.
    expect(fileMap['new/note.md'].path).toBe('new/note.md');
    expect(fileMap['new/inner/x.md'].path).toBe('new/inner/x.md');
  });

  it('returns false when the source is missing or the destination has no parent', async () => {
    const { vault, triggers } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    await builder.build([
      { path: 'note.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
    ]);
    triggers.length = 0;

    expect(builder.renameOne('missing.md', 'whatever.md')).toBe(false);
    expect(builder.renameOne('note.md', 'no-such-folder/note.md')).toBe(false);
    expect(triggers).toEqual([]);
  });

  it('is a no-op when oldPath === newPath', () => {
    const { vault, triggers } = makeFakeVault();
    const builder = new VaultModelBuilder(vault as never, deps);
    expect(builder.renameOne('x', 'x')).toBe(false);
    expect(triggers).toEqual([]);
  });
});
