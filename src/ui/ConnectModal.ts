import { Modal, App, Notice, Setting } from 'obsidian';
import type { SshProfile } from '../types';
import type { AuthResolver } from '../ssh/AuthResolver';

/**
 * Step 1 (multi-profile): choose which profile to connect.
 * Step 2: enter any required secret (password / passphrase).
 */
export class ConnectModal extends Modal {
  constructor(
    app: App,
    private profiles: SshProfile[],
    private authResolver: AuthResolver,
    private onConnect: (profile: SshProfile) => Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    if (this.profiles.length === 0) {
      this.renderEmpty();
    } else if (this.profiles.length === 1) {
      this.renderAuth(this.profiles[0]);
    } else {
      this.renderPicker();
    }
  }

  // ─── No profiles ───────────────────────────────────────────────────────────

  private renderEmpty() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Remote SSH' });
    contentEl.createEl('p', { text: 'No SSH profiles configured.' });
    contentEl.createEl('button', { text: 'Open Settings', cls: 'mod-cta' })
      .onclick = () => this.close();
  }

  // ─── Profile picker ────────────────────────────────────────────────────────

  private renderPicker() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Connect to remote vault' });
    contentEl.createEl('p', { text: 'Select a profile:', cls: 'setting-item-description' });

    for (const profile of this.profiles) {
      new Setting(contentEl)
        .setName(profile.name)
        .setDesc(`${profile.username}@${profile.host}:${profile.port}  →  ${profile.remotePath}`)
        .addButton(btn => btn
          .setButtonText('Connect')
          .setCta()
          .onClick(() => this.renderAuth(profile)));
    }
  }

  // ─── Auth step ─────────────────────────────────────────────────────────────

  private renderAuth(profile: SshProfile) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `Connect: ${profile.name}` });
    contentEl.createEl('p', {
      text: `${profile.username}@${profile.host}:${profile.port}`,
      cls: 'setting-item-description',
    });

    const needsPassword   = profile.authMethod === 'password';
    const needsPassphrase = profile.authMethod === 'privateKey'; // optional but offer it

    if (!needsPassword && !needsPassphrase) {
      this.renderConnectButton(profile, contentEl);
      return;
    }

    const label = needsPassword ? 'Password' : 'Key passphrase (leave blank if none)';
    contentEl.createEl('label', { text: label });

    const input = contentEl.createEl('input', { type: 'password' });
    input.style.cssText = 'width:100%;margin:8px 0 16px;';

    const btn = this.renderConnectButton(profile, contentEl, async () => {
      const secret = input.value;
      if (needsPassword && !secret) { new Notice('Password is required'); return false; }
      if (secret) {
        const ref = `${profile.id}:${needsPassword ? 'password' : 'passphrase'}`;
        this.authResolver.storeSecret(ref, secret);
        if (needsPassword) profile.passwordRef = ref;
        else profile.passphraseRef = ref;
      }
      return true;
    });

    input.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });

    // Back button when multiple profiles available
    if (this.profiles.length > 1) {
      const back = contentEl.createEl('button', { text: '← Back' });
      back.style.marginTop = '8px';
      back.onclick = () => this.renderPicker();
    }
  }

  private renderConnectButton(
    profile: SshProfile,
    container: HTMLElement,
    preConnect?: () => Promise<boolean>,
  ): HTMLButtonElement {
    const btn = container.createEl('button', { text: 'Connect', cls: 'mod-cta' });
    btn.style.width = '100%';

    btn.onclick = async () => {
      if (preConnect) {
        const ok = await preConnect();
        if (!ok) return;
      }
      btn.disabled = true;
      btn.setText('Connecting…');
      try {
        await this.onConnect(profile);
        this.close();
      } catch (e) {
        btn.disabled = false;
        btn.setText('Connect');
        new Notice(`Connection failed: ${(e as Error).message}`);
      }
    };

    return btn;
  }

  onClose() { this.contentEl.empty(); }
}
