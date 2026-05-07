import { App } from 'obsidian';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FsChangeListener } from '../src/vault/FsChangeListener';

function makeRpcConnection() {
  const off = vi.fn();
  const onNotification = vi.fn(() => off);
  const call = vi.fn();
  return {
    rpcConnection: { rpc: { onNotification, call } },
    onNotification,
    call,
    off,
  };
}

describe('FsChangeListener lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('subscribe registers handler and fs.watch once, then is idempotent', async () => {
    const listener = new FsChangeListener(new App());
    const { rpcConnection, onNotification, call } = makeRpcConnection();
    call.mockResolvedValue({ subscriptionId: 'sub-1' });
    const dataAdapter = { invalidateRemotePath: vi.fn() };
    const pathMapper = { toRemotePath: vi.fn(), toVaultPath: vi.fn() };

    await listener.subscribe({
      rpcConnection: rpcConnection as never,
      dataAdapter: dataAdapter as never,
      pathMapper: pathMapper as never,
    });
    await listener.subscribe({
      rpcConnection: rpcConnection as never,
      dataAdapter: dataAdapter as never,
      pathMapper: pathMapper as never,
    });

    expect(listener.hasContext()).toBe(true);
    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('fs.watch', { path: '', recursive: true });
  });

  it('prepareForReconnect disposes live handler but keeps context for resume', async () => {
    const listener = new FsChangeListener(new App());
    const first = makeRpcConnection();
    first.call.mockResolvedValue({ subscriptionId: 'sub-1' });
    const dataAdapter = { invalidateRemotePath: vi.fn() };
    const pathMapper = { toRemotePath: vi.fn(), toVaultPath: vi.fn() };

    await listener.subscribe({
      rpcConnection: first.rpcConnection as never,
      dataAdapter: dataAdapter as never,
      pathMapper: pathMapper as never,
    });
    listener.prepareForReconnect();
    expect(first.off).toHaveBeenCalledTimes(1);
    expect(listener.hasContext()).toBe(true);

    const second = makeRpcConnection();
    second.call.mockResolvedValue({ subscriptionId: 'sub-2' });
    await listener.resumeAfterReconnect({
      rpcConnection: second.rpcConnection as never,
      dataAdapter: dataAdapter as never,
    });

    expect(second.call).toHaveBeenCalledWith('fs.watch', { path: '', recursive: true });
  });

  it('unsubscribe sends fs.unwatch and clears local context', async () => {
    const listener = new FsChangeListener(new App());
    const { rpcConnection, call, off } = makeRpcConnection();
    call.mockResolvedValue({ subscriptionId: 'sub-1' });
    const dataAdapter = { invalidateRemotePath: vi.fn() };
    const pathMapper = { toRemotePath: vi.fn(), toVaultPath: vi.fn() };

    await listener.subscribe({
      rpcConnection: rpcConnection as never,
      dataAdapter: dataAdapter as never,
      pathMapper: pathMapper as never,
    });
    call.mockClear();

    listener.unsubscribe(rpcConnection as never);

    expect(call).toHaveBeenCalledWith('fs.unwatch', { subscriptionId: 'sub-1' });
    expect(off).toHaveBeenCalledTimes(1);
    expect(listener.hasContext()).toBe(false);
  });

  it('subscribe disposes the notification handler when fs.watch call rejects', async () => {
    const listener = new FsChangeListener(new App());
    const { rpcConnection, onNotification, call, off } = makeRpcConnection();
    // First call rejects, second succeeds — verifies subscribe is not blocked after failure
    call.mockRejectedValueOnce(new Error('connection refused'));
    call.mockResolvedValue({ subscriptionId: 'sub-1' });
    const dataAdapter = { invalidateRemotePath: vi.fn() };
    const pathMapper = { toRemotePath: vi.fn(), toVaultPath: vi.fn() };

    vi.spyOn(console, 'error').mockImplementation(() => {}); // suppress logger output

    await listener.subscribe({
      rpcConnection: rpcConnection as never,
      dataAdapter: dataAdapter as never,
      pathMapper: pathMapper as never,
    });

    // Handler was registered then disposed to prevent leaks
    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
    // pathMapper captured before rpc.call, so hasContext is true (resume remains possible)
    expect(listener.hasContext()).toBe(true);

    // subscriptionId was never set → a retry subscribe() goes through (not blocked)
    await listener.subscribe({
      rpcConnection: rpcConnection as never,
      dataAdapter: dataAdapter as never,
      pathMapper: pathMapper as never,
    });
    expect(onNotification).toHaveBeenCalledTimes(2);
  });
});
