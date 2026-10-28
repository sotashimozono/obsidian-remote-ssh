import { describe, it, expect, beforeEach, vi } from 'vitest';

// Importing main.ts pulls in RemoteTerminalView (extends the obsidian ItemView,
// which the unit-test obsidian mock doesn't model). Stub the leaf so the import
// graph resolves — the same shim connectProfile.daemon-downgrade.test.ts uses.
vi.mock('../src/ui/RemoteTerminalView', () => ({
  RemoteTerminalView: class {},
  VIEW_TYPE_REMOTE_TERMINAL: 'remote-terminal',
}));

// Never write a real snapshot under the test user's home.
vi.mock('../src/vault/TreeSnapshot', async (orig) => ({
  ...(await orig<typeof import('../src/vault/TreeSnapshot')>()),
  writeTreeSnapshot: vi.fn(),
  deleteTreeSnapshot: vi.fn(),
}));

// Capture what main.ts hands the indexer, without running a walk.
const indexerDeps: Array<Record<string, unknown>> = [];
vi.mock('../src/vault/BackgroundIndexer', () => ({
  BackgroundIndexer: class {
    constructor(deps: Record<string, unknown>) { indexerDeps.push(deps); }
    start() { return Promise.resolve(); }
    cancel() { /* noop */ }
  },
}));

import { App, recordedNotices, clearNotices } from 'obsidian';
import RemoteSshPlugin from '../src/main';
import type { SshProfile } from '../src/types';
import type { RemoteBinding } from '../src/ConnectionManager';

/**
 * The plugin end of the reconnect, which nothing reached.
 *
 * `decideReconnect` and `buildReconnectHooks` were pulled out of `main.ts` so
 * they could be tested, and they are — in isolation. Asking them correctly is a
 * separate matter, and every one of these wirings could be broken with the
 * whole suite green: the dedup guard deleted, the computed notice replaced with
 * the old contentless string, the retry budget invented on the spot, the
 * adapter getter replaced with `() => null` so `rebind` became the no-op it had
 * been before. Those are the exact bugs the extraction claimed to close, so the
 * extraction had moved the hole up a level rather than filling it.
 *
 * `main.ts` is excluded from the coverage scope, which is why this went
 * unmeasured. It is not unreachable: the plugin class constructs fine under the
 * obsidian mock, five other suites already do it, and `recordedNotices()`
 * exists so a test can read the toasts.
 */

const profile = {
  id: 'p1', name: 'Prod', host: 'h', port: 22, username: 'u',
  remotePath: '~/v', transport: 'rpc', authMethod: 'agent',
} as unknown as SshProfile;

interface ReconnectOpts {
  maxRetries: number;
  setAdapterReconnecting: (on: boolean) => void;
  hooks: {
    rebind(b: RemoteBinding): void;
    prepareListenerForReconnect(): void;
    resumeListenerAfterReconnect(rpc: unknown): Promise<void>;
  };
}

function makePlugin(settings: Record<string, unknown> = {}) {
  const plugin = new RemoteSshPlugin(new App() as never);
  const startReconnect = vi.fn().mockResolvedValue(undefined);
  const teardownRpcSession = vi.fn().mockResolvedValue(undefined);
  const startRpcSession = vi.fn().mockResolvedValue(undefined);
  const restore = vi.fn();
  const dataAdapter = { rebind: vi.fn(), setReconnecting: vi.fn() };

  const p = plugin as unknown as Record<string, unknown>;
  p.settings = {
    profiles: [profile], activeProfileId: 'p1', reconnectMaxRetries: 3, ...settings,
  };
  p.conn = {
    activeProfile: profile,
    activeRemoteBasePath: '/home/u/v',
    startReconnect,
    teardownRpcSession,
    startRpcSession,
    buildBinding: () => ({ client: {}, remoteBase: 'v' }) as unknown as RemoteBinding,
  };
  p.adapterMgr = { dataAdapter, restore };
  p.fsChangeListener = {
    prepareForReconnect: vi.fn(),
    resumeAfterReconnect: vi.fn().mockResolvedValue(undefined),
    isSubscribed: () => false,
  };

  const drop = (cause?: Error) =>
    (plugin as unknown as { startReconnect(c?: Error): Promise<void> }).startReconnect(cause);

  return {
    plugin, p, drop, startReconnect, teardownRpcSession, startRpcSession, restore, dataAdapter,
  };
}

