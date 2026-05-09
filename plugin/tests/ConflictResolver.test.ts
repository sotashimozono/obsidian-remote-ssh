import { describe, it, expect, vi } from 'vitest';
import { ConflictResolver } from '../src/conflict/ConflictResolver';
import type { RemoteFsClient } from '../src/adapter/RemoteFsClient';
import type { ReadCache } from '../src/cache/ReadCache';
import type { AncestorTracker } from '../src/conflict/AncestorTracker';
import type { TextConflictDecision } from '../src/conflict/ConflictResolver';

function makeClient(overrides: Partial<RemoteFsClient> = {}): RemoteFsClient {
  return {
    readBinary: vi.fn().mockResolvedValue(Buffer.from('theirs')),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtime: 1000, size: 6 }),
    ...overrides,
  } as unknown as RemoteFsClient;
}

function makeReadCache(): ReadCache {
  return { put: vi.fn(), get: vi.fn(), invalidate: vi.fn() } as unknown as ReadCache;
}

function makeTracker(ancestorContent: string | null): AncestorTracker {
  return {
    get: vi.fn().mockReturnValue(
      ancestorContent !== null ? { content: ancestorContent, mtime: 0 } : null,
    ),
    remember: vi.fn(),
  } as unknown as AncestorTracker;
}

const remote = '/remote/path/file.md';
const normalizedPath = 'file.md';
const originalError = new Error('PreconditionFailed');
const mine = Buffer.from('my content');

describe('ConflictResolver.swapClient', () => {
  it('replaces the client used for subsequent operations', async () => {
    const client1 = makeClient();
    const client2 = makeClient({
      writeBinary: vi.fn().mockResolvedValue(undefined),
    });
    const resolver = new ConflictResolver(
      client1, makeReadCache(), makeTracker('ancestor'), null, async () => true,
    );
    resolver.swapClient(client2);

    const result = await resolver.resolve(normalizedPath, remote, mine, false, originalError);
    expect(result).toBe(mine);
    expect(client2.writeBinary).toHaveBeenCalled();
    expect(client1.writeBinary).not.toHaveBeenCalled();
  });
});

describe('ConflictResolver.resolve — two-choice fallback paths', () => {
  it('falls back to two-choice when ancestorTracker is null', async () => {
    const onWriteConflict = vi.fn().mockResolvedValue(true);
    const resolver = new ConflictResolver(makeClient(), makeReadCache(), null, null, onWriteConflict);
    const result = await resolver.resolve(normalizedPath, remote, mine, true, originalError);
    expect(result).toBe(mine);
    expect(onWriteConflict).toHaveBeenCalledWith(normalizedPath);
  });

  it('falls back to two-choice when onTextConflict is null', async () => {
    const onWriteConflict = vi.fn().mockResolvedValue(true);
    const resolver = new ConflictResolver(
      makeClient(), makeReadCache(), makeTracker('ancestor'), null, onWriteConflict,
    );
    const result = await resolver.resolve(normalizedPath, remote, mine, true, originalError);
    expect(result).toBe(mine);
  });

  it('falls back to two-choice for binary writes (isText=false)', async () => {
    const onWriteConflict = vi.fn().mockResolvedValue(true);
    const resolver = new ConflictResolver(
      makeClient(), makeReadCache(), makeTracker('ancestor'), vi.fn(), onWriteConflict,
    );
    const result = await resolver.resolve(normalizedPath, remote, mine, false, originalError);
    expect(result).toBe(mine);
    expect(onWriteConflict).toHaveBeenCalled();
  });

  it('falls back to two-choice when tracker.get returns null (no ancestor snapshot)', async () => {
    const onWriteConflict = vi.fn().mockResolvedValue(true);
    const resolver = new ConflictResolver(
      makeClient(), makeReadCache(), makeTracker(null), vi.fn(), onWriteConflict,
    );
    const result = await resolver.resolve(normalizedPath, remote, mine, true, originalError);
    expect(result).toBe(mine);
    expect(onWriteConflict).toHaveBeenCalled();
  });

  it('throws originalError when onWriteConflict returns false', async () => {
    const onWriteConflict = vi.fn().mockResolvedValue(false);
    const resolver = new ConflictResolver(makeClient(), makeReadCache(), null, null, onWriteConflict);
    await expect(
      resolver.resolve(normalizedPath, remote, mine, false, originalError),
    ).rejects.toBe(originalError);
  });

  it('throws originalError when onWriteConflict is null (no callback at all)', async () => {
    const resolver = new ConflictResolver(makeClient(), makeReadCache(), null, null, null);
    await expect(
      resolver.resolve(normalizedPath, remote, mine, false, originalError),
    ).rejects.toBe(originalError);
  });
});

