import { App } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const interpretWatchEvent = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const perfTracer = {
    point: vi.fn(),
    newCid: vi.fn(() => 'cid-1'),
    begin: vi.fn(() => ({ t0: 1 })),
    end: vi.fn(),
  };
  const builderMethods = {
    insertOne: vi.fn(),
    removeOne: vi.fn(),
    modifyOne: vi.fn(),
    renameOne: vi.fn(),
  };
  const disposer = vi.fn();
  const onNotification = vi.fn(() => disposer);
  const call = vi.fn();
  return {
    interpretWatchEvent,
    logger,
    perfTracer,
    builderMethods,
    disposer,
    onNotification,
    call,
  };
});

vi.mock('../src/path/WatchEventFilter', () => ({
  interpretWatchEvent: hoisted.interpretWatchEvent,
}));

vi.mock('../src/util/logger', () => ({
  logger: hoisted.logger,
}));

vi.mock('../src/util/PerfTracer', () => ({
  perfTracer: hoisted.perfTracer,
}));

vi.mock('../src/vault/VaultModelBuilder', () => ({
  VaultModelBuilder: class {
    insertOne = hoisted.builderMethods.insertOne;
    removeOne = hoisted.builderMethods.removeOne;
    modifyOne = hoisted.builderMethods.modifyOne;
    renameOne = hoisted.builderMethods.renameOne;
  },
}));

import { FsChangeListener } from '../src/vault/FsChangeListener';

function makeListener() {
  const app = new App();
  const stat = vi.fn();
  (app.vault.adapter as unknown as { stat: typeof stat }).stat = stat;
  return { listener: new FsChangeListener(app), stat };
}

function makeRpcConnection() {
  return { rpc: { onNotification: hoisted.onNotification, call: hoisted.call } };
}