/** Only the toasts about a lost connection; ignore anything else. */
function lostNotices(): readonly string[] {
  return recordedNotices().filter((n) => /connection lost/i.test(n));
}

beforeEach(() => clearNotices());

describe('RemoteSshPlugin.startReconnect — what the user is told', () => {
  it('says what died, not just that something did', async () => {
    const { drop } = makePlugin();

    await drop(new Error('socket hang up'));

    expect(lostNotices())
      .toEqual(['Remote SSH: connection lost (socket hang up) — reconnecting…']);
  });

  it('announces one drop once, however many layers report it', async () => {
    // On the RPC transport a dropped SSH connection takes the tunnel with it,
    // so `client.onClose` and `onRpcClose` both fire for one event. Both
    // announcing stacked two toasts on the most ordinary disconnect there is.
    const { drop } = makePlugin();

    await drop(new Error('socket hang up'));
    await drop(new Error('socket hang up'));

    expect(lostNotices(), 'the second report is the same failure').toHaveLength(1);
  });

  it('passes the retry budget through rather than inventing one', async () => {
    const { drop, startReconnect } = makePlugin({ reconnectMaxRetries: 7 });

    await drop();

    expect(startReconnect).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 7 }) as unknown as ReconnectOpts,
    );
  });

  it('stands down, and says so, when auto-reconnect is switched off', async () => {
    const { drop, startReconnect, restore } = makePlugin({ reconnectMaxRetries: 0 });

    await drop(new Error('host unreachable'));

    expect(lostNotices())
      .toEqual(['Remote SSH: connection lost (host unreachable). Auto-reconnect is off.']);
    expect(startReconnect, 'and no loop is started').not.toHaveBeenCalled();
    expect(restore, 'the adapter is handed back so reads fall through to disk')
      .toHaveBeenCalled();
  });

  it('does nothing at all with no profile to reconnect to', async () => {
    const { p, drop, startReconnect } = makePlugin();
    (p.conn as { activeProfile: unknown }).activeProfile = null;

    await drop(new Error('socket hang up'));

    expect(lostNotices()).toEqual([]);
    expect(startReconnect).not.toHaveBeenCalled();
  });
});

describe('RemoteSshPlugin.startReconnect — what the manager is handed', () => {
  it('gives the hooks a live adapter, not one captured at wiring time', async () => {
    // `rebind` carries the vault prefix. Replacing this getter with
    // `() => null` makes it the silent no-op it was before, and a transport
    // downgrade then writes beside the vault instead of in it.
    const { drop, startReconnect, dataAdapter } = makePlugin();
    await drop();

    const opts = startReconnect.mock.calls[0][0] as ReconnectOpts;
    const binding = { client: {}, remoteBase: 'work/Vault' } as unknown as RemoteBinding;
    opts.hooks.rebind(binding);

    expect(dataAdapter.rebind).toHaveBeenCalledWith(binding);
  });

  it('routes the reconnecting flag to the adapter that queues writes', async () => {
    const { drop, startReconnect, dataAdapter } = makePlugin();
    await drop();

    const opts = startReconnect.mock.calls[0][0] as ReconnectOpts;
    opts.setAdapterReconnecting(true);

    expect(dataAdapter.setReconnecting).toHaveBeenCalledWith(true);
  });
});

describe('RemoteSshPlugin.restartDaemon', () => {
  it('tears the session down through the manager before bringing it back', async () => {
    // Closing the wire from here instead left the manager's own reasoning about
    // who hung up out of the loop, so the restart announced itself as a lost
    // connection and started a reconnect that raced it.
    const { plugin, teardownRpcSession, startRpcSession } = makePlugin();
    const order: string[] = [];
    teardownRpcSession.mockImplementation(() => {
      order.push('teardown'); return Promise.resolve();
    });
    startRpcSession.mockImplementation(() => {
      order.push('start'); return Promise.resolve();
    });

    await plugin.restartDaemon();

    expect(order).toEqual(['teardown', 'start']);
    expect(lostNotices(), 'a restart the user asked for is not a lost connection').toEqual([]);
  });

  it('rebinds the adapter to the daemon that came back', async () => {
    const { plugin, dataAdapter } = makePlugin();

    await plugin.restartDaemon();

    expect(dataAdapter.rebind).toHaveBeenCalledWith(
      expect.objectContaining({ remoteBase: 'v' }) as unknown as RemoteBinding,
    );
  });
});

