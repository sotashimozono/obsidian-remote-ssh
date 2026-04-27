import { App, Modal } from 'obsidian';

/**
 * Shown when an `fs.write` is rejected with `PreconditionFailed`
 * because the remote mtime no longer matches the cached one — i.e.
 * another client (or a remote-side editor) wrote to the same file
 * after we last read it.
 *
 * The user is offered two outcomes:
 *  - **Overwrite**: retry without `expectedMtime`, blowing away the
 *    remote change with the local one.
 *  - **Cancel**: leave the remote alone; the originating write
 *    fails with the same `PreconditionFailed` error so the editor
 *    surfaces a "save failed" notice.
 *
 * Used as `await new WriteConflictModal(app, vaultPath).prompt()`,
 * which resolves to the user's choice.
 */
export class WriteConflictModal extends Modal {
  private resolved = false;
  private onChoice!: (overwrite: boolean) => void;

  constructor(app: App, private readonly vaultPath: string) {
    super(app);
  }

  /**
   * Open the modal and resolve once the user picks. Closing the
   * modal via Escape or backdrop click is treated as Cancel so the
   * promise always settles.
   */
  prompt(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.onChoice = (overwrite) => {
        if (this.resolved) return;
        this.resolved = true;
        resolve(overwrite);
      };
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText('Remote file was modified');

    contentEl.empty();
    const p = contentEl.createEl('p');
    p.appendText('Another edit landed on the remote since you last read ');
    p.createEl('code', { text: this.vaultPath });
    p.appendText(
      '. Saving now will overwrite that change. Choose Overwrite to '
      + 'force the local version, or Cancel to leave the remote intact '
      + 'and resolve the conflict by hand.',
    );

    const footer = contentEl.createDiv({ cls: 'modal-button-container' });
    const cancelBtn = footer.createEl('button', { text: 'Cancel' });
    cancelBtn.onclick = () => { this.onChoice(false); this.close(); };

    const overwriteBtn = footer.createEl('button', {
      text: 'Overwrite remote',
      cls: 'mod-warning',
    });
    overwriteBtn.onclick = () => { this.onChoice(true); this.close(); };
  }

  onClose(): void {
    // Treat any close-without-button-click as Cancel so the
    // returned Promise always settles.
    if (!this.resolved) this.onChoice(false);
    this.contentEl.empty();
  }
}
