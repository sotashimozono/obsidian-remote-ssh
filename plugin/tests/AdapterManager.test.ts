import { describe, it, expect, vi } from 'vitest';
import type { SftpDataAdapter } from '../src/adapter/SftpDataAdapter';
import type { PathMapper } from '../src/path/PathMapper';
import { AdapterManager, PATCHED_METHODS } from '../src/adapter/AdapterManager';
import * as path from 'node:path';
import { FileSystemAdapter } from 'obsidian';
import type { App, PluginManifest } from 'obsidian';
import { OfflineQueue } from '../src/offline/OfflineQueue';
import type { ConnectionManager } from '../src/ConnectionManager';
import type { FsChangeListener } from '../src/vault/FsChangeListener';
import type { PendingEditsBar } from '../src/ui/PendingEditsBar';
import type { PluginSettings } from '../src/types';

/**
 * Build a minimal AdapterManager with all constructor deps mocked at
 * the typescript type boundary. The deps are only accessed when the
 * adapter is _patched_ — the tests below never call patch(), so the
 * mocks only need the methods that are called on a fresh (un-patched)
 * instance: FsChangeListener.unsubscribe() and ConnectionManager.rpcConnection.
 */
function makeManager(
  opts: { transferTracker?: { clear: () => void }; rpcConnection?: unknown } = {},
) {
  const unsubscribeSpy = vi.fn();
  // Held as its own object so a test can swap `rpcConnection` afterwards —
  // which is what a reconnect does, and `patch()` does not run again.
  const conn = { rpcConnection: opts.rpcConnection ?? null, activeRemoteBasePath: null };
  const mgr = new AdapterManager(
    {} as App,
    { id: 'remote-ssh' } as unknown as PluginManifest,
    conn as unknown as ConnectionManager,
    { subscribe: vi.fn(), unsubscribe: unsubscribeSpy } as unknown as FsChangeListener,
    { startPolling: vi.fn() } as unknown as PendingEditsBar,
    () => ({}) as unknown as PluginSettings,
    opts.transferTracker ?? null,
  );
  return { mgr, unsubscribeSpy, conn };
}

/** A daemon handle advertising `capabilities`, with a spy for its calls. */
function rpcHandle(capabilities: string[], call = vi.fn()) {
  return { info: { capabilities }, rpc: { call } };
}

// ─── PATCHED_METHODS ─────────────────────────────────────────────────────────

describe('PATCHED_METHODS constant', () => {
  it('is a non-empty array', () => {
    expect(PATCHED_METHODS.length).toBeGreaterThan(0);
  });

  it('includes core read-side methods', () => {
    expect(PATCHED_METHODS).toContain('exists');
    expect(PATCHED_METHODS).toContain('stat');
    expect(PATCHED_METHODS).toContain('list');
    expect(PATCHED_METHODS).toContain('read');
    expect(PATCHED_METHODS).toContain('readBinary');
  });

  it('includes core write-side methods', () => {
    expect(PATCHED_METHODS).toContain('write');
    expect(PATCHED_METHODS).toContain('writeBinary');
    expect(PATCHED_METHODS).toContain('mkdir');
    expect(PATCHED_METHODS).toContain('remove');
    expect(PATCHED_METHODS).toContain('rename');
    expect(PATCHED_METHODS).toContain('copy');
  });

  it('includes getResourcePath for the binary bridge', () => {
    expect(PATCHED_METHODS).toContain('getResourcePath');
  });

  it('includes basePath / getBasePath for shadow-vault compatibility', () => {
    expect(PATCHED_METHODS).toContain('basePath');
    expect(PATCHED_METHODS).toContain('getBasePath');
  });
});

// ─── initial state ────────────────────────────────────────────────────────

describe('AdapterManager — initial state', () => {
  it('isPatched() returns false before patch() is called', () => {
    const { mgr } = makeManager();
    expect(mgr.isPatched()).toBe(false);
  });

  it('dataAdapter getter returns null before patch() is called', () => {
    const { mgr } = makeManager();
    expect(mgr.dataAdapter).toBeNull();
  });
});

// ─── replayOfflineQueue ────────────────────────────────────────────────────

describe('AdapterManager.replayOfflineQueue()', () => {
  it('returns without throwing when offlineQueue is null', async () => {
    const { mgr } = makeManager();
    await expect(mgr.replayOfflineQueue('after-connect')).resolves.toBeUndefined();
  });

  it('returns without throwing for the after-reconnect label', async () => {
    const { mgr } = makeManager();
    await expect(mgr.replayOfflineQueue('after-reconnect')).resolves.toBeUndefined();
  });
});

