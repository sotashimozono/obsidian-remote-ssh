import type { Plugin } from 'obsidian';

/**
 * Tiny secondary status-bar item that shows "✎ N pending edits"
 * when the offline-write queue has entries. Hidden when the queue is
 * empty so it doesn't clutter the bar in the steady-state online
 * case. Click opens the `PendingEditsModal`; the modal-open handler
 * is supplied by main.ts so this class doesn't depend on the plugin
 * orchestration above it.
 *
 * Refresh strategy: `startPolling` runs `getCount()` on a 2-second
 * timer. The queue doesn't expose change events today, and the user
 * only needs an at-a-glance indicator; precise live updates aren't
 * worth the wiring.
 */
export class PendingEditsBar {
  private el: HTMLElement;
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  constructor(plugin: Plugin, private readonly onClick: () => void) {
    this.el = plugin.addStatusBarItem();
    this.el.addClass('remote-ssh-pending-edits');
    this.el.addEventListener('click', this.onClick);
    this.hide();
  }

  /**
   * Update the displayed count immediately. `n <= 0` hides the
   * indicator; any positive count shows it.
   */
  setCount(n: number): void {
    if (n <= 0) {
      this.hide();
      return;
    }
    this.el.setText(`✎ ${n} pending edit${n === 1 ? '' : 's'}`);
    this.el.removeClass('is-hidden');
  }

  /**
   * Begin polling `getCount()` every `intervalMs` (default 2000)
   * and updating the indicator. Idempotent — calling twice replaces
   * the previous interval. Stops on `stopPolling` or `remove`.
   */
  startPolling(getCount: () => number, intervalMs: number = 2000): void {
    this.stopPolling();
    this.setCount(getCount());
    this.pollHandle = setInterval(() => {
      try {
        this.setCount(getCount());
      } catch {
        // Queue may have been torn down between intervals; just hide
        // and let the next startPolling restore us.
        this.hide();
      }
    }, intervalMs);
  }

  /** Stop the poll loop and hide the indicator. */
  stopPolling(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.hide();
  }

  /** Remove from DOM. Cleans up the poll loop too. */
  remove(): void {
    this.stopPolling();
    this.el.remove();
  }

  private hide(): void {
    this.el.setText('');
    this.el.addClass('is-hidden');
  }
}
