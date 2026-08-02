import { describe, it, expect, vi } from 'vitest';
import {
  LocalWriteWatcher,
  makeLocalWriteIgnore,
  type LocalFileStat,
} from '../src/adapter/LocalWriteWatcher';

/**
 * Harness: an in-memory local disk (`files`), a manual debounce timer
 * (`tick()` fires it and drains the microtask queue), and spies for
 * the two remote-facing deps.
 *
 * The watcher pushes only after TWO consecutive samples agree, so a
 * settled file needs `tick()` twice — that is the stability rule, not
 * an accident of the harness, and the tests assert it directly.
 */
function harness(files: Record<string, string> = {}, maxBytes = 1024 * 1024) {
  let onChange: ((rel: string | null) => void) | null = null;
  let pending: (() => void) | null = null;
  let closed = false;
  const mtimes: Record<string, number> = {};
  for (const p of Object.keys(files)) mtimes[p] = 1000;

  const push = vi.fn(async (_rel: string, _data: Buffer) => {});
  const removeRemote = vi.fn(async (_rel: string) => {});
  const onError = vi.fn((_rel: string, _msg: string) => {});

  const w = new LocalWriteWatcher({
    watch: (cb) => { onChange = cb; return { close: () => { closed = true; } }; },
    scan: () => Object.keys(files),
    stat: (rel): LocalFileStat | null =>
      rel in files ? { size: files[rel].length, mtimeMs: mtimes[rel] } : null,
    read: (rel) => (rel in files ? Buffer.from(files[rel]) : null),
    push,
    removeRemote,
    ignore: makeLocalWriteIgnore('.obsidian', ['.git', 'node_modules']),
    maxBytes,
    debounceMs: 400,
    setTimer: (cb) => { pending = cb; return 1; },
    clearTimer: () => { pending = null; },
    onError,
  });

  return {
    w, push, removeRemote, onError,
    trigger: (rel: string | null) => onChange?.(rel),
    /** Fire the pending debounce and let the async flush settle. */
    tick: async () => {
      const p = pending;
      pending = null;
      p?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    hasTimer: () => pending !== null,
    isClosed: () => closed,
    write: (rel: string, body: string) => {
      files[rel] = body;
      mtimes[rel] = (mtimes[rel] ?? 1000) + 1;
    },
    unlink: (rel: string) => { delete files[rel]; },
  };
}

describe('LocalWriteWatcher', () => {
  it('pushes a file a plugin wrote under the vault root (#429)', async () => {
    const h = harness();
    h.w.start();
    h.write('note.md', '# hello');
    h.trigger('note.md');

    await h.tick();
    expect(h.push, 'pushed on the first sample — the stability rule is gone').not.toHaveBeenCalled();

    await h.tick();
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][0]).toBe('note.md');
    expect(h.push.mock.calls[0][1].toString()).toBe('# hello');
  });

  it('does not push a file that is still growing', async () => {
    const h = harness();
    h.w.start();
    h.write('big.md', 'aaa');
    h.trigger('big.md');
    await h.tick();

    // A subprocess is still streaming it out: the second sample differs.
    h.write('big.md', 'aaabbb');
    await h.tick();
    expect(h.push, 'pushed a half-written file').not.toHaveBeenCalled();

    // Now it has settled.
    await h.tick();
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][1].toString()).toBe('aaabbb');
  });

  it('does not re-push unchanged bytes on a repeated event', async () => {
    const h = harness({ 'note.md': 'body' });
    h.w.start();
    h.trigger('note.md');
    await h.tick();
    await h.tick();
    expect(h.push).toHaveBeenCalledTimes(1);

    h.trigger('note.md');
    await h.tick();
    await h.tick();
    expect(h.push, 'the ledger did not suppress an echo of our own push').toHaveBeenCalledTimes(1);
  });

  it('ignores the config tree, VCS dirs and editor temp files', async () => {
    const h = harness({
      '.obsidian/app.json': '{}',
      '.git/HEAD': 'ref',
      'node_modules/pkg/index.js': 'x',
      '.DS_Store': 'junk',
      'note.md~': 'backup',
    });
    h.w.start();
    for (const p of ['.obsidian/app.json', '.git/HEAD', 'node_modules/pkg/index.js', '.DS_Store', 'note.md~']) {
      h.trigger(p);
    }
    expect(h.hasTimer(), 'an ignored path armed the debounce').toBe(false);
    await h.tick();
    await h.tick();
    expect(h.push).not.toHaveBeenCalled();
  });

  it('deletes on the remote ONLY for a path it pushed itself', async () => {
    const h = harness();
    h.w.start();

    // A file that was never ours simply disappearing must not touch the remote.
    h.trigger('someone-elses.md');
    await h.tick();
    await h.tick();
    expect(h.removeRemote).not.toHaveBeenCalled();

    // One we pushed, then deleted locally, does propagate.
    h.write('ours.md', 'x');
    h.trigger('ours.md');
    await h.tick();
    await h.tick();
    expect(h.push).toHaveBeenCalledTimes(1);

    h.unlink('ours.md');
    h.trigger('ours.md');
    await h.tick();
    expect(h.removeRemote).toHaveBeenCalledWith('ours.md');
  });

  it('skips a file over the size cap and reports it once', async () => {
    const h = harness({}, 8);
    h.w.start();
    h.write('huge.bin', 'x'.repeat(64));
    h.trigger('huge.bin');
    await h.tick();
    await h.tick();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledTimes(1);

    h.trigger('huge.bin');
    await h.tick();
    await h.tick();
    expect(h.onError, 'the same oversized file was reported twice').toHaveBeenCalledTimes(1);
  });

  it('re-scans when the platform reports an event with no filename', async () => {
    const h = harness({ 'note.md': 'body', '.obsidian/app.json': '{}' });
    h.w.start();
    h.trigger(null);
    await h.tick();
    await h.tick();
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][0]).toBe('note.md');
  });

  it('surfaces a failed push and retries it on the next change', async () => {
    const h = harness();
    h.w.start();
    h.push.mockRejectedValueOnce(new Error('socket closed'));
    h.write('note.md', 'v1');
    h.trigger('note.md');
    await h.tick();
    await h.tick();
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.w.pushedCount(), 'a failed push was recorded as done').toBe(0);

    h.write('note.md', 'v2');
    h.trigger('note.md');
    await h.tick();
    await h.tick();
    expect(h.push).toHaveBeenCalledTimes(2);
    expect(h.w.pushedCount()).toBe(1);
  });

  it('stop() closes the watcher and drops pending work', () => {
    const h = harness({ 'note.md': 'body' });
    h.w.start();
    h.trigger('note.md');
    expect(h.hasTimer()).toBe(true);
    h.w.stop();
    expect(h.isClosed()).toBe(true);
    expect(h.hasTimer()).toBe(false);
  });
});