describe('RemoteSshPlugin.startReconnect — catching up on the gap', () => {
  type OnState = (s: { kind: string }) => void;

  async function recover(opts: { watched?: boolean; indexed?: boolean; lazy?: boolean } = {}) {
    const made = makePlugin(opts.lazy === false ? { lazyFolderLoad: false } : {});
    const replayOfflineQueue = vi.fn(() => new Promise<void>(() => { /* never settles */ }));
    (made.p.adapterMgr as Record<string, unknown>).replayOfflineQueue = replayOfflineQueue;
    (made.p.fsChangeListener as Record<string, unknown>).isSubscribed = () => opts.watched ?? true;
    made.p.vaultIndexed = opts.indexed ?? true;
    const startBackgroundIndex = vi.fn();
    made.p.startBackgroundIndex = startBackgroundIndex;
    made.p.statusBar = { update: vi.fn() };
    await made.drop(new Error('socket hang up'));
    // What the drop saw; the reconnect itself tears the subscription down.
    (made.p.fsChangeListener as Record<string, unknown>).isSubscribed = () => false;
    const { onState } = made.startReconnect.mock.calls[0][0] as { onState: OnState };
    return { ...made, startBackgroundIndex, replayOfflineQueue, onState };
  }

  it('re-walks the remote tree once the session is back, silently', async () => {
    // fs.watch only reaches live subscribers: anything created, edited or
    // removed on the remote while the wire was down produced no event.
    const { onState, startBackgroundIndex } = await recover();

    onState({ kind: 'recovered' });

    expect(startBackgroundIndex).toHaveBeenCalledExactlyOnceWith({ announce: 'never' });
  });

  it('does not wait for the offline replay, which can sit on a modal', async () => {
    // Queued edits are protected by the walk's skip filter instead.
    const { onState, replayOfflineQueue, startBackgroundIndex } = await recover();

    onState({ kind: 'recovered' });

    expect(replayOfflineQueue).toHaveBeenCalledWith('after-reconnect');
    expect(startBackgroundIndex).toHaveBeenCalledOnce();
  });

  it('announces the walk when it is what completes an interrupted lazy index', async () => {
    const { onState, startBackgroundIndex } = await recover({ indexed: false });

    onState({ kind: 'recovered' });

    expect(startBackgroundIndex).toHaveBeenCalledExactlyOnceWith({ announce: 'always' });
  });

  it('never announces in eager mode, which has no index to complete', async () => {
    const { onState, startBackgroundIndex } = await recover({ indexed: false, lazy: false });

    onState({ kind: 'recovered' });

    expect(startBackgroundIndex).toHaveBeenCalledExactlyOnceWith({ announce: 'never' });
  });

  it('does not re-walk when no watch was live at the drop (SFTP)', async () => {
    const { onState, startBackgroundIndex } = await recover({ watched: false });

    onState({ kind: 'recovered' });

    expect(startBackgroundIndex).not.toHaveBeenCalled();
  });

  it('finishes an interrupted lazy index even without a watch, announcing it', async () => {
    // The drop cancelled it; nothing else would restart it this session.
    const { onState, startBackgroundIndex } = await recover({ watched: false, indexed: false });

    onState({ kind: 'recovered' });

    expect(startBackgroundIndex).toHaveBeenCalledExactlyOnceWith({ announce: 'always' });
  });

  it('a catch-up cancelled by a later drop still runs after it, watch or not', async () => {
    // The session in between came back without a watch (SFTP); the first
    // outage's changes are still unreconciled.
    const { p, plugin, onState, startBackgroundIndex, startReconnect } = await recover();
    onState({ kind: 'recovered' });
    (p.fsChangeListener as Record<string, unknown>).isSubscribed = () => false;

    await (plugin as unknown as { startReconnect(c?: Error): Promise<void> }).startReconnect(new Error('again'));
    const { onState: onState2 } = startReconnect.mock.calls[1][0] as { onState: (s: { kind: string }) => void };
    onState2({ kind: 'recovered' });

    expect(startBackgroundIndex).toHaveBeenCalledTimes(2);
  });

  it('a completed pass settles the missed events', async () => {
    const { p, plugin, onState, startBackgroundIndex, startReconnect } = await recover();
    onState({ kind: 'recovered' });                       // catch-up walk #1
    const indexer = { cancel: vi.fn() };
    p.backgroundIndexer = indexer;
    p.settings = { ...(p.settings as object), lazyFolderLoad: false };
    (plugin as unknown as { onIndexComplete(i: unknown, r: unknown): void })
      .onIndexComplete(indexer, { viaFastPath: true, modified: 0, removed: 0, complete: true });

    await (plugin as unknown as { startReconnect(c?: Error): Promise<void> }).startReconnect(new Error('again'));
    const { onState: onState2 } = startReconnect.mock.calls[1][0] as { onState: (s: { kind: string }) => void };
    onState2({ kind: 'recovered' });

    expect(startBackgroundIndex, 'no second walk: nothing was missed since').toHaveBeenCalledOnce();
  });

  it('an incomplete pass leaves the missed events owed', async () => {
    // Truncated, a folder that would not list, or degraded: removals never ran.
    const { p, plugin, onState, startBackgroundIndex, startReconnect } = await recover();
    onState({ kind: 'recovered' });
    const indexer = { cancel: vi.fn() };
    p.backgroundIndexer = indexer;
    p.settings = { ...(p.settings as object), lazyFolderLoad: false };
    (plugin as unknown as { onIndexComplete(i: unknown, r: unknown): void })
      .onIndexComplete(indexer, { viaFastPath: true, modified: 0, removed: 0, complete: false });

    await (plugin as unknown as { startReconnect(c?: Error): Promise<void> }).startReconnect(new Error('again'));
    const { onState: onState2 } = startReconnect.mock.calls[1][0] as { onState: (s: { kind: string }) => void };
    onState2({ kind: 'recovered' });

    expect(startBackgroundIndex).toHaveBeenCalledTimes(2);
  });

  it.each(['attempting', 'failed', 'cancelled'])('does not re-walk on %s', async (kind) => {
    const { onState, startBackgroundIndex } = await recover();

    onState({ kind, attempt: 1, totalAttempts: 3, reason: 'x' } as never);

    expect(startBackgroundIndex).not.toHaveBeenCalled();
  });

  it.each([['with', true], ['without', false]] as const)(
    'cancels the running index when the connection drops, %s a profile', async (_l, withProfile) => {
      // Its walker rides the dead transport, and its skip filter predates any
      // edit queued during the outage.
      const made = makePlugin();
      if (!withProfile) (made.p.conn as Record<string, unknown>).activeProfile = null;
      const cancel = vi.fn();
      made.p.backgroundIndexer = { cancel };

      await made.drop(new Error('socket hang up'));

      expect(cancel).toHaveBeenCalledOnce();
      expect(made.p.backgroundIndexer).toBeNull();
    });
});

