import { Modal, App, Notice } from 'obsidian';
import type { SshProfile } from '../types';
import type { AuthResolver } from '../ssh/AuthResolver';

export class ConnectModal extends Modal {
  constructor(
    app: App,
    private profile: SshProfile,
    private authResolver: AuthResolver,
    private onConnect: (profile: SshProfile) => Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `Connect: ${this.profile.name}` });

    if (this.profile.authMethod === 'password') {
      contentEl.createEl('label', { text: 'Password' });
      const input = contentEl.createEl('input', { type: 'password', cls: 'remote-ssh-input' });
      input.style.width = '100%';
      input.style.marginBottom = '12px';

      const btn = contentEl.createEl('button', { text: 'Connect', cls: 'mod-cta' });
      btn.style.width = '100%';

      const connect = async () => {
        if (!input.value) { new Notice('Password required'); return; }
        const ref = `${this.profile.id}:password`;
        this.authResolver.storeSecret(ref, input.value);
        this.profile.passwordRef = ref;
        btn.disabled = true;
        btn.setText('Connecting…');
        try {
          await this.onConnect(this.profile);
          this.close();
        } catch (e) {
          btn.disabled = false;
          btn.setText('Connect');
          new Notice(`Connection failed: ${(e as Error).message}`);
        }
      };

      input.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
      btn.onclick = connect;

    } else if (this.profile.authMethod === 'privateKey' && this.profile.passphraseRef !== undefined) {
      contentEl.createEl('label', { text: 'Key passphrase (leave blank if none)' });
      const input = contentEl.createEl('input', { type: 'password', cls: 'remote-ssh-input' });
      input.style.width = '100%';
      input.style.marginBottom = '12px';

      const btn = contentEl.createEl('button', { text: 'Connect', cls: 'mod-cta' });
      btn.style.width = '100%';

      const connect = async () => {
        if (input.value) {
          const ref = `${this.profile.id}:passphrase`;
          this.authResolver.storeSecret(ref, input.value);
          this.profile.passphraseRef = ref;
        }
        btn.disabled = true;
        btn.setText('Connecting…');
        try {
          await this.onConnect(this.profile);
          this.close();
        } catch (e) {
          btn.disabled = false;
          btn.setText('Connect');
          new Notice(`Connection failed: ${(e as Error).message}`);
        }
      };

      btn.onclick = connect;

    } else {
      // No secrets needed
      const btn = contentEl.createEl('button', { text: 'Connect', cls: 'mod-cta' });
      btn.style.width = '100%';
      btn.onclick = async () => {
        btn.disabled = true;
        btn.setText('Connecting…');
        try {
          await this.onConnect(this.profile);
          this.close();
        } catch (e) {
          btn.disabled = false;
          btn.setText('Connect');
          new Notice(`Connection failed: ${(e as Error).message}`);
        }
      };
    }
  }

  onClose() { this.contentEl.empty(); }
}
