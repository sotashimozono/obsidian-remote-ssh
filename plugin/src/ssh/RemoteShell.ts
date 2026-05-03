import type { ClientChannel } from 'ssh2';
import type { SftpClient } from './SftpClient';
import { asError, errorMessage } from '../util/errorMessage';
import { logger } from '../util/logger';

/**
 * Thin lifecycle wrapper around an ssh2 shell channel. Owns the
 * channel from `open()` to `close()` and exposes the four operations
 * the terminal UI needs:
 *
 *   - `open(...)` — allocate the PTY-backed channel via SftpClient
 *   - `write(data)` — push keystrokes / paste payloads to the remote
 *   - `resize(rows, cols)` — propagate xterm dimension changes (debounced upstream)
 *   - `close()` — tear the channel down without dropping the SSH session
 *
 * Output (`onData`) and remote-side close (`onClose`) are delivered
 * via callbacks the caller supplies once at construction. Keeping the
 * surface this small avoids leaking the ssh2 ClientChannel typing
 * across the plugin and makes the wrapper trivially mockable in tests.
 */
export class RemoteShell {
  private channel: ClientChannel | null = null;
  private closed = false;
  // Synchronous "open in flight" flag set BEFORE the await in open().
  // Without this, two concurrent open() callers both pass the
  // `if (this.channel)` guard, both reach the await, both allocate
  // server-side channels, and only the second `this.channel = ch`
  // survives — the first channel leaks.
  private opening = false;

  constructor(
    private readonly client: SftpClient,
    private readonly handlers: {
      onData(chunk: Buffer): void;
      onClose(reason: 'remote-eof' | 'error', cause?: Error): void;
    },
  ) {}

  /**
   * Open the PTY channel. `cmd` is forwarded to `SftpClient.openShell`
   * — when supplied the remote runs that command under the PTY (e.g.
   * `/usr/bin/zsh -l`); otherwise the user's default login shell is
   * launched. Returns once the channel is ready to accept writes.
   */
  async open(opts: {
    rows: number;
    cols: number;
    term?: string;
    cmd?: string;
  }): Promise<void> {
    if (this.channel) throw new Error('RemoteShell.open: already open');
    if (this.closed) throw new Error('RemoteShell.open: already closed');
    if (this.opening) throw new Error('RemoteShell.open: already opening');
    this.opening = true;
    try {
      const ch = await this.client.openShell(opts);
      // If close() ran while we were awaiting the channel, immediately
      // end the freshly-allocated channel and bail. Otherwise listeners
      // would attach + the channel reference would be retained, but
      // nobody would ever call end() on it (caller already moved on).
      if (this.closed) {
        try { ch.end(); } catch (e) {
          logger.debug_(`RemoteShell.open: ch.end() after close-while-pending: ${errorMessage(e)}`);
        }
        return;
      }
      this.channel = ch;

      // Stdout + stderr both surface as ordinary `data` events on the
      // shell channel — ssh2 multiplexes them so xterm sees the same
      // byte stream the remote PTY produced.
      ch.on('data', (chunk: Buffer) => {
        if (!this.closed) this.handlers.onData(chunk);
      });
      ch.stderr.on('data', (chunk: Buffer) => {
        if (!this.closed) this.handlers.onData(chunk);
      });

      ch.on('close', () => {
        if (this.closed) return;
        this.closed = true;
        this.channel = null;
        this.handlers.onClose('remote-eof');
      });

      ch.on('error', (e: Error) => {
        if (this.closed) return;
        this.closed = true;
        this.channel = null;
        logger.warn(`RemoteShell: channel error: ${errorMessage(e)}`);
        this.handlers.onClose('error', asError(e));
      });
    } finally {
      this.opening = false;
    }
  }

  write(data: string | Uint8Array): void {
    if (!this.channel || this.closed) return;
    this.channel.write(data);
  }

  /**
   * Propagate xterm's new dimensions to the remote PTY. ssh2's
   * `setWindow` takes (rows, cols, height-px, width-px); we pass 0 for
   * the pixel dims because most TUIs (vim, tmux, less) ignore them
   * and rely solely on rows/cols. Debounce upstream — calling this
   * faster than ~10 Hz spams the SSH channel for no UX benefit.
   */
  resize(rows: number, cols: number): void {
    if (!this.channel || this.closed) return;
    try {
      this.channel.setWindow(rows, cols, 0, 0);
    } catch (e) {
      // setWindow can throw synchronously if the channel went down
      // between the last data event and the next resize. Treat as
      // already-closed; the close handler will fire shortly after.
      logger.debug_(`RemoteShell.resize: ${errorMessage(e)}`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const ch = this.channel;
    this.channel = null;
    if (!ch) return;
    try {
      ch.end();
    } catch (e) {
      logger.debug_(`RemoteShell.close: ${errorMessage(e)}`);
    }
  }

  isOpen(): boolean {
    return this.channel !== null && !this.closed;
  }
}