describe('ConflictResolver.resolve — three-way text conflict decisions', () => {
  it('keep-mine: writes mine to remote and returns mine', async () => {
    const client = makeClient();
    const onTextConflict = vi.fn().mockResolvedValue({ decision: 'keep-mine' } as TextConflictDecision);
    const resolver = new ConflictResolver(
      client, makeReadCache(), makeTracker('ancestor'), onTextConflict, null,
    );
    const result = await resolver.resolve(normalizedPath, remote, mine, true, originalError);
    expect(result).toBe(mine);
    expect(client.writeBinary).toHaveBeenCalledWith(remote, mine);
  });

  it('merged: writes merged content and returns the merged buffer', async () => {
    const client = makeClient();
    const mergedText = 'merged content';
    const onTextConflict = vi.fn().mockResolvedValue(
      { decision: 'merged', content: mergedText } as TextConflictDecision,
    );
    const resolver = new ConflictResolver(
      client, makeReadCache(), makeTracker('ancestor'), onTextConflict, null,
    );
    const result = await resolver.resolve(normalizedPath, remote, mine, true, originalError);
    expect(result.toString('utf8')).toBe(mergedText);
    expect(client.writeBinary).toHaveBeenCalledWith(remote, Buffer.from(mergedText, 'utf8'));
  });

  it('keep-theirs: updates readCache + ancestorTracker and re-throws originalError', async () => {
    const client = makeClient({
      readBinary: vi.fn().mockResolvedValue(Buffer.from('their-content')),
      stat: vi.fn().mockResolvedValue({ mtime: 2000, size: 13 }),
    });
    const readCache = makeReadCache();
    const tracker = makeTracker('ancestor');
    const onTextConflict = vi.fn().mockResolvedValue({ decision: 'keep-theirs' } as TextConflictDecision);
    const resolver = new ConflictResolver(client, readCache, tracker, onTextConflict, null);

    await expect(
      resolver.resolve(normalizedPath, remote, mine, true, originalError),
    ).rejects.toBe(originalError);

    expect(readCache.put).toHaveBeenCalledWith(remote, expect.any(Buffer), 2000);
    expect(tracker.remember).toHaveBeenCalledWith(normalizedPath, 'their-content', 2000);
  });

  it('keep-theirs: uses mtime=0 when stat fails', async () => {
    const client = makeClient({
      readBinary: vi.fn().mockResolvedValue(Buffer.from('their-content')),
      stat: vi.fn().mockRejectedValue(new Error('stat error')),
    });
    const readCache = makeReadCache();
    const tracker = makeTracker('ancestor');
    const onTextConflict = vi.fn().mockResolvedValue({ decision: 'keep-theirs' } as TextConflictDecision);
    const resolver = new ConflictResolver(client, readCache, tracker, onTextConflict, null);

    await expect(
      resolver.resolve(normalizedPath, remote, mine, true, originalError),
    ).rejects.toBe(originalError);

    expect(readCache.put).toHaveBeenCalledWith(remote, expect.any(Buffer), 0);
  });

  it('cancel: throws originalError without writing anything', async () => {
    const client = makeClient();
    const onTextConflict = vi.fn().mockResolvedValue({ decision: 'cancel' } as TextConflictDecision);
    const resolver = new ConflictResolver(
      client, makeReadCache(), makeTracker('ancestor'), onTextConflict, null,
    );
    await expect(
      resolver.resolve(normalizedPath, remote, mine, true, originalError),
    ).rejects.toBe(originalError);
    expect(client.writeBinary).not.toHaveBeenCalled();
  });

  it('falls back to two-choice when re-reading the remote file fails during three-way', async () => {
    const client = makeClient({
      readBinary: vi.fn().mockRejectedValue(new Error('network read error')),
    });
    const onWriteConflict = vi.fn().mockResolvedValue(true);
    const resolver = new ConflictResolver(
      client, makeReadCache(), makeTracker('ancestor'), vi.fn(), onWriteConflict,
    );
    const result = await resolver.resolve(normalizedPath, remote, mine, true, originalError);
    expect(result).toBe(mine);
    expect(onWriteConflict).toHaveBeenCalled();
  });

  it('treats onTextConflict rejection as cancel', async () => {
    const client = makeClient();
    const onTextConflict = vi.fn().mockRejectedValue(new Error('modal error'));
    const resolver = new ConflictResolver(
      client, makeReadCache(), makeTracker('ancestor'), onTextConflict, null,
    );
    await expect(
      resolver.resolve(normalizedPath, remote, mine, true, originalError),
    ).rejects.toBe(originalError);
  });
});
