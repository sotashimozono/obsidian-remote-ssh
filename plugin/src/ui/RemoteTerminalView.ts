import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RemoteShell } from '../ssh/RemoteShell';
import type { SftpClient } from '../ssh/SftpClient';
import type { PluginSettings } from '../types';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

export const VIEW_TYPE_REMOTE_TERMINAL = 'remote-ssh-terminal';
const RESIZE_DEBOUNCE_MS = 100;

/**
 * Dependency surface the View needs from the host plugin. Kept narrow
 * so the View is testable without booting the full plugin (the test
 * passes a stub object, the real call site passes the plugin instance).
 */
export interface RemoteTerminalDeps {
  /** Returns the active SftpClient, or null if not connected. */
  getClient(): SftpClient | null;
  settings: PluginSettings;
}

/**
 * Right-sidebar terminal pane. Reuses the already-authenticated SSH
 * session that SftpClient owns — so opening the pane doesn't trigger
 * another auth prompt and adds no connection-establishment cost.
 *
 * Output flow:    remote PTY → ssh2 channel → RemoteShell.onData → term.write
 * Input flow:     keystroke  → term.onData  → RemoteShell.write   → remote PTY
 * Resize flow:    DOM resize → debounced FitAddon.fit → RemoteShell.resize
 *
 * V1 scope (per #149): single terminal per shadow vault, no tabs,
 * scrollback only for the session lifetime, no search-in-buffer.
 */
export class RemoteTerminalView extends ItemView {
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private shell: RemoteShell | null = null;
  private resizeTimer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: RemoteTerminalDeps,
  ) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_REMOTE_TERMINAL; }
  getDisplayText(): string { return 'Remote terminal'; }
  getIcon(): string { return 'terminal'; }

  async onOpen(): Promise<void> {
    const host = this.contentEl;
    host.empty();
    host.addClass('remote-ssh-terminal-host');

    const client = this.deps.getClient();
    if (!client || !client.isAlive()) {
      this.renderDisconnected('Not connected — run "Remote SSH: Connect" first.');
      return;
    }

    const xtermContainer = host.createDiv({ cls: 'remote-ssh-terminal-pane' });

    this.term = new Terminal({
      fontSize: this.deps.settings.terminalFontSize ?? 12,
      scrollback: this.deps.settings.terminalScrollback ?? 1000,
      fontFamily: 'Menlo, Consolas, monospace',
      cursorBlink: true,
      // Default to 80×24 so the very first openShell() can pass real
      // dims; FitAddon will re-measure once the pane has its layout.
      cols: 80,
      rows: 24,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(xtermContainer);

    // Best-effort initial fit — at this point the pane may still be
    // laying out, so FitAddon.proposeDimensions can return null. The
    // ResizeObserver below picks up the real dimensions once they settle.
    let initialRows = 24;
    let initialCols = 80;
    try {
      this.fit.fit();
      const dims = this.fit.proposeDimensions();
      if (dims) {
        initialRows = dims.rows;
        initialCols = dims.cols;
      }
    } catch (e) {
      logger.debug_(`RemoteTerminalView.onOpen: initial fit failed: ${errorMessage(e)}`);
    }

    this.shell = new RemoteShell(client, {
      onData: (chunk) => { this.term?.write(chunk); },
      onClose: (reason, cause) => {
        // Always log so the channel-close audit trail isn't lost when
        // the View has already torn down — `this.term` may be null
        // mid-teardown, in which case the optional-chain write below
        // would otherwise swallow the entire signal.
        if (reason === 'remote-eof') {
          logger.info('RemoteTerminalView: remote shell exited (eof)');
        } else {
          logger.warn(`RemoteTerminalView: shell error: ${cause ? errorMessage(cause) : 'unknown'}`);
        }
        const msg = reason === 'remote-eof'
          ? 'Shell exited.'
          : `Shell error: ${cause ? errorMessage(cause) : 'unknown'}`;
        this.term?.writeln('\r\n\r\n\x1b[33m[' + msg + ']\x1b[0m');
      },
    });

    try {
      await this.shell.open({
        rows: initialRows,
        cols: initialCols,
        cmd: this.deps.settings.terminalShell?.trim() || undefined,
      });
    } catch (e) {
      // The most common failure here is "Channel open failure:
      // administratively prohibited" → sshd has `PermitTTY no`. Surface
      // verbatim so the user knows what to fix.
      //
      // Tear down everything we partially constructed before this
      // throw — leaving `this.shell` / `this.term` non-null after the
      // failure means a late channel `error` / `close` from the
      // partially-allocated server-side channel would call into a
      // half-disposed view.
      this.shell?.close();
      this.shell = null;
      this.term?.dispose();
      this.term = null;
      this.fit = null;
      this.renderDisconnected(`Failed to open shell: ${errorMessage(e)}`);
      return;
    }

    // User keystrokes → channel.
    this.term.onData((data: string) => {
      this.shell?.write(data);
    });

    // Pane size → debounced fit + setWindow upstream.
    this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
    this.resizeObserver.observe(xtermContainer);
  }

  onClose(): Promise<void> {
    if (this.resizeTimer !== null) {
      activeWindow.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.shell?.close();
    this.shell = null;
    this.term?.dispose();
    this.term = null;
    this.fit = null;
    // ItemView's onClose contract is Promise<void>; we have nothing
    // genuinely async here so a resolved Promise satisfies the type
    // without triggering @typescript-eslint/require-await.
    return Promise.resolve();
  }

  private scheduleResize(): void {
    if (this.resizeTimer !== null) activeWindow.clearTimeout(this.resizeTimer);
    // activeWindow.setTimeout binds the timer to the currently focused
    // popout window so it dies cleanly with the window — required by
    // obsidianmd/prefer-active-window-timers and matches the rest of
    // the plugin's timer usage.
    this.resizeTimer = activeWindow.setTimeout(() => {
      this.resizeTimer = null;
      this.applyResize();
    }, RESIZE_DEBOUNCE_MS);
  }

  private applyResize(): void {
    if (!this.fit || !this.term || !this.shell?.isOpen()) return;
    try {
      this.fit.fit();
      const dims = this.fit.proposeDimensions();
      if (!dims) return;
      this.shell.resize(dims.rows, dims.cols);
    } catch (e) {
      logger.debug_(`RemoteTerminalView.applyResize: ${errorMessage(e)}`);
    }
  }

  private renderDisconnected(message: string): void {
    this.contentEl.empty();
    this.contentEl.addClass('remote-ssh-terminal-host');
    const box = this.contentEl.createDiv({ cls: 'remote-ssh-terminal-disconnected' });
    box.createEl('p', { text: message });
  }
}
