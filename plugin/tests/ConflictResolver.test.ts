import { describe, it, expect, vi } from 'vitest';
import { ConflictResolver, type TextConflictDecision } from '../src/conflict/ConflictResolver';
import { AncestorTracker } from '../src/conflict/AncestorTracker';
import { ReadCache } from '../src/cache/ReadCache';
import type { RemoteFsClient } from '../src/adapter/RemoteFsClient';
import type { RemoteStat } from '../src/types';

// ─── minimal fake client ─────────────────────────────────────────────────────

function makeClient(overrides: Partial<RemoteFsClient> = {}): RemoteFsClient {
  return {
    isAlive:    () => true,
    onClose:    () => () => {},
    stat:       async () => ({ isFile: true, isDirectory: false, isSymbolicLink: false, mtime: 1000, size: 10, mode: 0o644 } as RemoteStat),
    exists:     async () => true,
    list:       async () => [],
    readBinary: async () => Buffer.from('remote content'),
    writeBinary:async () => {},
    mkdirp:     async () => {},
    remove:     async () => {},
    rmdir:      async () => {},
    rename:     async () => {},
    copy:       async () => {},
    ...overrides,
  };
}

const ORIGINAL_ERROR = new Error('PreconditionFailed');
const MINE           = Buffer.from('my edit');
const REMOTE_PATH    = 'vault/note.md';
const NORM_PATH      = 'note.md';

// ─── swapClient ──────────────────────────────────────────────────────────────

describe('ConflictResolver.swapClient', () => {
  it('switches the client used for subsequent resolves', async () => {
    const tracker = new AncestorTracker();
    tracker.remember(NORM_PATH, 'ancestor text', 500);

    const firstWrite  = vi.fn(async () => {});
    const secondWrite = vi.fn(async () => {});

    const first  = makeClient({ writeBinary: firstWrite });
    const second = makeClient({ writeBinary: secondWrite });

    const resolver = new ConflictResolver(
      first,
      new ReadCache(),
      tracker,
      async () => ({ decision: 'keep-mine' }),
      null,
    );

    resolver.swapClient(second);
    await resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, true, ORIGINAL_ERROR);

    expect(firstWrite).not.toHaveBeenCalled();
    expect(secondWrite).toHaveBeenCalledWith(REMOTE_PATH, MINE, undefined);
  });
});

// ─── 3-way text conflict ─────────────────────────────────────────────────────

describe('ConflictResolver.resolve — 3-way text path', () => {
  function makeText3Way(
    decision: () => Promise<TextConflictDecision>,
    clientOverrides?: Partial<RemoteFsClient>,
  ) {
    const tracker = new AncestorTracker();
    tracker.remember(NORM_PATH, 'ancestor text', 500);
    const cache   = new ReadCache();
    const client  = makeClient(clientOverrides);
    const resolver = new ConflictResolver(
      client,
      cache,
      tracker,
      decision,
      null,
    );
    return { resolver, cache, tracker, client };
  }

  it('keep-mine: writes mine to remote and returns mine', async () => {
    const writeSpy = vi.fn(async () => {});
    const { resolver } = makeText3Way(
      async () => ({ decision: 'keep-mine' }),
      { writeBinary: writeSpy },
    );
    const result = await resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, true, ORIGINAL_ERROR);
    expect(result).toBe(MINE);
    expect(writeSpy).toHaveBeenCalledWith(REMOTE_PATH, MINE);
  });

  it('merged: writes merged content and returns the merged buffer', async () => {
    const writeSpy = vi.fn(async () => {});
    const { resolver } = makeText3Way(
      async () => ({ decision: 'merged', content: 'hand-merged result' }),
      { writeBinary: writeSpy },
    );
    const result = await resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, true, ORIGINAL_ERROR);
    expect(result.toString('utf8')).toBe('hand-merged result');
    expect(writeSpy).toHaveBeenCalledWith(
      REMOTE_PATH,
      Buffer.from('hand-merged result', 'utf8'),
    );
  });

  it('keep-theirs: updates read cache, updates ancestor, and rethrows originalError', async () => {
    const remoteBuf = Buffer.from('their version');
    const statSpy   = vi.fn(async (): Promise<RemoteStat> => ({ isFile: true, isDirectory: false, isSymbolicLink: false, mtime: 9999, size: 13, mode: 0o644 }));
    const { resolver, cache, tracker } = makeText3Way(
      async () => ({ decision: 'keep-theirs' }),
      { readBinary: async () => remoteBuf, stat: statSpy },
    );
    await expect(resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, true, ORIGINAL_ERROR))
      .rejects.toBe(ORIGINAL_ERROR);
    // Cache must reflect the remote version.
    expect(cache.get(REMOTE_PATH)?.data).toEqual(remoteBuf);
    expect(cache.get(REMOTE_PATH)?.mtime).toBe(9999);
    // Ancestor must be updated to the remote content.
    expect(tracker.get(NORM_PATH)?.content).toBe('their version');
    expect(tracker.get(NORM_PATH)?.mtime).toBe(9999);
  });

  it('keep-theirs: stat failure is best-effort — still updates cache with mtime 0', async () => {
    const remoteBuf = Buffer.from('their version');
    const { resolver, cache } = makeText3Way(
      async () => ({ decision: 'keep-theirs' }),
      {
        readBinary: async () => remoteBuf,
        stat: async () => { throw new Error('stat failed'); },
      },
    );
    await expect(resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, true, ORIGINAL_ERROR))
      .rejects.toBe(ORIGINAL_ERROR);
    expect(cache.get(REMOTE_PATH)?.mtime).toBe(0);
  });

  it('cancel: rethrows originalError', async () => {
    const { resolver } = makeText3Way(async () => ({ decision: 'cancel' }));
    await expect(resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, true, ORIGINAL_ERROR))
      .rejects.toBe(ORIGINAL_ERROR);
  });

  it('onTextConflict rejection is treated as cancel — rethrows originalError', async () => {
    const { resolver } = makeText3Way(async () => { throw new Error('modal closed'); });
    await expect(resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, true, ORIGINAL_ERROR))
      .rejects.toBe(ORIGINAL_ERROR);
  });

  it('readBinary failure falls back to two-choice modal (no onWriteConflict → rethrows)', async () => {
    const tracker = new AncestorTracker();
    tracker.remember(NORM_PATH, 'ancestor', 500);
    const resolver = new ConflictResolver(
      makeClient({ readBinary: async () => { throw new Error('SFTP fail'); } }),
      new ReadCache(),
      tracker,
      async () => ({ decision: 'keep-mine' }),
      null, // no onWriteConflict
    );
    await expect(resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, true, ORIGINAL_ERROR))
      .rejects.toBe(ORIGINAL_ERROR);
  });

  it('readBinary failure falls back to two-choice modal (onWriteConflict true → returns mine)', async () => {
    const writeSpy = vi.fn(async () => {});
    const tracker  = new AncestorTracker();
    tracker.remember(NORM_PATH, 'ancestor', 500);
    const resolver = new ConflictResolver(
      makeClient({ readBinary: async () => { throw new Error('SFTP fail'); }, writeBinary: writeSpy }),
      new ReadCache(),
      tracker,
      async () => ({ decision: 'keep-mine' }),
      async () => true,
    );
    const result = await resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, true, ORIGINAL_ERROR);
    expect(result).toBe(MINE);
    expect(writeSpy).toHaveBeenCalledWith(REMOTE_PATH, MINE);
  });

  it('ancestor === null falls through to two-choice modal', async () => {
    // tracker has no entry for NORM_PATH → ancestor is null.
    const resolver = new ConflictResolver(
      makeClient(),
      new ReadCache(),
      new AncestorTracker(),    // empty — no ancestor
      async () => ({ decision: 'keep-mine' }),
      async () => false,        // user cancels
    );
    await expect(resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, true, ORIGINAL_ERROR))
      .rejects.toBe(ORIGINAL_ERROR);
  });
});

