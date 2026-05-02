import { App, Modal } from 'obsidian';
import { formatFingerprint } from '../util/fingerprint';

/**
 * Shown on the *first* connection to a host — when no fingerprint is
 * pinned yet (TOFU: Trust On First Use). Presents the remote's
 * fingerprint and asks the user to explicitly confirm before pinning.
 *
 * Three choices are offered:
 *  - `trust`       — pin the fingerprint permanently (normal TOFU).
 *  - `trust-once`  — accept for this session only; don't persist.
 *  - `reject`      — refuse the handshake; don't connect.
 *
 * Usage:
 *   const decision = await new HostKeyConfirmModal(app, info).prompt();
 *
 * Closing via Escape / backdrop resolves as `reject` so the handshake
 * never hangs on a pending promise.
 */

export interface HostKeyConfirmInfo {
  host: string;
  port: number;
  /** SHA-256 fingerprint hex string (lowercase, no separators). */
  fingerprint: string;
  /** Key type reported by ssh2 (e.g. "ssh-ed25519", "ecdsa-sha2-nistp256"). */
  keyType?: string;
}

export type HostKeyConfirmDecision = 'trust' | 'trust-once' | 'reject';

export class HostKeyConfirmModal extends Modal {
  private resolved = false;
  private onChoice!: (decision: HostKeyConfirmDecision) => void;

  constructor(app: App, private readonly info: HostKeyConfirmInfo) {
    super(app);
  }

  prompt(): Promise<HostKeyConfirmDecision> {
    return new Promise<HostKeyConfirmDecision>((resolve) => {
      this.onChoice = (decision) => {
        if (this.resolved) return;
        this.resolved = true;
        resolve(decision);
      };
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText('Trust remote host key?');

    contentEl.empty();

    contentEl.createEl('p').appendText(
      `This is the first connection to ${this.info.host}:${this.info.port}. ` +
      `Verify the fingerprint matches the server's advertised key before ` +
      `trusting — check the server's banner or ask the administrator.`,
    );

    const grid = contentEl.createDiv({ cls: 'setting-item' });

    const fpRow = grid.createDiv();
    fpRow.createEl('strong', { text: 'Host fingerprint (SHA-256):' });
    fpRow.createEl('br');
    fpRow.createEl('code', { text: formatFingerprint(this.info.fingerprint) });

    if (this.info.keyType) {
      const typeRow = grid.createDiv();
      typeRow.createEl('strong', { text: 'Key type: ' });
      typeRow.appendText(this.info.keyType);
    }

    const footer = contentEl.createDiv({ cls: 'modal-button-container' });

    const rejectBtn = footer.createEl('button', { text: 'Reject' });
    rejectBtn.onclick = () => { this.onChoice('reject'); this.close(); };

    const onceBtn = footer.createEl('button', { text: 'Trust this session only' });
    onceBtn.onclick = () => { this.onChoice('trust-once'); this.close(); };

    const trustBtn = footer.createEl('button', {
      text: 'Trust & remember',
      cls: 'mod-cta',
    });
    trustBtn.onclick = () => { this.onChoice('trust'); this.close(); };
  }

  onClose(): void {
    if (!this.resolved) this.onChoice('reject');
    this.contentEl.empty();
  }
}
