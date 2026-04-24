import { Modal, App, Setting, Notice } from 'obsidian';
import type { SshProfile, AuthMethod } from '../types';
import { DEFAULT_PROFILE } from '../constants';
import { expandHome } from '../util/pathUtils';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

export class ProfileForm extends Modal {
  private profile: SshProfile;
  private isNew: boolean;

  constructor(
    app: App,
    profile: SshProfile | null,
    private onSave: (profile: SshProfile) => void,
  ) {
    super(app);
    this.isNew = profile === null;
    this.profile = profile
      ? { ...profile }
      : {
          ...DEFAULT_PROFILE,
          id: crypto.randomUUID(),
          name: 'New Profile',
          localCachePath: path.join(os.homedir(), '.obsidian-remote', 'new-profile'),
        };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.isNew ? 'Add SSH Profile' : 'Edit Profile' });

    new Setting(contentEl)
      .setName('Profile name')
      .addText(t => t.setValue(this.profile.name)
        .onChange(v => { this.profile.name = v; }));

    contentEl.createEl('h3', { text: 'Connection' });

    new Setting(contentEl)
      .setName('Host')
      .addText(t => t.setPlaceholder('example.com').setValue(this.profile.host)
        .onChange(v => { this.profile.host = v; }));

    new Setting(contentEl)
      .setName('Port')
      .addText(t => t.setValue(String(this.profile.port))
        .onChange(v => { const n = parseInt(v); if (!isNaN(n)) this.profile.port = n; }));

    new Setting(contentEl)
      .setName('Username')
      .addText(t => t.setValue(this.profile.username)
        .onChange(v => { this.profile.username = v; }));

    new Setting(contentEl)
      .setName('Authentication')
      .addDropdown(d => d
        .addOption('privateKey', 'Private key')
        .addOption('password', 'Password (entered on connect)')
        .addOption('agent', 'SSH agent')
        .setValue(this.profile.authMethod)
        .onChange(v => { this.profile.authMethod = v as AuthMethod; }));

    new Setting(contentEl)
      .setName('Private key path')
      .setDesc('e.g. ~/.ssh/id_ed25519')
      .addText(t => t.setPlaceholder('~/.ssh/id_ed25519').setValue(this.profile.privateKeyPath ?? '')
        .onChange(v => { this.profile.privateKeyPath = v || undefined; }));

    contentEl.createEl('h3', { text: 'Paths' });

    new Setting(contentEl)
      .setName('Remote vault path')
      .setDesc('Absolute path on the SSH server')
      .addText(t => t.setPlaceholder('/home/user/vault').setValue(this.profile.remotePath)
        .onChange(v => { this.profile.remotePath = v; }));

    new Setting(contentEl)
      .setName('Local cache path')
      .setDesc('Local directory to use as Obsidian vault. Created if not present.')
      .addText(t => t.setValue(this.profile.localCachePath)
        .onChange(v => { this.profile.localCachePath = expandHome(v); }));

    contentEl.createEl('h3', { text: 'Sync' });

    new Setting(contentEl)
      .setName('Upload on save')
      .setDesc('Push file to remote immediately when saved in Obsidian')
      .addToggle(t => t.setValue(this.profile.uploadOnSave)
        .onChange(v => { this.profile.uploadOnSave = v; }));

    new Setting(contentEl)
      .setName('Ignore patterns')
      .setDesc('Comma-separated glob patterns to exclude (e.g. .git, *.tmp)')
      .addText(t => t.setValue(this.profile.ignorePatterns.join(', '))
        .onChange(v => {
          this.profile.ignorePatterns = v.split(',').map(s => s.trim()).filter(Boolean);
        }));

    // Footer
    const footer = contentEl.createDiv('conflict-footer');
    footer.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    footer.createEl('button', { text: 'Save', cls: 'mod-cta' }).onclick = () => {
      if (!this.validate()) return;
      this.onSave(this.profile);
      this.close();
    };
  }

  private validate(): boolean {
    if (!this.profile.host) { new Notice('Host is required'); return false; }
    if (!this.profile.username) { new Notice('Username is required'); return false; }
    if (!this.profile.remotePath) { new Notice('Remote vault path is required'); return false; }
    if (!this.profile.localCachePath) { new Notice('Local cache path is required'); return false; }
    if (!this.profile.name) { new Notice('Profile name is required'); return false; }
    return true;
  }

  onClose() { this.contentEl.empty(); }
}