// ─── two-choice fallback ─────────────────────────────────────────────────────

describe('ConflictResolver.resolve — two-choice fallback (binary / no ancestor callback)', () => {
  it('no onWriteConflict → rethrows originalError', async () => {
    const resolver = new ConflictResolver(
      makeClient(), new ReadCache(), null, null, null,
    );
    await expect(resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, false, ORIGINAL_ERROR))
      .rejects.toBe(ORIGINAL_ERROR);
  });

  it('onWriteConflict returns false → rethrows originalError', async () => {
    const resolver = new ConflictResolver(
      makeClient(), new ReadCache(), null, null, async () => false,
    );
    await expect(resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, false, ORIGINAL_ERROR))
      .rejects.toBe(ORIGINAL_ERROR);
  });

  it('onWriteConflict rejects → treated as false → rethrows originalError', async () => {
    const resolver = new ConflictResolver(
      makeClient(), new ReadCache(), null, null,
      async () => { throw new Error('modal error'); },
    );
    await expect(resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, false, ORIGINAL_ERROR))
      .rejects.toBe(ORIGINAL_ERROR);
  });

  it('onWriteConflict returns true → writes mine and returns mine', async () => {
    const writeSpy = vi.fn(async () => {});
    const resolver = new ConflictResolver(
      makeClient({ writeBinary: writeSpy }),
      new ReadCache(), null, null, async () => true,
    );
    const result = await resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, false, ORIGINAL_ERROR);
    expect(result).toBe(MINE);
    expect(writeSpy).toHaveBeenCalledWith(REMOTE_PATH, MINE);
  });

  it('binary content (isText=false) always takes two-choice path even with ancestorTracker wired', async () => {
    const tracker = new AncestorTracker();
    tracker.remember(NORM_PATH, 'ancestor', 500);
    const onTextConflict = vi.fn(async (): Promise<TextConflictDecision> => ({ decision: 'keep-mine' }));
    const resolver = new ConflictResolver(
      makeClient(), new ReadCache(), tracker, onTextConflict, async () => false,
    );
    await expect(resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, false, ORIGINAL_ERROR))
      .rejects.toBe(ORIGINAL_ERROR);
    expect(onTextConflict).not.toHaveBeenCalled();
  });

  it('no ancestorTracker takes two-choice path even when isText=true', async () => {
    const onTextConflict = vi.fn(async (): Promise<TextConflictDecision> => ({ decision: 'keep-mine' }));
    const resolver = new ConflictResolver(
      makeClient(), new ReadCache(), null, onTextConflict, async () => false,
    );
    await expect(resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, true, ORIGINAL_ERROR))
      .rejects.toBe(ORIGINAL_ERROR);
    expect(onTextConflict).not.toHaveBeenCalled();
  });

  it('no onTextConflict takes two-choice path even when isText=true and ancestor exists', async () => {
    const tracker = new AncestorTracker();
    tracker.remember(NORM_PATH, 'ancestor', 500);
    const resolver = new ConflictResolver(
      makeClient(), new ReadCache(), tracker, null, async () => false,
    );
    await expect(resolver.resolve(NORM_PATH, REMOTE_PATH, MINE, true, ORIGINAL_ERROR))
      .rejects.toBe(ORIGINAL_ERROR);
  });
});
