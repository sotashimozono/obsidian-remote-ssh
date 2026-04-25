import { describe, it, expect, vi } from 'vitest';
import { SftpRemoteFsClient } from '../src/adapter/SftpRemoteFsClient';
import type { SftpClient } from '../src/ssh/SftpClient';
import type { RemoteEntry, RemoteStat } from '../src/types';

/**
 * SftpRemoteFsClient is a pure delegation layer — every method forwards
 * to the matching SftpClient method, no transformation. The tests just
 * confirm each method name is wired through so a future rename on
 * either side is noticed immediately.
 */
function mockSftp(): { client: SftpClient; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => (...args: unknown[]): Promise<unknown> => {
    calls[name] = args;
    return Promise.resolve(undefined);
  };
  const client: Partial<SftpClient> = {
    isAlive: vi.fn(() => true),
    onClose: vi.fn(() => () => { /* disposer */ }),
    stat: record('stat') as SftpClient['stat'],
    exists: record('exists') as SftpClient['exists'],
    list: record('list') as SftpClient['list'],
    readBinary: record('readBinary') as SftpClient['readBinary'],
    writeBinary: record('writeBinary') as SftpClient['writeBinary'],
    mkdirp: record('mkdirp') as SftpClient['mkdirp'],
    remove: record('remove') as SftpClient['remove'],
    rmdir: record('rmdir') as SftpClient['rmdir'],
    rename: record('rename') as SftpClient['rename'],
    copy: record('copy') as SftpClient['copy'],
  };
  return { client: client as SftpClient, calls };
}

describe('SftpRemoteFsClient', () => {
  it('forwards lifecycle methods', () => {
    const { client } = mockSftp();
    const wrap = new SftpRemoteFsClient(client);
    expect(wrap.isAlive()).toBe(true);
    const disposer = wrap.onClose(() => { /* noop */ });
    expect(typeof disposer).toBe('function');
    expect((client.isAlive as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
    expect((client.onClose as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it('forwards read-side methods with the same argument', async () => {
    const { client, calls } = mockSftp();
    // Give each return value a plausible shape so TS narrowing works downstream.
    client.stat = vi.fn(async (_: string): Promise<RemoteStat> => ({
      isDirectory: false, isFile: true, isSymbolicLink: false,
      mtime: 1, size: 0, mode: 0,
    }));
    client.list = vi.fn(async (_: string): Promise<RemoteEntry[]> => []);
    client.readBinary = vi.fn(async (_: string) => Buffer.alloc(0));
    client.exists = vi.fn(async (_: string) => true);

    const wrap = new SftpRemoteFsClient(client);
    await wrap.stat('note.md');
    await wrap.exists('note.md');
    await wrap.list('docs');
    await wrap.readBinary('img.png');

    expect((client.stat as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual(['note.md']);
    expect((client.exists as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual(['note.md']);
    expect((client.list as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual(['docs']);
    expect((client.readBinary as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual(['img.png']);
    void calls;
  });

  it('forwards write-side methods with the same arguments', async () => {
    const { client, calls } = mockSftp();
    const wrap = new SftpRemoteFsClient(client);
    const buf = Buffer.from([1, 2, 3]);

    await wrap.writeBinary('a.bin', buf);
    await wrap.mkdirp('docs/sub');
    await wrap.remove('trash.md');
    await wrap.rmdir('empty-dir', true);
    await wrap.rename('old.md', 'new.md');
    await wrap.copy('src.md', 'dst.md');

    expect(calls.writeBinary).toEqual(['a.bin', buf]);
    expect(calls.mkdirp).toEqual(['docs/sub']);
    expect(calls.remove).toEqual(['trash.md']);
    expect(calls.rmdir).toEqual(['empty-dir', true]);
    expect(calls.rename).toEqual(['old.md', 'new.md']);
    expect(calls.copy).toEqual(['src.md', 'dst.md']);
  });

  it('rmdir defaults recursive to undefined when caller omits it', async () => {
    const { client, calls } = mockSftp();
    const wrap = new SftpRemoteFsClient(client);
    await wrap.rmdir('empty-dir');
    expect(calls.rmdir).toEqual(['empty-dir', undefined]);
  });
});