describe('AdapterManager.pendingOfflineFilter()', () => {
  function withQueue(ops: unknown[]) {
    const { mgr } = makeManager();
    (mgr as unknown as { offlineQueue: unknown }).offlineQueue = {
      pending: () => ops.map((op, id) => ({ id, ts: 0, op })),
    };
    return mgr;
  }

  it('is null with nothing queued', () => {
    const { mgr } = makeManager();
    expect(mgr.pendingOfflineFilter()).toBeNull();
    expect(withQueue([]).pendingOfflineFilter()).toBeNull();
  });

  it('keeps what queued ops add (and around it); skips what they remove (and under it)', () => {
    // An op that adds puts the model ahead of the remote: never remove or
    // downgrade it, but do add it if the model lacks it (written in an
    // earlier launch). An op that removes puts the remote ahead: never re-add.
    const { skip, keep } = withQueue([
      { kind: 'write', path: 'a/b/new.md', contentBase64: '' },
      { kind: 'rename', oldPath: 'old', newPath: 'x/new' },
      { kind: 'copy', srcPath: 'src.md', dstPath: 'dst.md' },
      { kind: 'remove', path: 'gone.md' },
      { kind: 'rmdir', path: 'dead', recursive: true },
      { kind: 'trashLocal', path: 'trashed.md' },
      { kind: 'mkdir', path: 'made' },
    ]).pendingOfflineFilter()!;

    for (const p of ['a/b/new.md', 'a/b', 'a', 'x/new', 'x/new/c.md', 'x', 'dst.md', 'made', 'made/n.md']) {
      expect(keep(p), `keep ${p}`).toBe(true);
      expect(skip(p), `skip ${p}`).toBe(false);
    }
    for (const p of ['old', 'old/child.md', 'gone.md', 'dead', 'dead/d.md', 'trashed.md']) {
      expect(skip(p), `skip ${p}`).toBe(true);
    }
    for (const p of ['a/b/other.md', 'a/c', 'older', 'x/other', 'b', 'src.md']) {
      expect(skip(p) || keep(p), p).toBe(false);
    }
  });
});

