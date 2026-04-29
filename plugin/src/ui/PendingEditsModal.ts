import { App, Modal } from 'obsidian';
import type { QueueEntry, QueuedOp } from '../offline/OfflineQueue';

/**
 * Outcome of the pending-edits prompt:
 *
 * - `close` — user dismissed without action.
 * - `discard-all` — user clicked the destructive "Discard all"
 *   button. The caller should call `OfflineQueue.clear()` and
 *   surface a notice; the entries are gone forever.
 */
export type PendingEditsDecision =
  | { decision: 'close' }
  | { decision: 'discard-all' };

/**
 * Read-only listing of every queued op (oldest-first), with a
 * destructive "Discard all" button for users who want to start over.
 * No per-entry retry / discard for now — simplest UI that makes the
 * queue inspectable; per-entry actions can land in a follow-up if
 * users ask for them.
 */
export class PendingEditsModal extends Modal {
  private resolveDecision: ((d: PendingEditsDecision) => void) | null = null;
  private decisionSent = false;

  constructor(app: App, private readonly entries: ReadonlyArray<QueueEntry>) {
    super(app);
  }

  prompt(): Promise<PendingEditsDecision> {
    return new Promise(resolve => {
      this.resolveDecision = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('remote-ssh-pending-edits-modal');

    contentEl.createEl('h2', { text: 'Pending offline edits' });
    contentEl.createEl('p', {
      text:
        `${this.entries.length} write${this.entries.length === 1 ? '' : 's'} ` +
        'are queued for replay against the remote when the next reconnect succeeds. ' +
        'Edits drain in the order shown.',
    });

    if (this.entries.length === 0) {
      contentEl.createEl('p', { text: '(Queue is empty)' });
    } else {
      const list = contentEl.createDiv({ cls: 'remote-ssh-pending-edits-list' });

      for (const entry of this.entries) {
        const row = list.createDiv({ cls: 'remote-ssh-pending-edits-row' });
        const ts = formatTs(entry.ts);
        const summary = describeOp(entry.op);
        row.setText(`${ts}  ${summary}`);
      }
    }

    const buttons = contentEl.createDiv({ cls: 'remote-ssh-pending-buttons' });

    const closeBtn = buttons.createEl('button', { text: 'Close' });
    closeBtn.addEventListener('click', () => {
      this.send({ decision: 'close' });
      this.close();
    });

    const discardBtn = buttons.createEl('button', { text: 'Discard all', cls: 'mod-warning' });
    discardBtn.disabled = this.entries.length === 0;
    discardBtn.addEventListener('click', () => {
      this.send({ decision: 'discard-all' });
      this.close();
    });
  }

  onClose(): void {
    if (!this.decisionSent) this.send({ decision: 'close' });
    this.contentEl.empty();
  }

  private send(decision: PendingEditsDecision): void {
    if (this.decisionSent) return;
    this.decisionSent = true;
    this.resolveDecision?.(decision);
  }
}

// ─── render helpers ─────────────────────────────────────────────────────

function formatTs(unixMs: number): string {
  const d = new Date(unixMs);
  // Local time, HH:MM:SS — short enough to fit a status-bar lookup
  // without turning into a full timestamp.
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function describeOp(op: QueuedOp): string {
  switch (op.kind) {
    case 'write':        return `write       ${op.path}`;
    case 'writeBinary':  return `writeBinary ${op.path}`;
    case 'append':       return `append      ${op.path}`;
    case 'appendBinary': return `appendBinary ${op.path}`;
    case 'mkdir':        return `mkdir       ${op.path}`;
    case 'remove':       return `remove      ${op.path}`;
    case 'rmdir':        return `rmdir       ${op.path}${op.recursive ? ' -r' : ''}`;
    case 'rename':       return `rename      ${op.oldPath} → ${op.newPath}`;
    case 'copy':         return `copy        ${op.srcPath} → ${op.dstPath}`;
    case 'trashLocal':   return `trashLocal  ${op.path}`;
  }
}