describe('RemoteSshPlugin background index plumbing', () => {
  type Internals = {
    startBackgroundIndex(o?: { announce?: string }): void;
    onIndexProgress(i: unknown, p: Record<string, unknown>, announce: string): void;
    onIndexComplete(i: unknown, r: Record<string, unknown>): void;
  };

  function plugin(settings: Record<string, unknown> = {}) {
    const { plugin, p } = makePlugin(settings);
    p.statusBar = { update: vi.fn() };
    p.state = 'connected';
    return { internals: plugin as unknown as Internals, p };
  }

  it('starts no index unless connected (populate can still be running when the wire drops)', () => {
    const { internals, p } = plugin();
    p.state = 'reconnecting';
    indexerDeps.length = 0;

    internals.startBackgroundIndex();

    expect(indexerDeps).toHaveLength(0);
  });

  it('hands the indexer the queued-offline-edit filter as `skip` and `keep`', () => {
    const { internals, p } = plugin();
    const filter = { skip: (path: string) => path === 'new.md', keep: (path: string) => path === 'a' };
    (p.adapterMgr as Record<string, unknown>).pendingOfflineFilter = () => filter;
    indexerDeps.length = 0;

    internals.startBackgroundIndex();

    expect(indexerDeps[0].skip).toBe(filter.skip);
    expect(indexerDeps[0].keep).toBe(filter.keep);
  });

  it.each([
    ['if-added', 3, 1], ['if-added', 0, 0], ['always', 3, 1], ['always', 0, 1], ['never', 3, 0],
  ] as const)('announce=%s with %i added → %i completion notice(s)', (announce, added, notices) => {
    const { internals, p } = plugin();
    const indexer = {};
    p.backgroundIndexer = indexer;
    p.modelEntries = () => [];

    internals.onIndexProgress(indexer, { done: true, cancelled: false, files: added, folders: 0 }, announce);

    expect(recordedNotices().filter((n) => /index complete/.test(n))).toHaveLength(notices);
  });

  it.each(['if-added', 'always'])('a pass that failed announces nothing (announce=%s)', (announce) => {
    const { internals, p } = plugin();
    const indexer = {};
    p.backgroundIndexer = indexer;
    p.modelEntries = () => [];

    internals.onIndexProgress(indexer, { done: true, cancelled: false, failed: true, files: 5, folders: 0 }, announce);

    expect(recordedNotices().filter((n) => /index complete/.test(n))).toHaveLength(0);
  });

  it('reports the vault totals, not just what the last pass added', () => {
    // A restarted index may add only the 200 files the dropped one missed.
    const { internals, p } = plugin();
    const indexer = {};
    p.backgroundIndexer = indexer;
    p.modelEntries = () => [
      { path: 'a', isDirectory: true }, { path: 'a/1.md', isDirectory: false }, { path: '2.md', isDirectory: false },
    ];

    internals.onIndexProgress(indexer, { done: true, cancelled: false, files: 1, folders: 0 }, 'always');

    expect(recordedNotices().find((n) => /index complete/.test(n))).toMatch(/2 files, 1 folders/);
  });

  it('a silent pass shows no progress in the status bar', () => {
    const { internals, p } = plugin();
    const indexer = {};
    p.backgroundIndexer = indexer;

    internals.onIndexProgress(indexer, { done: false, cancelled: false, files: 10, folders: 2 }, 'never');

    expect((p.statusBar as { update: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled();
  });

  it.each([[false, 1], [true, 0]] as const)(
    'a fallback completion with an earlier completion=%s deletes the snapshot %i time(s)', async (earlier, deletes) => {
      // A later pass on the slow path must not throw away the snapshot an
      // earlier fast-path pass of the same session saved.
      const { deleteTreeSnapshot } = await import('../src/vault/TreeSnapshot');
      vi.mocked(deleteTreeSnapshot).mockClear();
      const { internals, p } = plugin();
      const indexer = {};
      Object.assign(p, { backgroundIndexer: indexer, vaultIndexed: earlier, snapshotFiles: null });

      internals.onIndexComplete(indexer, { viaFastPath: false, modified: 0, removed: 0 });

      expect(deleteTreeSnapshot).toHaveBeenCalledTimes(deletes);
    });

  it('a fast-path completion retires the restored snapshot files', () => {
    // Their stats are real now; a later fallback pass must not zero them.
    const { internals, p } = plugin();
    const indexer = {};
    Object.assign(p, { backgroundIndexer: indexer, snapshotFiles: new Set(['a.md']), modelEntries: () => [] });

    internals.onIndexComplete(indexer, { viaFastPath: true, modified: 0, removed: 0 });

    expect(p.snapshotFiles).toBeNull();
  });

  it('records completion but writes no snapshot in eager mode', () => {
    const { internals, p } = plugin({ lazyFolderLoad: false });
    const indexer = {};
    const modelEntries = vi.fn(() => []);
    Object.assign(p, { backgroundIndexer: indexer, vaultIndexed: false, modelEntries });

    internals.onIndexComplete(indexer, { viaFastPath: true, modified: 0, removed: 0 });

    expect(p.vaultIndexed).toBe(true);
    expect(modelEntries).not.toHaveBeenCalled();
  });
});