describe('AdapterManager.replayOfflineQueue() concurrency', () => {
  it('a call while a replay runs waits for it, then drains what is queued by then', async () => {
    // The first drain can sit on a conflict modal across a drop: edits queued
    // during that outage must still be replayed, and nothing twice.
    const { mgr } = makeManager();
    const finish: Array<() => void> = [];
    const replayed: string[] = [];
    let inFlight = 0;
    let overlapped = false;
    const replayQueuedOp = vi.fn((op: { path: string }) => {
      if (++inFlight > 1) overlapped = true;
      return new Promise<{ result: 'ok' }>((r) => finish.push(() => {
        inFlight--; replayed.push(op.path); r({ result: 'ok' });
      }));
    });
    let entries = [{ id: 1, ts: 0, op: { kind: 'mkdir', path: 'a' } }];
    Object.assign(mgr as unknown as Record<string, unknown>, {
      offlineQueue: {
        pending: () => [...entries],
        markCompleted: vi.fn(async (id: number) => { entries = entries.filter((e) => e.id !== id); }),
      },
      _dataAdapter: { replayQueuedOp },
    });

    const first = mgr.replayOfflineQueue('after-connect');
    await vi.waitFor(() => expect(finish).toHaveLength(1));
    entries.push({ id: 2, ts: 0, op: { kind: 'mkdir', path: 'b' } });
    const second = mgr.replayOfflineQueue('after-reconnect');
    finish[0]();
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    finish[1]();
    await Promise.all([first, second]);

    expect(replayed).toEqual(['a', 'b']);
    expect(overlapped, 'two drains ran at once').toBe(false);
  });

  it('after restore, a torn-down replay stops at its current op and the next session waits for it', async () => {
    // Detaching it instead would let both drains replay the same entries.
    const { mgr } = makeManager();
    let entries = [1, 2].map((id) => ({ id, ts: 0, op: { kind: 'mkdir', path: `p${id}` } }));
    const queue = {
      pending: () => [...entries],
      markCompleted: vi.fn(async (id: number) => { entries = entries.filter((e) => e.id !== id); }),
    };
    let unstick!: () => void;
    const old = {
      replayQueuedOp: vi.fn(() => new Promise<{ result: 'ok' }>((r) => { unstick = () => r({ result: 'ok' }); })),
      dispose: vi.fn(),
    };
    Object.assign(mgr as unknown as Record<string, unknown>, { offlineQueue: queue, _dataAdapter: old });
    const a = mgr.replayOfflineQueue('after-connect');           // p1 sits on a modal
    await vi.waitFor(() => expect(old.replayQueuedOp).toHaveBeenCalledOnce());

    mgr.restore();
    const next = { replayQueuedOp: vi.fn(async () => ({ result: 'ok' as const })) };
    Object.assign(mgr as unknown as Record<string, unknown>, { offlineQueue: queue, _dataAdapter: next });
    const c = mgr.replayOfflineQueue('after-connect');           // the new session's own
    await new Promise((r) => setTimeout(r, 0));
    expect(next.replayQueuedOp, 'waits for the torn-down drain').not.toHaveBeenCalled();

    unstick();
    await Promise.all([a, c]);
    expect(old.replayQueuedOp, 'the torn-down drain stops after p1').toHaveBeenCalledOnce();
    expect(next.replayQueuedOp.mock.calls.map((c) => (c[0] as { path: string }).path)).toEqual(['p2']);
  });

  it('a replay queued behind a torn-down one never runs on the next session', async () => {
    const { mgr } = makeManager();
    let entries = [{ id: 1, ts: 0, op: { kind: 'mkdir', path: 'a' } }];
    const queue = {
      pending: () => [...entries],
      markCompleted: vi.fn(async (id: number) => { entries = entries.filter((e) => e.id !== id); }),
    };
    let unstick!: () => void;
    const old = {
      replayQueuedOp: vi.fn(() => new Promise<{ result: 'ok' }>((r) => { unstick = () => r({ result: 'ok' }); })),
      dispose: vi.fn(),
    };
    Object.assign(mgr as unknown as Record<string, unknown>, { offlineQueue: queue, _dataAdapter: old });
    const a = mgr.replayOfflineQueue('after-connect');           // sits on a modal
    await vi.waitFor(() => expect(old.replayQueuedOp).toHaveBeenCalled());
    const b = mgr.replayOfflineQueue('after-reconnect');         // queued behind it

    mgr.restore();
    entries = [{ id: 2, ts: 0, op: { kind: 'mkdir', path: 'b' } }];
    const next = { replayQueuedOp: vi.fn(async () => ({ result: 'ok' as const })) };
    Object.assign(mgr as unknown as Record<string, unknown>, { offlineQueue: queue, _dataAdapter: next });
    const c = mgr.replayOfflineQueue('after-connect');           // the new session's own
    unstick();
    await Promise.all([a, b, c]);

    // Only the new session's drain replays path `b`; the stale drain queued
    // behind the torn-down one stands down instead of replaying it again.
    expect(next.replayQueuedOp, 'the stale queued drain must not replay on the new adapter').toHaveBeenCalledOnce();
  });
});

// ─── showPendingEditsModal ─────────────────────────────────────────────────

describe('AdapterManager.showPendingEditsModal()', () => {
  it('returns without throwing when no offline queue is open', async () => {
    const { mgr } = makeManager();
    await expect(mgr.showPendingEditsModal()).resolves.toBeUndefined();
  });
});

// ─── restore ──────────────────────────────────────────────────────────────

describe('AdapterManager.restore()', () => {
  it('does not throw when called before patch()', () => {
    const { mgr } = makeManager();
    expect(() => mgr.restore()).not.toThrow();
  });

  it('calls fsChangeListener.unsubscribe() once', () => {
    const { mgr, unsubscribeSpy } = makeManager();
    mgr.restore();
    expect(unsubscribeSpy).toHaveBeenCalledOnce();
  });

  it('wakes reads parked on the adapter it is about to discard', () => {
    // Those reads poll the adapter's own `reconnecting` flag (ReconnectWait).
    // Once `_dataAdapter` is null nothing can clear it — main.ts resets it via
    // `dataAdapter?.setReconnecting(false)` — so they would sit out the full
    // 30 s budget instead of failing promptly, which is what they did before
    // the wait existed. Reaching into the private field is deliberate: this is
    // teardown ordering, and there is no public seam for it.
    const { mgr } = makeManager();
    const dispose = vi.fn();
    const setReconnecting = vi.fn();
    (mgr as unknown as { _dataAdapter: unknown })._dataAdapter = { dispose, setReconnecting };

    mgr.restore();

    expect(dispose).toHaveBeenCalledOnce();
    // NOT setReconnecting(false): that would also tell the read path the
    // session is healthy, and it would hit a transport being abandoned.
    expect(setReconnecting).not.toHaveBeenCalled();
  });

  it('leaves isPatched() false after restore()', () => {
    const { mgr } = makeManager();
    mgr.restore();
    expect(mgr.isPatched()).toBe(false);
  });

  it('leaves dataAdapter null after restore()', () => {
    const { mgr } = makeManager();
    mgr.restore();
    expect(mgr.dataAdapter).toBeNull();
  });

  it('is idempotent — two calls do not throw', () => {
    const { mgr } = makeManager();
    expect(() => mgr.restore()).not.toThrow();
    expect(() => mgr.restore()).not.toThrow();
  });

  it('calls transferTracker.clear() when one is supplied', () => {
    const clearSpy = vi.fn();
    const { mgr } = makeManager({ transferTracker: { clear: clearSpy } });
    mgr.restore();
    expect(clearSpy).toHaveBeenCalledOnce();
  });
});

