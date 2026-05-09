import { describe, it, expect, vi } from 'vitest';
import { FsChangeListener } from '../src/vault/FsChangeListener';
import type { App } from 'obsidian';
import type { RpcConnection } from '../src/transport/RpcConnection';
import type { SftpDataAdapter } from '../src/adapter/SftpDataAdapter';
import type { PathMapper } from '../src/path/PathMapper';

function makeApp(): App {
  return {
    vault: {
      adapter: {
        stat: vi.fn().mockResolvedValue({ type: 'file', ctime: 0, mtime: 0, size: 0 }),
      },
      trigger: vi.fn(),
      fileMap: new Map(),
    },
  } as unknown as App;
}

function makeRpc() {
  return {
    onNotification: vi.fn().mockReturnValue(() => {}),
    call: vi.fn().mockResolvedValue({ subscriptionId: 'sub-abc' }),
  };
}

function makeRpcConnection(rpc = makeRpc()): RpcConnection {
  return { rpc } as unknown as RpcConnection;
}

function makeAdapter(): SftpDataAdapter {
  return { invalidateRemotePath: vi.fn() } as unknown as SftpDataAdapter;
}

function makePathMapper(): PathMapper {
  return {
    toRemotePath: vi.fn((vp: string) => `/remote/${vp}`),
    toVaultPath: vi.fn((rp: string) => rp.replace('/remote/', '')),
  } as unknown as PathMapper;
}

describe('FsChangeListener.hasContext', () => {
  it('returns false before any subscribe call', () => {
    const listener = new FsChangeListener(makeApp());
    expect(listener.hasContext()).toBe(false);
  });

  it('returns true after a successful subscribe', async () => {
    const listener = new FsChangeListener(makeApp());
    await listener.subscribe({
      rpcConnection: makeRpcConnection(),
      dataAdapter: makeAdapter(),
      pathMapper: makePathMapper(),
    });
    expect(listener.hasContext()).toBe(true);
  });

  it('remains true after prepareForReconnect because lastPathMapper is preserved', async () => {
    const listener = new FsChangeListener(makeApp());
    await listener.subscribe({
      rpcConnection: makeRpcConnection(),
      dataAdapter: makeAdapter(),
      pathMapper: makePathMapper(),
    });
    listener.prepareForReconnect();
    expect(listener.hasContext()).toBe(true);
  });

  it('returns false after unsubscribe clears lastPathMapper', async () => {
    const listener = new FsChangeListener(makeApp());
    await listener.subscribe({
      rpcConnection: makeRpcConnection(),
      dataAdapter: makeAdapter(),
      pathMapper: makePathMapper(),
    });
    listener.unsubscribe(null);
    expect(listener.hasContext()).toBe(false);
  });
});

describe('FsChangeListener.subscribe', () => {
  it('registers an fs.changed handler and calls fs.watch', async () => {
    const rpc = makeRpc();
    const listener = new FsChangeListener(makeApp());
    await listener.subscribe({
      rpcConnection: makeRpcConnection(rpc),
      dataAdapter: makeAdapter(),
      pathMapper: makePathMapper(),
    });
    expect(rpc.onNotification).toHaveBeenCalledWith('fs.changed', expect.any(Function));
    expect(rpc.call).toHaveBeenCalledWith('fs.watch', { path: '', recursive: true });
  });

  it('is idempotent — a second call while subscribed is a no-op', async () => {
    const rpc = makeRpc();
    const listener = new FsChangeListener(makeApp());
    await listener.subscribe({
      rpcConnection: makeRpcConnection(rpc),
      dataAdapter: makeAdapter(),
      pathMapper: makePathMapper(),
    });
    const callsBefore = rpc.call.mock.calls.length;
    await listener.subscribe({
      rpcConnection: makeRpcConnection(rpc),
      dataAdapter: makeAdapter(),
      pathMapper: makePathMapper(),
    });
    expect(rpc.call.mock.calls.length).toBe(callsBefore);
  });

  it('calls the disposer when fs.watch fails to clean up the handler', async () => {
    const disposer = vi.fn();
    const rpc = {
      onNotification: vi.fn().mockReturnValue(disposer),
      call: vi.fn().mockRejectedValue(new Error('fs.watch rejected')),
    };
    const listener = new FsChangeListener(makeApp());
    await listener.subscribe({
      rpcConnection: makeRpcConnection(rpc),
      dataAdapter: makeAdapter(),
      pathMapper: makePathMapper(),
    });
    expect(disposer).toHaveBeenCalled();
  });
});

