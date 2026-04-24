import { Modal, App } from 'obsidian';
import type { ConflictEntry, ConflictDecision } from '../types';

export class ConflictModal extends Modal {
  private decisions = new Map<string, ConflictDecision>();
  private resolved = false;

  constructor(
    app: App,
    private conflicts: ConflictEntry[],
    private onDecide: (decisions: Map<string, ConflictDecision>) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `Sync conflicts (${this.conflicts.length})` });
    contentEl.createEl('p', {
      text: 'Both local and remote files changed. Choose how to resolve each conflict.',
      cls: 'setting-item-description',
    });

    // Bulk actions
    const bulk = contentEl.createDiv('conflict-bulk-row');
    const keepAllLocal  = bulk.createEl('button', { text: '⬆ Keep all local' });
    const keepAllRemote = bulk.createEl('button', { text: '⬇ Keep all remote' });
    keepAllLocal.onclick  = () => this.setAll('keepLocal');
    keepAllRemote.onclick = () => this.setAll('keepRemote');

    // Per-file rows
    const list = contentEl.createDiv('conflict-list');
    for (const c of this.conflicts) {
      this.decisions.set(c.relativePath, 'keepRemote');
      const row = list.createDiv('conflict-row');
      row.createEl('span', { cls: 'conflict-path', text: c.relativePath });
      row.createEl('small', {
        text: `Local: ${fmt(c.localMtime)} (${fmtSize(c.localSize)})  |  Remote: ${fmt(c.remoteMtime)} (${fmtSize(c.remoteSize)})`,
      });

      const btnRow = row.createDiv('conflict-btn-row');
      const bLocal  = btnRow.createEl('button', { text: '⬆ Local' });
      const bRemote = btnRow.createEl('button', { text: '⬇ Remote', cls: 'mod-cta' });
      const bBoth   = btnRow.createEl('button', { text: '⊕ Keep both' });

      const activate = (btn: HTMLElement, decision: ConflictDecision) => {
        [bLocal, bRemote, bBoth].forEach(b => b.removeClass('mod-cta'));
        btn.addClass('mod-cta');
        this.decisions.set(c.relativePath, decision);
      };

      bLocal.onclick  = () => activate(bLocal, 'keepLocal');
      bRemote.onclick = () => activate(bRemote, 'keepRemote');
      bBoth.onclick   = () => activate(bBoth, 'keepBoth');
    }

    const footer = contentEl.createDiv('conflict-footer');
    const apply  = footer.createEl('button', { text: 'Apply', cls: 'mod-cta' });
    const cancel = footer.createEl('button', { text: 'Pause sync' });

    apply.onclick = () => {
      this.resolved = true;
      this.onDecide(this.decisions);
      this.close();
    };
    cancel.onclick = () => this.close();
  }

  onClose() {
    if (!this.resolved) {
      // User dismissed — default to keepRemote for all
      for (const c of this.conflicts) {
        if (!this.decisions.has(c.relativePath)) this.decisions.set(c.relativePath, 'keepRemote');
      }
      this.onDecide(this.decisions);
    }
    this.contentEl.empty();
  }

  private setAll(decision: ConflictDecision) {
    for (const c of this.conflicts) this.decisions.set(c.relativePath, decision);
  }
}

function fmt(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
