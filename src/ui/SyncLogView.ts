import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { LogLine } from '../types';
import { logger } from '../util/logger';

export const SYNC_LOG_VIEW_TYPE = 'remote-ssh-sync-log';

export class SyncLogView extends ItemView {
  private container: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType() { return SYNC_LOG_VIEW_TYPE; }
  getDisplayText() { return 'Remote SSH Log'; }
  getIcon() { return 'terminal'; }

  async onOpen() {
    this.containerEl.empty();
    this.container = this.containerEl.createDiv('sync-log-container');
    this.renderAll();

    this.unsubscribe = logger.onLine(line => this.appendLine(line));
  }

  async onClose() {
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
  }

  private renderAll() {
    if (!this.container) return;
    this.container.empty();
    for (const line of logger.getLines()) this.appendLine(line);
  }

  private appendLine(line: LogLine) {
    if (!this.container) return;
    const el = this.container.createDiv(`sync-log-line level-${line.level}`);
    const time = new Date(line.timestamp).toLocaleTimeString();
    el.setText(`${time} [${line.level.toUpperCase()}] ${line.message}`);
    this.container.scrollTop = this.container.scrollHeight;
  }
}