describe('FsChangeListener.prepareForReconnect', () => {
  it('calls the handler disposer so the old handler is removed', async () => {
    const disposer = vi.fn();
    const rpc = {
      onNotification: vi.fn().mockReturnValue(disposer),
      call: vi.fn().mockResolvedValue({ subscriptionId: 'sub-xyz' }),
    };
    const listener = new FsChangeListener(makeApp());
    await listener.subscribe({
      rpcConnection: makeRpcConnection(rpc),
      dataAdapter: makeAdapter(),
      pathMapper: makePathMapper(),
    });
    listener.prepareForReconnect();
    expect(disposer).toHaveBeenCalled();
  });

  it('allows subscribe to be called again after prepareForReconnect', async () => {
    const rpc1 = makeRpc();
    const listener = new FsChangeListener(makeApp());
    await listener.subscribe({
      rpcConnection: makeRpcConnection(rpc1),
      dataAdapter: makeAdapter(),
      pathMapper: makePathMapper(),
    });
    listener.prepareForReconnect();

    const rpc2 = makeRpc();
    await listener.subscribe({
      rpcConnection: makeRpcConnection(rpc2),
      dataAdapter: makeAdapter(),
      pathMapper: makePathMapper(),
    });
    expect(rpc2.call).toHaveBeenCalledWith('fs.watch', expect.any(Object));
  });
});

describe('FsChangeListener.resumeAfterReconnect', () => {
  it('is a no-op when subscribe was never called', async () => {
    const rpc = makeRpc();
    const listener = new FsChangeListener(makeApp());
    await listener.resumeAfterReconnect({
      rpcConnection: makeRpcConnection(rpc),
      dataAdapter: makeAdapter(),
    });
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it('re-subscribes after prepareForReconnect using the saved pathMapper', async () => {
    const rpc1 = makeRpc();
    const listener = new FsChangeListener(makeApp());
    await listener.subscribe({
      rpcConnection: makeRpcConnection(rpc1),
      dataAdapter: makeAdapter(),
      pathMapper: makePathMapper(),
    });
    listener.prepareForReconnect();

    const rpc2 = makeRpc();
    await listener.resumeAfterReconnect({
      rpcConnection: makeRpcConnection(rpc2),
      dataAdapter: makeAdapter(),
    });
    expect(rpc2.call).toHaveBeenCalledWith('fs.watch', expect.any(Object));
  });
});

describe('FsChangeListener.unsubscribe', () => {
  it('is safe to call before any subscribe', () => {
    const rpc = makeRpc();
    expect(() => {
      new FsChangeListener(makeApp()).unsubscribe(makeRpcConnection(rpc));
    }).not.toThrow();
  });

  it('sends fs.unwatch to the daemon when a subscriptionId is active', async () => {
    const rpc = makeRpc();
    const listener = new FsChangeListener(makeApp());
    await listener.subscribe({
      rpcConnection: makeRpcConnection(rpc),
      dataAdapter: makeAdapter(),
      pathMapper: makePathMapper(),
    });
    listener.unsubscribe(makeRpcConnection(rpc));
    expect(rpc.call).toHaveBeenCalledWith('fs.unwatch', { subscriptionId: 'sub-abc' });
  });

  it('skips the fs.unwatch call when rpcConnection is null', async () => {
    const rpc = makeRpc();
    const listener = new FsChangeListener(makeApp());
    await listener.subscribe({
      rpcConnection: makeRpcConnection(rpc),
      dataAdapter: makeAdapter(),
      pathMapper: makePathMapper(),
    });
    const callsBefore = rpc.call.mock.calls.length;
    listener.unsubscribe(null);
    // No additional rpc.call for unwatch
    expect(rpc.call.mock.calls.length).toBe(callsBefore);
  });
});