describe('makeLocalWriteIgnore', () => {
  const ignore = makeLocalWriteIgnore('.obsidian', ['.git', 'node_modules']);

  it('keeps ordinary notes and attachments', () => {
    expect(ignore('note.md')).toBe(false);
    expect(ignore('folder/sub/note.md')).toBe(false);
    expect(ignore('attachments/diagram.png')).toBe(false);
    expect(ignore('.hidden-but-real.md')).toBe(false);
  });

  it('prunes the config dir, trash, VCS and dependency dirs at any depth', () => {
    expect(ignore('.obsidian/app.json')).toBe(true);
    expect(ignore('.trash/old.md')).toBe(true);
    expect(ignore('.git/HEAD')).toBe(true);
    expect(ignore('project/node_modules/pkg/index.js')).toBe(true);
  });

  it('prunes OS junk, editor swap files and the atomic-write temp suffix', () => {
    expect(ignore('.DS_Store')).toBe(true);
    expect(ignore('folder/Thumbs.db')).toBe(true);
    expect(ignore('note.md~')).toBe(true);
    expect(ignore('.#note.md')).toBe(true);
    expect(ignore('note.md.swp')).toBe(true);
    expect(ignore('note.md.rsh_tmp')).toBe(true);
  });

  it('honours a non-default configDir', () => {
    const custom = makeLocalWriteIgnore('.config-dir', []);
    expect(custom('.config-dir/app.json')).toBe(true);
    expect(custom('.obsidian/app.json')).toBe(false);
  });
});