// ─── the pieces patch() is built from ────────────────────────────────────────
//
// Nothing had ever executed `patch()`. These three steps were lifted out of
// it so they could be reached one at a time, in the same way
// `wireKeyboardInteractiveHandler` was lifted out of `SftpClient.connect`.
// `patch()` is driven directly further down as well, with the bridge and the
// queue stubbed — which is what made it reachable at all, and is why the
// steps still earn separate cases: each one's failure mode is its own.

/** Reach a private method without widening the class's surface. */
function priv<T>(mgr: unknown, name: string): T {
  return (mgr as unknown as Record<string, T>)[name];
}

describe('AdapterManager.ensureOfflineQueue()', () => {
  function withQueue(mgr: unknown, queue: unknown, calls: { n: number }) {
    (mgr as Record<string, unknown>).openOfflineQueue = () => {
      calls.n++;
      return Promise.resolve(queue);
    };
  }

  it('opens the queue once and reuses it', async () => {
    // Reused across patches on purpose: re-opening would replay a queue that
    // has already been drained.
    const { mgr } = makeManager();
    const calls = { n: 0 };
    withQueue(mgr, { stats: () => ({ entries: 0, bytes: 0 }), pending: () => [] }, calls);

    await priv<() => Promise<void>>(mgr, 'ensureOfflineQueue').call(mgr);
    await priv<() => Promise<void>>(mgr, 'ensureOfflineQueue').call(mgr);

    expect(calls.n).toBe(1);
  });

  it('points the status bar at the queue it just opened', async () => {
    const startPolling = vi.fn();
    const mgr = new AdapterManager(
      {} as App,
      { id: 'remote-ssh' } as unknown as PluginManifest,
      { rpcConnection: null, activeRemoteBasePath: null } as unknown as ConnectionManager,
      { subscribe: vi.fn(), unsubscribe: vi.fn() } as unknown as FsChangeListener,
      { startPolling } as unknown as PendingEditsBar,
      () => ({}) as unknown as PluginSettings,
      null,
    );
    withQueue(mgr, {
      stats: () => ({ entries: 2, bytes: 10 }),
      pending: () => [{}, {}, {}],
    }, { n: 0 });

    await priv<() => Promise<void>>(mgr, 'ensureOfflineQueue').call(mgr);

    expect(startPolling).toHaveBeenCalledTimes(1);
    // The bar must read the live queue, not a count captured at wiring time.
    const read = startPolling.mock.calls[0][0] as () => number;
    expect(read()).toBe(3);
  });

  it('survives a queue that will not open, leaving offline writes to throw', async () => {
    // Louder than pretending: with no queue, an offline write raises instead
    // of being accepted and silently lost.
    const { mgr } = makeManager();
    (mgr as unknown as Record<string, unknown>).openOfflineQueue =
      () => Promise.reject(new Error('disk is full'));

    await expect(priv<() => Promise<void>>(mgr, 'ensureOfflineQueue').call(mgr))
      .resolves.toBeUndefined();
    expect((mgr as unknown as { offlineQueue: unknown }).offlineQueue).toBeNull();
  });
});

