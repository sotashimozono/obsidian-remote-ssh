import type { Plugin } from 'obsidian';
import type { Transfer, TransferTracker } from '../util/TransferTracker';

/**
 * Status-bar indicator for large (>1 MB) file transfers in flight.
 * Shows direction arrow, payload size, basename, and elapsed seconds
 * so the user can see something is happening during slow uploads or
 * downloads instead of assuming the editor froze.
 *
 * Hidden when no transfers are in flight. Re-renders on tracker
 * change events AND on a 250 ms tick (so the elapsed-seconds counter
 * advances even during a long single transfer with no other activity).
 */
export class LargeTransferBar {
  private readonly el: HTMLElement;
  private unsubscribe: (() => void) | null = null;
  private tickHandle: number | null = null;
  private current: Transfer[] = [];

  constructor(plugin: Plugin, private readonly tracker: TransferTracker) {
    this.el = plugin.addStatusBarItem();
    this.el.addClass('remote-ssh-transfer');
    this.hide();

    this.unsubscribe = tracker.subscribe(transfers => {
      this.current = transfers;
      this.render();
      // Manage the tick loop based on whether anything is in flight.
      if (transfers.length > 0 && this.tickHandle === null) {
        this.tickHandle = window.setInterval(() => this.render(), 250);
      } else if (transfers.length === 0 && this.tickHandle !== null) {
        window.clearInterval(this.tickHandle);
        this.tickHandle = null;
      }
    });
  }

  /** Tear down listeners + DOM. Call on plugin unload. */
  remove(): void {
    if (this.tickHandle !== null) {
      window.clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.el.remove();
  }

  private render(): void {
    if (this.current.length === 0) {
      this.hide();
      return;
    }
    this.el.removeClass('is-hidden');
    if (this.current.length === 1) {
      this.el.setText(formatSingle(this.current[0]));
    } else {
      this.el.setText(formatMany(this.current));
    }
  }

  private hide(): void {
    this.el.setText('');
    this.el.addClass('is-hidden');
  }
}

function formatSingle(t: Transfer): string {
  const arrow = t.direction === 'up' ? '↑' : '↓';
  const elapsed = Math.max(0, Math.round((Date.now() - t.startedAtMs) / 1000));
  return `${arrow} ${formatBytes(t.bytes)} · ${basename(t.path)} · ${elapsed}s`;
}

function formatMany(transfers: Transfer[]): string {
  const totalBytes = transfers.reduce((s, t) => s + t.bytes, 0);
  const elapsed = Math.max(
    0,
    Math.round((Date.now() - Math.min(...transfers.map(t => t.startedAtMs))) / 1000),
  );
  return `↕ ${formatBytes(totalBytes)} · ${transfers.length} files · ${elapsed}s`;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
