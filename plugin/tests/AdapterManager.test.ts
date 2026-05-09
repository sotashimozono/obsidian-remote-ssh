import { describe, it, expect, vi } from 'vitest';
import { AdapterManager, PATCHED_METHODS } from '../src/adapter/AdapterManager';
import type { App, PluginManifest } from 'obsidian';
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
function makeManager(opts: { transferTracker?: { clear: () => void } } = {}) {
  const unsubscribeSpy = vi.fn();
  const mgr = new AdapterManager(
    {} as App,
    { id: 'remote-ssh' } as unknown as PluginManifest,
    { rpcConnection: null, activeRemoteBasePath: null } as unknown as ConnectionManager,
    { subscribe: vi.fn(), unsubscribe: unsubscribeSpy } as unknown as FsChangeListener,
    { startPolling: vi.fn() } as unknown as PendingEditsBar,
    () => ({}) as unknown as PluginSettings,
    opts.transferTracker ?? null,
  );
  return { mgr, unsubscribeSpy };
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