describe('AdapterManager.wireLiveUpdates()', () => {
  function fakeAdapter() {
    return {
      setWriterReflector: vi.fn(),
      setLocalOpRegistry: vi.fn(),
    } as unknown as SftpDataAdapter & {
      setWriterReflector: ReturnType<typeof vi.fn>;
      setLocalOpRegistry: ReturnType<typeof vi.fn>;
    };
  }
  const mapper = {} as PathMapper;

  it('wires the reflector so a write shows up without waiting for an echo', () => {
    const { mgr } = makeManager();
    const adapter = fakeAdapter();

    priv<(a: unknown, m: unknown) => void>(mgr, 'wireLiveUpdates').call(mgr, adapter, mapper);

    expect(adapter.setWriterReflector).toHaveBeenCalledTimes(1);
    expect(adapter.setLocalOpRegistry).toHaveBeenCalledTimes(1);
  });

  it('subscribes to fs changes only when the session is RPC', () => {
    // SFTP has no notification channel, so there is nothing to subscribe to.
    const subscribe = vi.fn();
    const mgr = new AdapterManager(
      {} as App,
      { id: 'remote-ssh' } as unknown as PluginManifest,
      { rpcConnection: null, activeRemoteBasePath: null } as unknown as ConnectionManager,
      { subscribe, unsubscribe: vi.fn() } as unknown as FsChangeListener,
      { startPolling: vi.fn() } as unknown as PendingEditsBar,
      () => ({}) as unknown as PluginSettings,
      null,
    );

    priv<(a: unknown, m: unknown) => void>(mgr, 'wireLiveUpdates').call(mgr, fakeAdapter(), mapper);

    expect(subscribe).not.toHaveBeenCalled();
  });

  it('gives the adapter and the listener the SAME registry', () => {
    // The whole echo-drop rests on this identity. Two registries and the
    // daemon's echo of our own write would no longer match anything the
    // reflector recorded, so every local write would fire twice.
    const subscribe = vi.fn();
    const mgr = new AdapterManager(
      {} as App,
      { id: 'remote-ssh' } as unknown as PluginManifest,
      { rpcConnection: {}, activeRemoteBasePath: '' } as unknown as ConnectionManager,
      { subscribe, unsubscribe: vi.fn() } as unknown as FsChangeListener,
      { startPolling: vi.fn() } as unknown as PendingEditsBar,
      () => ({}) as unknown as PluginSettings,
      null,
    );
    const adapter = fakeAdapter();

    priv<(a: unknown, m: unknown) => void>(mgr, 'wireLiveUpdates').call(mgr, adapter, mapper);

    expect(subscribe).toHaveBeenCalledTimes(1);
    const passedToAdapter = adapter.setLocalOpRegistry.mock.calls[0][0];
    const passedToListener = (subscribe.mock.calls[0][0] as { localOpRegistry: unknown }).localOpRegistry;
    expect(passedToListener).toBe(passedToAdapter);
  });
});

describe('AdapterManager.startResourceBridge()', () => {
  function fakeBridge(start: () => Promise<void>) {
    return { start: vi.fn(start) } as unknown as Parameters<
      (b: never) => void
    >[0];
  }

  it('returns the bridge once it is listening', async () => {
    const { mgr } = makeManager();
    const bridge = fakeBridge(() => Promise.resolve());

    const got = await priv<(b: unknown) => Promise<unknown>>(mgr, 'startResourceBridge')
      .call(mgr, bridge);

    expect(got).toBe(bridge);
  });

  it('hands the bridge a fetcher wired to this manager', async () => {
    // Only that the callback lands on this manager's method: it replaces the
    // method to see that. What the method itself does is a separate case
    // below, because for a while nothing drove it at all.
    const { mgr } = makeManager();
    const fetchSpy = vi.fn(async () => new Uint8Array([1]));
    (mgr as unknown as Record<string, unknown>).fetchBinaryForBridge = fetchSpy;
    let fetcher: ((p: string) => Promise<Uint8Array>) | undefined;
    const bridge = { start: async (f: unknown) => { fetcher = f as typeof fetcher; } };

    await priv<(b: unknown) => Promise<unknown>>(mgr, 'startResourceBridge').call(mgr, bridge);
    await fetcher!('notes/diagram.png');

    expect(fetchSpy).toHaveBeenCalledWith('notes/diagram.png');
  });

  it('enables the daemon fast paths when the daemon offers them', async () => {
    // Served from the daemon's resize path instead of pulling the full
    // original on every <img>. This used to stub both factories out, so the
    // "only when it advertises the method" half was the stub talking; the
    // real capability check now decides.
    const handle = rpcHandle(
      ['fs.thumbnail', 'fs.readBinaryRange'],
      vi.fn().mockResolvedValue({ contentBase64: '', format: 'png', mtime: 1, size: 0 }),
    );
    const { mgr } = makeManager({ rpcConnection: handle });
    const passed: unknown[] = [];
    const bridge = { start: async (...a: unknown[]) => { passed.push(...a); } };

    const got = await priv<(b: unknown) => Promise<unknown>>(mgr, 'startResourceBridge')
      .call(mgr, bridge);

    expect(got).toBe(bridge);
    expect(passed.filter((x) => typeof x === 'function')).toHaveLength(3);

    // Which one is which, not just how many. Counting them let the two
    // optional arguments be swapped: the bridge would then call the range
    // fetcher as `fetchThumbnail(path, maxDim)`, both fast paths would throw,
    // and the bridge catches that and pulls the whole original — silently, for
    // every image and every media seek, forever.
    const [, thumbnail, range] = passed as [
      unknown,
      (p: string, maxDim: number) => Promise<unknown>,
      (p: string, offset: number, length: number) => Promise<unknown>,
    ];
    await thumbnail('a.png', 64);
    expect(handle.rpc.call, 'the second argument is the thumbnail fetcher')
      .toHaveBeenCalledWith('fs.thumbnail', { path: 'a.png', maxDim: 64 });
    await range('b.bin', 0, 4);
    expect(handle.rpc.call, 'and the third is the range fetcher')
      .toHaveBeenCalledWith('fs.readBinaryRange', { path: 'b.bin', offset: 0, length: 4 });
  });

  it('and offers only the plain fetcher when it does not', async () => {
    const { mgr } = makeManager({ rpcConnection: rpcHandle([]) });
    const passed: unknown[] = [];
    const bridge = { start: async (...a: unknown[]) => { passed.push(...a); } };

    await priv<(b: unknown) => Promise<unknown>>(mgr, 'startResourceBridge').call(mgr, bridge);

    expect(
      passed.filter((x) => typeof x === 'function'),
      'a daemon without the methods must not be asked for them',
    ).toHaveLength(1);
  });

  it('gives up the bridge, not the session, when it cannot bind', async () => {
    // Losing the bridge costs image rendering. Letting the throw escape would
    // cost the connection, which is the worse trade.
    const { mgr } = makeManager();
    const bridge = fakeBridge(() => Promise.reject(new Error('EADDRINUSE')));

    const got = await priv<(b: unknown) => Promise<unknown>>(mgr, 'startResourceBridge')
      .call(mgr, bridge);

    expect(got).toBeNull();
  });
});

