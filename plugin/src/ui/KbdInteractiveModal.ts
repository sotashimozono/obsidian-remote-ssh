import { App, Modal } from 'obsidian';

/**
 * One challenge the SSH server wants the user to respond to in a
 * `keyboard-interactive` round. ssh2 hands these to us as
 * `{ prompt, echo }` tuples; we render `prompt` as a label and pick
 * the input type based on `echo` (`true` = visible text, `false` =
 * password / TOTP / PIN field).
 */
export interface KbdInteractivePrompt {
  prompt: string;
  echo: boolean;
}

/**
 * Modal shown when an SSH server demands `keyboard-interactive`
 * authentication on top of (or instead of) the user's primary
 * credential. Common targets: corp servers with TOTP / RSA SecurID /
 * Duo Push as a second factor, or shared hosts that gate root via PAM.
 *
 * Used as `await new KbdInteractiveModal(app, prompts).prompt()`,
 * which resolves to:
 *  - `string[]` — one response per prompt, in the order ssh2 expected.
 *  - `null` — the user cancelled / closed the modal; the caller should
 *    treat this as an auth failure (forward `[]` to ssh2's `finish`,
 *    which terminates the handshake with an auth error).
 *
 * No response is persisted — TOTP codes are short-lived (~30 s), so
 * caching them defeats the point. PIN-style prompts that the user
 * might want to remember are out of scope; password managers exist
 * for that.
 */
export class KbdInteractiveModal extends Modal {
  private resolved = false;
  private onChoice!: (responses: string[] | null) => void;
  private inputs: HTMLInputElement[] = [];

  constructor(app: App, private readonly prompts: KbdInteractivePrompt[]) {
    super(app);
  }

  /**
   * Open the modal and resolve once the user submits or cancels.
   * Closing via Escape / backdrop is treated as cancel so the promise
   * always settles — leaving an SSH handshake hanging would freeze
   * the connect flow.
   */
  prompt(): Promise<string[] | null> {
    return new Promise<string[] | null>((resolve) => {
      this.onChoice = (responses) => {
        if (this.resolved) return;
        this.resolved = true;
        resolve(responses);
      };
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText('SSH authentication');

    contentEl.empty();
    const intro = contentEl.createEl('p');
    intro.appendText(
      'The remote server is asking for additional authentication. ' +
      'Enter the response for each prompt below.',
    );

    // One labelled input per prompt. echo=false → masked input
    // (password / TOTP / PIN); echo=true → visible text. Server-
    // supplied prompt strings come straight from ssh2's payload —
    // appendText (not innerHTML) so a malicious prompt can't inject
    // markup.
    this.inputs = [];
    for (const p of this.prompts) {
      const row = contentEl.createDiv({ cls: 'setting-item' });
      const label = row.createEl('label');
      label.appendText(p.prompt || 'Response');
      const input = row.createEl('input');
      input.type = p.echo ? 'text' : 'password';
      input.autocomplete = 'off';
      this.inputs.push(input);
    }

    if (this.inputs.length > 0) {
      // Focus the first field and let Enter submit, matching what the
      // user expects from a CLI ssh prompt.
      this.inputs[0].focus();
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.submit();
        }
      };
      for (const inp of this.inputs) {
        inp.addEventListener('keydown', onKey);
      }
    }

    const footer = contentEl.createDiv({ cls: 'modal-button-container' });
    const cancelBtn = footer.createEl('button', { text: 'Cancel' });
    cancelBtn.onclick = () => { this.onChoice(null); this.close(); };

    const submitBtn = footer.createEl('button', {
      text: 'Submit',
      cls: 'mod-cta',
    });
    submitBtn.onclick = () => { this.submit(); };
  }

  private submit(): void {
    const responses = this.inputs.map(inp => inp.value);
    this.onChoice(responses);
    this.close();
  }

  onClose(): void {
    // Close-without-button (Escape / backdrop) settles the promise as
    // a cancel so the SSH handshake fails cleanly instead of hanging.
    if (!this.resolved) this.onChoice(null);
    this.contentEl.empty();
    // Best-effort: blank out the input refs so any DOM-cleared values
    // can be GC'd alongside the modal. Defensive — Obsidian removes
    // contentEl children itself.
    this.inputs = [];
  }
}
