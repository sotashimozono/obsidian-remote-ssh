import { describe, it, expect, vi } from 'vitest';
import { VaultModelBuilder, type RemoteEntry, type ObsidianClassDeps } from '../src/vault/VaultModelBuilder';

/**
 * Minimal stubs that mirror the structural shape of TFile / TFolder
 * the builder reads / writes. We don't extend `obsidian`'s class
 * declarations because the package ships .d.ts only — at test time
 * there is no runtime to extend.
 */
class FakeTFile {
  vault!: unknown;
  path!: string;
  name!: string;
  basename!: string;
  extension!: string;
  parent!: FakeTFolder;
  stat!: { ctime: number; mtime: number; size: number };
}

class FakeTFolder {
  vault!: unknown;
  path: string = '';
  name: string = '';
  parent: FakeTFolder | null = null;
  children: Array<FakeTFile | FakeTFolder> = [];
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

  it('does not fire create for folders, only for files', async () => {
    const { vault, triggers } = makeFakeVault();
    const entries: RemoteEntry[] = [
      { path: 'd1',         isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
      { path: 'd1/file.md', isDirectory: false, ctime: 0, mtime: 0, size: 0 },
      { path: 'd2',         isDirectory: true,  ctime: 0, mtime: 0, size: 0 },
    ];
    await new VaultModelBuilder(vault as never, deps).build(entries);

    // Only one create event — the file. Both folders are silent.
    expect(triggers).toHaveLength(1);
    expect(triggers[0].event).toBe('create');
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
