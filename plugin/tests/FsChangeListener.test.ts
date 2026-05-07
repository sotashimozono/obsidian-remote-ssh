import { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
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
});
