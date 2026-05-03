import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { RemoteShell } from '../src/ssh/RemoteShell';
import type { SftpClient } from '../src/ssh/SftpClient';
import type { ClientChannel } from 'ssh2';

/**
 * Minimal stand-in for an ssh2 ClientChannel:
 *   - `data`/`error`/`close` events surface via the EventEmitter
 *   - `stderr` is its own EventEmitter (matches ssh2's shape)
 *   - `write` / `setWindow` / `end` are spy functions so tests can assert call shape
 */
function makeFakeChannel() {
  const ch = new EventEmitter() as EventEmitter & Partial<ClientChannel> & {
    stderr: EventEmitter;
    write: ReturnType<typeof vi.fn>;
    setWindow: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  ch.stderr = new EventEmitter();
  ch.write = vi.fn();
  ch.setWindow = vi.fn();
  ch.end = vi.fn(() => { ch.emit('close'); });
  return ch;
}

function makeFakeClient(channel: ReturnType<typeof makeFakeChannel>) {
  return {
    openShell: vi.fn().mockResolvedValue(channel as unknown as ClientChannel),
  } as unknown as SftpClient;
}

describe('RemoteShell', () => {
  let onData: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onData = vi.fn();
    onClose = vi.fn();
  });

  describe('open()', () => {
    it('forwards row/col/term/cmd to SftpClient.openShell', async () => {
      const ch = makeFakeChannel();
      const client = makeFakeClient(ch);
      const shell = new RemoteShell(client, { onData, onClose });

      await shell.open({ rows: 30, cols: 100, term: 'xterm', cmd: '/usr/bin/zsh -l' });

      expect(client.openShell).toHaveBeenCalledWith({
        rows: 30, cols: 100, term: 'xterm', cmd: '/usr/bin/zsh -l',
      });
      expect(shell.isOpen()).toBe(true);
    });

    it('rejects when called twice without close in between', async () => {
      const ch = makeFakeChannel();
      const client = makeFakeClient(ch);
      const shell = new RemoteShell(client, { onData, onClose });
      await shell.open({ rows: 24, cols: 80 });

      await expect(shell.open({ rows: 24, cols: 80 })).rejects.toThrow(/already open/);
    });

    it('rejects when called after close', async () => {
      const ch = makeFakeChannel();
      const client = makeFakeClient(ch);
      const shell = new RemoteShell(client, { onData, onClose });
      await shell.open({ rows: 24, cols: 80 });
      shell.close();

      await expect(shell.open({ rows: 24, cols: 80 })).rejects.toThrow(/already closed/);
    });

    // Regression: HIGH-1 from PR #234 self-review. Two concurrent
    // open() callers used to both pass the `if (this.channel)` guard
    // because it ran BEFORE the await — both would allocate channels
    // server-side, only the second `this.channel = ch` survived, the
    // first leaked. The synchronous `opening` flag closes that gap.
    it('rejects a second open() called concurrently while the first is still pending', async () => {
      const ch = makeFakeChannel();
      const client = makeFakeClient(ch);
      let resolveFirst!: (c: ClientChannel) => void;
      (client.openShell as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => new Promise<ClientChannel>(r => { resolveFirst = r; }),
      );
      const shell = new RemoteShell(client, { onData, onClose });

      const firstOpen = shell.open({ rows: 24, cols: 80 });
      // Yield once so the synchronous portion of `open()` has run
      // (the `this.opening = true` assignment + the await).
      await Promise.resolve();
      await expect(shell.open({ rows: 24, cols: 80 })).rejects.toThrow(/already opening/);

      // Let the first open complete cleanly so the test doesn't dangle.
      resolveFirst(ch as unknown as ClientChannel);
      await firstOpen;
      expect(shell.isOpen()).toBe(true);
    });

    // Regression: HIGH-2 from PR #234 self-review. If close() ran
    // while open()'s await was pending, `this.closed` was set but the
    // channel still got assigned + listeners attached when the await
    // resolved — and nobody ever called end() on it. Channel leak.
    it('end()s the channel if close() runs while open() is awaiting', async () => {
      const ch = makeFakeChannel();
      const client = makeFakeClient(ch);
      let resolveOpen!: (c: ClientChannel) => void;
      (client.openShell as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => new Promise<ClientChannel>(r => { resolveOpen = r; }),
      );
      const shell = new RemoteShell(client, { onData, onClose });

      const openPromise = shell.open({ rows: 24, cols: 80 });
      await Promise.resolve();
      shell.close();
      resolveOpen(ch as unknown as ClientChannel);
      await openPromise;

      expect(ch.end).toHaveBeenCalledTimes(1);
      expect(shell.isOpen()).toBe(false);
      // Listeners must NOT have been attached: post-resolve `data`
      // events should not call onData. (close() set `this.closed`
      // before the channel was assigned, so the listener-attach
      // branch was bypassed entirely.)
      ch.emit('data', Buffer.from('post-close', 'utf8'));
      expect(onData).not.toHaveBeenCalled();
    });
  });

  describe('data flow', () => {
    it('forwards stdout `data` events to onData', async () => {
      const ch = makeFakeChannel();
      const shell = new RemoteShell(makeFakeClient(ch), { onData, onClose });
      await shell.open({ rows: 24, cols: 80 });

      const chunk = Buffer.from('hello\r\n', 'utf8');
      ch.emit('data', chunk);

      expect(onData).toHaveBeenCalledTimes(1);
      expect(onData).toHaveBeenCalledWith(chunk);
    });

    it('forwards stderr `data` events to the same onData callback', async () => {
      const ch = makeFakeChannel();
      const shell = new RemoteShell(makeFakeClient(ch), { onData, onClose });
      await shell.open({ rows: 24, cols: 80 });

      const errChunk = Buffer.from('command not found\n', 'utf8');
      ch.stderr.emit('data', errChunk);

      expect(onData).toHaveBeenCalledWith(errChunk);
    });

    it('write() pipes through to channel.write', async () => {
      const ch = makeFakeChannel();
      const shell = new RemoteShell(makeFakeClient(ch), { onData, onClose });
      await shell.open({ rows: 24, cols: 80 });

      shell.write('ls -la\r');
      expect(ch.write).toHaveBeenCalledWith('ls -la\r');
    });

    it('write() is a no-op if channel was never opened', () => {
      const ch = makeFakeChannel();
      const shell = new RemoteShell(makeFakeClient(ch), { onData, onClose });

      shell.write('lost keystroke');
      expect(ch.write).not.toHaveBeenCalled();
    });

    it('write() is a no-op after close', async () => {
      const ch = makeFakeChannel();
      const shell = new RemoteShell(makeFakeClient(ch), { onData, onClose });
      await shell.open({ rows: 24, cols: 80 });
      shell.close();

      shell.write('post-close');
      expect(ch.write).not.toHaveBeenCalled();
    });
  });

  describe('resize()', () => {
    it('forwards rows/cols to channel.setWindow with 0 pixel dims', async () => {
      const ch = makeFakeChannel();
      const shell = new RemoteShell(makeFakeClient(ch), { onData, onClose });
      await shell.open({ rows: 24, cols: 80 });

      shell.resize(40, 120);

      expect(ch.setWindow).toHaveBeenCalledWith(40, 120, 0, 0);
    });

    it('survives a setWindow throw without crashing the wrapper', async () => {
      const ch = makeFakeChannel();
      ch.setWindow = vi.fn(() => { throw new Error('channel gone'); });
      const shell = new RemoteShell(makeFakeClient(ch), { onData, onClose });
      await shell.open({ rows: 24, cols: 80 });

      expect(() => shell.resize(40, 120)).not.toThrow();
      expect(shell.isOpen()).toBe(true);
    });
  });

  describe('close lifecycle', () => {
    it('remote-side close fires onClose with reason "remote-eof"', async () => {
      const ch = makeFakeChannel();
      const shell = new RemoteShell(makeFakeClient(ch), { onData, onClose });
      await shell.open({ rows: 24, cols: 80 });

      ch.emit('close');

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith('remote-eof');
      expect(shell.isOpen()).toBe(false);
    });

    it('channel error fires onClose with reason "error" + cause', async () => {
      const ch = makeFakeChannel();
      const shell = new RemoteShell(makeFakeClient(ch), { onData, onClose });
      await shell.open({ rows: 24, cols: 80 });

      const err = new Error('connection reset');
      ch.emit('error', err);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith('error', err);
      expect(shell.isOpen()).toBe(false);
    });

    it('local close() does NOT re-fire onClose after remote close', async () => {
      const ch = makeFakeChannel();
      const shell = new RemoteShell(makeFakeClient(ch), { onData, onClose });
      await shell.open({ rows: 24, cols: 80 });

      ch.emit('close');
      shell.close();

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('local close() suppresses subsequent data events', async () => {
      const ch = makeFakeChannel();
      const shell = new RemoteShell(makeFakeClient(ch), { onData, onClose });
      await shell.open({ rows: 24, cols: 80 });
      shell.close();

      ch.emit('data', Buffer.from('late', 'utf8'));
      ch.stderr.emit('data', Buffer.from('also late', 'utf8'));

      expect(onData).not.toHaveBeenCalled();
    });

    it('close() before open() is a no-op (idempotent)', () => {
      const ch = makeFakeChannel();
      const shell = new RemoteShell(makeFakeClient(ch), { onData, onClose });

      expect(() => shell.close()).not.toThrow();
      expect(onClose).not.toHaveBeenCalled();
      expect(shell.isOpen()).toBe(false);
    });
  });
});
