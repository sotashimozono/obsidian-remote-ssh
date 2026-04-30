import { App, Modal } from 'obsidian';

/**
 * Inputs to {@link HostKeyMismatchModal}. Fingerprints are sha256
 * hex strings (lowercase, no separators) — the same shape produced
 * by `HostKeyStore` and shown by `ssh-keygen -lf`. Both are public
 * information; no redaction needed.
 */
export interface HostKeyMismatchInfo {
  host: string;
  port: number;
  /** Previously-pinned fingerprint stored in `HostKeyStore`. */
  oldFp: string;
  /** Fingerprint the remote presented during this handshake. */
  newFp: string;
}

/**
 * User decision returned from {@link HostKeyMismatchModal}.
 *  - `trust` — forget the old fingerprint, pin the new one, proceed
 *    with the handshake. Equivalent to running `ssh-keygen -R host`.
 *  - `abort` — leave the stored fingerprint untouched, refuse the
 *    handshake. The connect promise rejects with a `host-key`
 *    category error so the existing taxonomy hint is shown.
 */
export type HostKeyDecision = 'trust' | 'abort';

/**
 * Shown when the remote presents a host key whose fingerprint doesn't
 * match what we previously pinned (#132). Surfaces both fingerprints
 * side-by-side so the user can match against an out-of-band channel
 * (signed announcement, console output) before trusting.
 *
 * Used as `await new HostKeyMismatchModal(app, info).prompt()`, which
 * always settles — closing the modal via Escape / backdrop is treated
 * as `abort` so the SSH handshake fails cleanly instead of hanging.
 */
export class HostKeyMismatchModal extends Modal {
  private resolved = false;
  private onChoice!: (decision: HostKeyDecision) => void;

  constructor(app: App, private readonly info: HostKeyMismatchInfo) {
    super(app);
  }

  prompt(): Promise<HostKeyDecision> {
    return new Promise<HostKeyDecision>((resolve) => {
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
    titleEl.setText('Remote host key changed');

    contentEl.empty();

    const warning = contentEl.createEl('p', { cls: 'mod-warning' });
    warning.appendText(
      `The host key for ${this.info.host}:${this.info.port} doesn't ` +
      `match what was pinned on a previous connection. This is ` +
      `usually because the server was reinstalled or migrated — ` +
      `but it can also mean the connection is being intercepted. ` +
      `Verify the new fingerprint through an out-of-band channel ` +
      `(server announcement, console banner, ssh-keygen -lf on the host) ` +
      `before trusting it.`,
    );

    const grid = contentEl.createDiv({ cls: 'setting-item' });

    const oldRow = grid.createDiv();
    oldRow.createEl('strong', { text: 'Pinned fingerprint (sha256):' });
    oldRow.createEl('br');
    oldRow.createEl('code', { text: formatFingerprint(this.info.oldFp) });

    const newRow = grid.createDiv();
    newRow.createEl('strong', { text: 'Presented fingerprint (sha256):' });
    newRow.createEl('br');
    newRow.createEl('code', { text: formatFingerprint(this.info.newFp) });

    const footer = contentEl.createDiv({ cls: 'modal-button-container' });
    const abortBtn = footer.createEl('button', { text: 'Abort' });
    abortBtn.onclick = () => { this.onChoice('abort'); this.close(); };

    const trustBtn = footer.createEl('button', {
      text: 'Trust new key & reconnect',
      cls: 'mod-warning',
    });
    trustBtn.onclick = () => { this.onChoice('trust'); this.close(); };
  }

  onClose(): void {
    // Close-without-button settles as abort so the SSH handshake fails
    // cleanly instead of hanging on a never-resolved promise.
    if (!this.resolved) this.onChoice('abort');
    this.contentEl.empty();
  }
}

/**
 * Format a sha256 hex fingerprint into colon-separated byte pairs
 * (`aa:bb:cc:...`) for readability. Matches the convention OpenSSH
 * uses when printing fingerprints in non-base64 form, so the user
 * can paste it directly into a comparison against `ssh-keygen -lf`.
 */
export function formatFingerprint(hex: string): string {
  const clean = hex.toLowerCase().replace(/[^0-9a-f]/g, '');
  const pairs: string[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    pairs.push(clean.slice(i, i + 2));
  }
  return pairs.join(':');
}