// ─── patch() itself ──────────────────────────────────────────────────────────
//
// Had never been executed by anything: not the unit suite, and — measured —
// not the integration suite either. Only the E2E run drove it, and that
// uploads no coverage. It is the step that puts this plugin in front of the
// vault, which is why these cases exist.

describe('AdapterManager.patch()', () => {
  function patchableManager() {
    // Only `app.vault` is reached, so a literal says more than a real App.
    const hostAdapter: Record<string, unknown> = { read: () => 'original' };
    const app = {
      vault: {
        adapter: hostAdapter,
        configDir: '.obsidian',
        getName: () => 'test-vault',
      },
    };
    const subscribe = vi.fn();
    const mgr = new AdapterManager(
      app as unknown as App,
      { id: 'remote-ssh' } as unknown as PluginManifest,
      {
        activeRemoteBasePath: '/home/tester/vault',
        rpcConnection: null,
        buildBinding: () => ({ client: {}, remoteBase: '/home/tester/vault' }),
      } as unknown as ConnectionManager,
      { subscribe, unsubscribe: vi.fn() } as unknown as FsChangeListener,
      { startPolling: vi.fn() } as unknown as PendingEditsBar,
      () => ({ profiles: [] }) as unknown as PluginSettings,
      null,
    );
    // The bridge binds a port and the queue touches disk; neither is what this
    // test is about, and both have their own cases above.
    const internals = mgr as unknown as Record<string, unknown>;
    internals.startResourceBridge = () => Promise.resolve(null);
    internals.openOfflineQueue = () => Promise.resolve({
      stats: () => ({ entries: 0, bytes: 0 }),
      pending: () => [],
    });
    return { mgr, hostAdapter, subscribe };
  }

  it('refuses to patch before a remote base path is known', async () => {
    // Patching against no prefix would point every read and write at the
    // remote home instead of the vault inside it.
    const { mgr } = makeManager();

    expect(await mgr.patch()).toBe(false);
    expect(mgr.isPatched()).toBe(false);
  });

  it('replaces the host adapter\'s methods and reports success', async () => {
    const { mgr, hostAdapter } = patchableManager();
    const before = hostAdapter.read;
    const originals: Record<string, unknown> = {};
    for (const m of PATCHED_METHODS) originals[m] = hostAdapter[m];

    expect(await mgr.patch()).toBe(true);

    expect(mgr.isPatched()).toBe(true);
    expect(mgr.dataAdapter).not.toBeNull();
    expect(hostAdapter.read).not.toBe(before);
    // Not all of them are functions — `basePath` is a value, which is the
    // whole point of #170: plugins read it and used to get `undefined`. So
    // every name must be present, and every one that WAS a function must now
    // be a different function: `toBeDefined` alone would pass if the patcher
    // wired two names to one handler, or left an original in place.
    for (const m of PATCHED_METHODS) {
      expect(hostAdapter[m], `${m} is installed`).toBeDefined();
      if (typeof originals[m] === 'function') {
        expect(hostAdapter[m], `${m} is the adapter's, not the host's`).not.toBe(originals[m]);
      }
    }
  });

  it('is idempotent — a second patch does not re-wrap an already-wrapped adapter', async () => {
    const { mgr, hostAdapter } = patchableManager();
    await mgr.patch();
    const afterFirst = hostAdapter.read;

    expect(await mgr.patch()).toBe(true);

    expect(hostAdapter.read).toBe(afterFirst);
  });

  it('gives the host adapter its own methods back on restore', async () => {
    const { mgr, hostAdapter } = patchableManager();
    const before = hostAdapter.read;
    await mgr.patch();

    mgr.restore();

    expect(hostAdapter.read).toBe(before);
    expect(mgr.isPatched()).toBe(false);
    expect(mgr.dataAdapter).toBeNull();
  });

  it('does not subscribe to fs changes on an SFTP session', async () => {
    const { mgr, subscribe } = patchableManager();

    await mgr.patch();

    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe('AdapterManager.openOfflineQueue()', () => {
  // Stubbed out by every other test in this file, including the `patch()`
  // block added to close exactly this kind of gap — so the real body had
  // never run. What it decides is WHERE the queue lives; get the join wrong
  // and a user's pending writes are opened somewhere else entirely, with
  // nothing failing to say so.

  function managerOn(adapter: unknown, configDir = '.obsidian') {
    return new AdapterManager(
      { vault: { adapter, configDir } } as unknown as App,
      { id: 'remote-ssh' } as unknown as PluginManifest,
      { rpcConnection: null, activeRemoteBasePath: null } as unknown as ConnectionManager,
      { subscribe: vi.fn(), unsubscribe: vi.fn() } as unknown as FsChangeListener,
      { startPolling: vi.fn() } as unknown as PendingEditsBar,
      () => ({}) as unknown as PluginSettings,
      null,
    );
  }

  it('opens the queue beside the plugin, under the vault it is serving', async () => {
    const fsAdapter = new FileSystemAdapter();
    (fsAdapter as unknown as { getBasePath: () => string }).getBasePath =
      () => '/vaults/shadow';
    const open = vi.spyOn(OfflineQueue, 'open')
      .mockResolvedValue({} as unknown as OfflineQueue);

    const mgr = managerOn(fsAdapter);
    await priv<() => Promise<unknown>>(mgr, 'openOfflineQueue').call(mgr);

    expect(open).toHaveBeenCalledWith(
      path.join('/vaults/shadow', '.obsidian', 'plugins', 'remote-ssh', 'queue'),
    );
    open.mockRestore();
  });

  it('follows a customised config directory', async () => {
    // `configDir` is a user setting; hardcoding `.obsidian` would strand the
    // queue outside the vault for anyone who changed it.
    const fsAdapter = new FileSystemAdapter();
    (fsAdapter as unknown as { getBasePath: () => string }).getBasePath = () => '/v';
    const open = vi.spyOn(OfflineQueue, 'open')
      .mockResolvedValue({} as unknown as OfflineQueue);

    const mgr = managerOn(fsAdapter, '.config-obsidian');
    await priv<() => Promise<unknown>>(mgr, 'openOfflineQueue').call(mgr);

    expect(open).toHaveBeenCalledWith(
      path.join('/v', '.config-obsidian', 'plugins', 'remote-ssh', 'queue'),
    );
    open.mockRestore();
  });

  it('refuses a vault with no local disk behind it, rather than guessing a path', async () => {
    const mgr = managerOn({ read: () => 'not a FileSystemAdapter' });

    await expect(priv<() => Promise<unknown>>(mgr, 'openOfflineQueue').call(mgr))
      .rejects.toThrow(/FileSystemAdapter/);
  });
});

describe('AdapterManager.fetchBinaryForBridge()', () => {
  // Every image, PDF and audio file in the vault is served through here. The
  // one test that named the behaviour replaced this method with a spy, so
  // nothing executed it — returning an empty array instead would have made
  // every attachment render blank with the suite still green.

  it('refuses before the adapter is patched', async () => {
    const { mgr } = makeManager();

    await expect(
      priv<(p: string) => Promise<unknown>>(mgr, 'fetchBinaryForBridge').call(mgr, 'a.png'),
    ).rejects.toThrow(/not patched/);
  });

  it('goes through the patched adapter, for its cache and path mapping', async () => {
    const { mgr } = makeManager();
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchBinaryForBridge = vi.fn().mockResolvedValue(bytes);
    (mgr as unknown as { _dataAdapter: unknown })._dataAdapter = { fetchBinaryForBridge };

    const got = await priv<(p: string) => Promise<Uint8Array>>(mgr, 'fetchBinaryForBridge')
      .call(mgr, 'notes/diagram.png');

    expect(fetchBinaryForBridge).toHaveBeenCalledWith('notes/diagram.png');
    expect(got, 'the bytes have to come back unchanged').toBe(bytes);
  });
});

describe('AdapterManager — the daemon fast paths read the live connection', () => {
  // `patch()` runs once per connect, so these closures outlive the handle
  // they were built with. A reconnect replaces `rpcConnection` underneath
  // them, and the bridge catches a failed fast path and pulls the whole
  // original instead — so a captured handle degrades silently and
  // permanently: an 8 MB JPEG per <img> where ~150 KB would do, with nothing
  // failing to say so. Both closures were at zero executions.

  it('asks whichever daemon is live now for a thumbnail', async () => {
    const stale = rpcHandle(['fs.thumbnail']);
    const { mgr, conn } = makeManager({ rpcConnection: stale });
    const fetch = priv<() => ((p: string, d: number) => Promise<unknown>) | null>(
      mgr, 'makeThumbnailFetcherIfSupported',
    ).call(mgr)!;

    const fresh = rpcHandle(['fs.thumbnail'], vi.fn().mockResolvedValue({
      contentBase64: Buffer.from([7, 8]).toString('base64'),
      format: 'png',
    }));
    conn.rpcConnection = fresh;   // the reconnect

    const got = await fetch('notes/d.png', 64);

    expect(stale.rpc.call, 'the handle it was built with is dead').not.toHaveBeenCalled();
    expect(fresh.rpc.call).toHaveBeenCalledWith('fs.thumbnail', { path: 'notes/d.png', maxDim: 64 });
    expect(got).toEqual({ bytes: new Uint8Array([7, 8]), format: 'png' });
  });

  it('asks whichever daemon is live now for a range', async () => {
    const stale = rpcHandle(['fs.readBinaryRange']);
    const { mgr, conn } = makeManager({ rpcConnection: stale });
    const fetch = priv<() => ((p: string, o: number, l: number, m?: number) => Promise<unknown>) | null>(
      mgr, 'makeBinaryRangeFetcherIfSupported',
    ).call(mgr)!;

    const fresh = rpcHandle(['fs.readBinaryRange'], vi.fn().mockResolvedValue({
      contentBase64: Buffer.from([1, 2, 3]).toString('base64'),
      mtime: 42,
      size: 3,
    }));
    conn.rpcConnection = fresh;

    const got = await fetch('big.bin', 0, 3);

    expect(stale.rpc.call).not.toHaveBeenCalled();
    expect(fresh.rpc.call).toHaveBeenCalledWith(
      'fs.readBinaryRange', { path: 'big.bin', offset: 0, length: 3 },
    );
    expect(got).toEqual({ bytes: new Uint8Array([1, 2, 3]), mtime: 42, totalSize: 3 });

    // And the generation pin, when the bridge has one. Dropping it from the
    // params passed every test: the daemon would never raise
    // PreconditionFailed, and a file edited during a media seek would serve
    // bytes spliced from two generations (#171).
    await fetch('big.bin', 0, 3, 1234);
    expect(fresh.rpc.call).toHaveBeenCalledWith(
      'fs.readBinaryRange', { path: 'big.bin', offset: 0, length: 3, expectedMtime: 1234 },
    );
  });

  it('falls back to the handle it was built with when there is no live one', async () => {
    // Between a drop and a successful reconnect `rpcConnection` is null, and
    // an in-flight <img> request still has to be answered.
    const built = rpcHandle(['fs.thumbnail'], vi.fn().mockResolvedValue({
      contentBase64: '', format: 'jpeg',
    }));
    const { mgr, conn } = makeManager({ rpcConnection: built });
    const fetch = priv<() => ((p: string, d: number) => Promise<unknown>) | null>(
      mgr, 'makeThumbnailFetcherIfSupported',
    ).call(mgr)!;

    conn.rpcConnection = null;
    await fetch('a.png', 32);

    expect(built.rpc.call).toHaveBeenCalled();
  });
});