describe('FsChangeListener notification + applyChange', () => {
  beforeEach(() => {
    hoisted.interpretWatchEvent.mockReset();
    hoisted.logger.info.mockReset();
    hoisted.logger.warn.mockReset();
    hoisted.logger.error.mockReset();
    hoisted.perfTracer.point.mockReset();
    hoisted.perfTracer.newCid.mockReset();
    hoisted.perfTracer.newCid.mockReturnValue('cid-1');
    hoisted.perfTracer.begin.mockReset();
    hoisted.perfTracer.begin.mockReturnValue({ t0: 1 });
    hoisted.perfTracer.end.mockReset();
    hoisted.builderMethods.insertOne.mockReset();
    hoisted.builderMethods.removeOne.mockReset();
    hoisted.builderMethods.modifyOne.mockReset();
    hoisted.builderMethods.renameOne.mockReset();
    hoisted.disposer.mockReset();
    hoisted.onNotification.mockReset();
    hoisted.onNotification.mockReturnValue(hoisted.disposer);
    hoisted.call.mockReset();
    hoisted.call.mockResolvedValue({ subscriptionId: 'sub-1' });
  });

  it('processes fs.changed renamed notifications with old/new invalidation', async () => {
    const { listener } = makeListener();
    const dataAdapter = { invalidateRemotePath: vi.fn() };
    const applyChange = vi.spyOn(listener as unknown as { applyChange: (...args: unknown[]) => Promise<void> }, 'applyChange').mockResolvedValue();
    hoisted.interpretWatchEvent.mockImplementation((p: string) => {
      if (p === 'old.md') return { remotePath: '/remote/old.md', vaultPath: 'old.md' };
      if (p === 'new.md') return { remotePath: '/remote/new.md', vaultPath: 'new.md' };
      return null;
    });

    await listener.subscribe({
      rpcConnection: makeRpcConnection() as never,
      dataAdapter: dataAdapter as never,
      pathMapper: {} as never,
    });
    const handler = hoisted.onNotification.mock.calls[0]?.[1] as (params: {
      event: 'renamed'; path: string; newPath: string; subscriptionId: string;
    }) => void;

    handler({ event: 'renamed', path: 'old.md', newPath: 'new.md', subscriptionId: 'sub-1' });

    expect(hoisted.perfTracer.point).toHaveBeenCalledTimes(1);
    expect(dataAdapter.invalidateRemotePath).toHaveBeenCalledWith('/remote/old.md');
    expect(dataAdapter.invalidateRemotePath).toHaveBeenCalledWith('/remote/new.md');
    expect(applyChange).toHaveBeenCalledWith('old.md', 'new.md', 'renamed');
  });

  it('ignores notifications from different subscription ids', async () => {
    const { listener } = makeListener();
    const dataAdapter = { invalidateRemotePath: vi.fn() };
    const applyChange = vi.spyOn(listener as unknown as { applyChange: (...args: unknown[]) => Promise<void> }, 'applyChange').mockResolvedValue();
    hoisted.interpretWatchEvent.mockReturnValue({ remotePath: '/remote/a.md', vaultPath: 'a.md' });

    await listener.subscribe({
      rpcConnection: makeRpcConnection() as never,
      dataAdapter: dataAdapter as never,
      pathMapper: {} as never,
    });
    const handler = hoisted.onNotification.mock.calls[0]?.[1] as (params: {
      event: 'modified'; path: string; subscriptionId: string;
    }) => void;

    handler({ event: 'modified', path: 'a.md', subscriptionId: 'other-sub' });

    expect(hoisted.interpretWatchEvent).not.toHaveBeenCalled();
    expect(dataAdapter.invalidateRemotePath).not.toHaveBeenCalled();
    expect(applyChange).not.toHaveBeenCalled();
  });

  function invokeApplyChange(
    listener: FsChangeListener,
    oldPath: string,
    newPath: string | undefined,
    event: 'created' | 'modified' | 'deleted' | 'renamed',
  ): Promise<void> {
    return (listener as unknown as {
      applyChange: (o: string, n: string | undefined, e: typeof event) => Promise<void>;
    }).applyChange(oldPath, newPath, event);
  }

  it('applyChange created: inserts with stat metadata when stat succeeds', async () => {
    const { listener, stat } = makeListener();
    stat.mockResolvedValueOnce({ type: 'folder', ctime: 1, mtime: 2, size: 3 });

    await invokeApplyChange(listener, 'dir', undefined, 'created');

    expect(hoisted.builderMethods.insertOne).toHaveBeenCalledWith({
      path: 'dir',
      isDirectory: true,
      ctime: 1,
      mtime: 2,
      size: 3,
    }, { ensureParents: true });
  });

  it('applyChange created: warns and returns when stat returns null', async () => {
    const { listener, stat } = makeListener();
    stat.mockResolvedValueOnce(null);

    await invokeApplyChange(listener, 'missing.md', undefined, 'created');

    expect(hoisted.builderMethods.insertOne).not.toHaveBeenCalled();
    expect(hoisted.logger.warn).toHaveBeenCalledWith('applyChange(created): stat failed for missing.md');
  });

  it('applyChange modified: calls modifyOne with stat metadata when stat succeeds', async () => {
    const { listener, stat } = makeListener();
    stat.mockResolvedValueOnce({ type: 'file', ctime: 10, mtime: 20, size: 100 });

    await invokeApplyChange(listener, 'note.md', undefined, 'modified');

    expect(hoisted.builderMethods.modifyOne).toHaveBeenCalledWith('note.md', {
      ctime: 10,
      mtime: 20,
      size: 100,
    });
  });

  it('applyChange modified: calls modifyOne without metadata when stat returns null', async () => {
    const { listener, stat } = makeListener();
    stat.mockResolvedValueOnce(null);

    await invokeApplyChange(listener, 'note.md', undefined, 'modified');

    expect(hoisted.builderMethods.modifyOne).toHaveBeenCalledWith('note.md');
  });

  it('applyChange deleted: removes the path', async () => {
    const { listener } = makeListener();

    await invokeApplyChange(listener, 'old.md', undefined, 'deleted');

    expect(hoisted.builderMethods.removeOne).toHaveBeenCalledWith('old.md');
  });

  it('applyChange renamed: warns when newPath is missing', async () => {
    const { listener } = makeListener();

    await invokeApplyChange(listener, 'a.md', undefined, 'renamed');

    expect(hoisted.builderMethods.renameOne).not.toHaveBeenCalled();
    expect(hoisted.logger.warn).toHaveBeenCalledWith('applyChange(renamed): missing newPath for a.md');
  });

  it('applyChange renamed: renames the path when newPath is provided and ends the perf span', async () => {
    const { listener } = makeListener();

    await invokeApplyChange(listener, 'a.md', 'b.md', 'renamed');

    expect(hoisted.builderMethods.renameOne).toHaveBeenCalledWith('a.md', 'b.md');
    expect(hoisted.perfTracer.end).toHaveBeenCalled();
  });

  it('ignores notifications when interpretWatchEvent returns null (path filtered out)', async () => {
    const { listener } = makeListener();
    const dataAdapter = { invalidateRemotePath: vi.fn() };
    const applyChange = vi.spyOn(listener as unknown as { applyChange: (...args: unknown[]) => Promise<void> }, 'applyChange').mockResolvedValue();
    hoisted.interpretWatchEvent.mockReturnValue(null);

    await listener.subscribe({
      rpcConnection: makeRpcConnection() as never,
      dataAdapter: dataAdapter as never,
      pathMapper: {} as never,
    });
    const handler = hoisted.onNotification.mock.calls[0]?.[1] as (params: {
      event: 'modified'; path: string; subscriptionId: string;
    }) => void;

    handler({ event: 'modified', path: 'filtered.md', subscriptionId: 'sub-1' });

    // T4a stamps every push frame even before path filtering
    expect(hoisted.perfTracer.point).toHaveBeenCalledTimes(1);
    expect(dataAdapter.invalidateRemotePath).not.toHaveBeenCalled();
    expect(applyChange).not.toHaveBeenCalled();
  });

  it('applyChange catches builder failures and logs warnings', async () => {
    const { listener } = makeListener();
    hoisted.builderMethods.removeOne.mockImplementation(() => {
      throw new Error('boom');
    });

    await (listener as unknown as { applyChange: (...args: unknown[]) => Promise<void> })
      .applyChange('bad.md', undefined, 'deleted');

    expect(hoisted.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('applyChange(deleted) failed for bad.md: boom'),
    );
  });
});
