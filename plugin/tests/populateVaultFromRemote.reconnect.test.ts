import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/RemoteTerminalView', () => ({
  RemoteTerminalView: class {}, VIEW_TYPE_REMOTE_TERMINAL: 'remote-terminal',
}));
vi.mock('obsidian', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  class TFile {
    constructor(public vault: unknown, public path: string) {}
  }
  class TFolder extends TFile { children: unknown[] = []; }
  return { ...original, TFile, TFolder };
});

import { App, TFile, TFolder } from 'obsidian';
import RemoteSshPlugin from '../src/main';
import { VaultModelBuilder, type RemoteEntry } from '../src/vault/VaultModelBuilder';
import type { BackgroundIndexer } from '../src/vault/BackgroundIndexer';
import type { LazyFolderLoader } from '../src/vault/LazyFolderLoader';
import type { WalkParams, WalkResult } from '../src/proto/types';

const folder = '.herdr/worktrees/project/docs/writing';
const oldPath = `${folder}/decision-tree.md`;
const newPath = `${folder}/decision-tree-diagram.md`;
const entry = (path: string, isDirectory = false): RemoteEntry =>
  ({ path, isDirectory, ctime: 1, mtime: 1, size: 1 });
const dirs = folder.split('/').map((_, i, parts) => entry(parts.slice(0, i + 1).join('/'), true));
const children = (entries: RemoteEntry[], path: string) =>
  entries.filter(e => e.path.slice(0, Math.max(0, e.path.lastIndexOf('/'))) === path);

// Invoke the actual reconnect populate method, real walker, visibility filter,
// background indexer and model builder. Only remote I/O and Obsidian UI are fake.
async function scenario(transport: 'rpc' | 'sftp', rootOnly: boolean, opts: { indexRunning?: boolean } = {}) {
  const app = new App();
  const fileMap: Record<string, TFile | TFolder> = {};
  const root = new TFolder(app.vault, '');
  const trigger = vi.fn();
  let remote = [...dirs, entry(oldPath)];
  const list = vi.fn(async (path: string) => {
    const entries = children(remote, path);
    return { folders: entries.filter(e => e.isDirectory).map(e => e.path),
      files: entries.filter(e => !e.isDirectory).map(e => e.path) };
  });
  Object.assign(app.vault, { fileMap, getRoot: () => root,
    getAbstractFileByPath: (path: string) => fileMap[path] ?? null, trigger,
    getAllLoadedFiles: () => [root, ...Object.values(fileMap)], configDir: '.obsidian',
    adapter: { list } });
  const rpcCall = vi.fn(async (method: string, params: WalkParams): Promise<WalkResult> => {
    expect(method).toBe('fs.walk');
    const entries = params.recursive ? remote : children(remote, params.path ?? '');
    return { entries: entries.map(e => ({ path: e.path, type: e.isDirectory ? 'folder' : 'file',
      mtime: e.mtime, size: e.size })), truncated: false };
  });
  const plugin = new RemoteSshPlugin(app);
  const internal = plugin as unknown as {
    settings: unknown; conn: unknown; installLazyExpandHook: () => void;
    startBackgroundIndex: () => void; backgroundIndexer: BackgroundIndexer | null;
    lazyLoader: LazyFolderLoader | null; adapterMgr: unknown;
  };
  internal.settings = { lazyFolderLoad: true };
  internal.adapterMgr = { pendingOfflineFilter: () => null };
  // A previous session's completed index says nothing about this one.
  // connectProfile sets CONNECTED before it populates.
  Object.assign(internal, { vaultIndexed: true, missedEvents: true, state: 'connected' });
  internal.conn = { activeProfile: { allowedHiddenDirs: ['.herdr'], walkIgnoreDirs: ['.git'] },
    rpcConnection: transport === 'rpc' ? { rpc: { call: rpcCall }, info: { capabilities: ['fs.walk'] } } : null };
  internal.installLazyExpandHook = vi.fn();
  if (rootOnly) internal.startBackgroundIndex = vi.fn();
  // A reconnect that recovered mid-populate has already started its own pass.
  if (opts.indexRunning) internal.backgroundIndexer = { isRunning: true } as unknown as BackgroundIndexer;

  // The folder is already expanded in the retained model. Then a new file is
  // created remotely before reconnect/watch subscription, so no event is sent.
  const seeded = await new VaultModelBuilder(app.vault, { TFile, TFolder }).build(remote);
  expect(seeded.errors).toEqual([]);
  expect(fileMap[oldPath]).toBeDefined();
  expect(fileMap[newPath]).toBeUndefined();
  remote = [...remote, entry(newPath)];
  trigger.mockClear();
  await plugin.populateVaultFromRemote('shadow-reconnect');
  expect(internal).toMatchObject({ vaultIndexed: false, missedEvents: false });
  if (!rootOnly) {
    // Observe the automatically started pass; invoking start() here could hide
    // a regression where reconnect constructs an indexer but never runs it.
    await vi.waitFor(() => {
      expect(fileMap[newPath]).toBeInstanceOf(TFile);
      expect(internal.backgroundIndexer?.isRunning).toBe(false);
    });
  }
  return { fileMap, trigger, internal };
}

describe('populate and a pass already running', () => {
  it.each([[false, 1], [true, 0]] as const)(
    'with a pass already running=%s, populate starts %i index pass(es)', async (indexRunning, starts) => {
      const { internal } = await scenario('rpc', true, { indexRunning });
      expect(internal.startBackgroundIndex).toHaveBeenCalledTimes(starts);
    });
});

describe('reconnect with a preexisting file under an already-expanded allowed dot-folder', () => {
  it('control: root-only reconnect reproduces the missing diagram', async () => {
    const result = await scenario('rpc', true);
    expect(result.fileMap[newPath]).toBeUndefined();
  });

  it.each(['rpc', 'sftp'] as const)('%s: reconnect discovers the file without expansion or a watch event', async transport => {
    const { fileMap, trigger, internal } = await scenario(transport, false);
    expect(fileMap[newPath]).toBeInstanceOf(TFile);
    expect((fileMap[folder] as TFolder).children).toContain(fileMap[newPath]);
    expect(trigger.mock.calls.filter(([event, file]) => event === 'create' && file.path === newPath)).toHaveLength(1);
    expect(internal.lazyLoader?.isLoaded(folder)).toBe(true);
  });
});
