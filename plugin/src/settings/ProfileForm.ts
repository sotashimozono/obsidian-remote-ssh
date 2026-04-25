import { Modal, App, Setting, Notice } from 'obsidian';
import type { SshProfile, AuthMethod } from '../types';
import { DEFAULT_PROFILE } from '../constants';
import { readSshConfig, type SshConfigEntry } from '../ssh/SshConfigReader';
import * as crypto from 'crypto';

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
        };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.isNew ? 'Add SSH Profile' : 'Edit Profile' });

    const sshEntries = readSshConfig();
    if (sshEntries.length > 0) {
      new Setting(contentEl)
        .setName('Import from SSH config')
        .setDesc('Pre-fill fields from ~/.ssh/config')
        .addDropdown(d => {
          d.addOption('', '— select host —');
          for (const e of sshEntries) d.addOption(e.alias, e.alias);
          d.onChange(alias => {
            if (!alias) return;
            const e = sshEntries.find(x => x.alias === alias)!;
            this.applyConfigEntry(e);
            this.close();
            new ProfileForm(this.app, this.profile, this.onSave).open();
          });
        });
    }

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

    contentEl.createEl('h3', { text: 'Remote vault' });

    new Setting(contentEl)
      .setName('Remote vault path')
      .setDesc('Absolute path on the SSH server (e.g. /home/user/vault) or home-relative (e.g. work/vault).')
      .addText(t => t.setPlaceholder('/home/user/vault').setValue(this.profile.remotePath)
        .onChange(v => { this.profile.remotePath = v; }));

    contentEl.createEl('h3', { text: 'Remote daemon (experimental)' });
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Optional: when obsidian-remote-server is running on the remote, fill these in to enable ' +
        'the "Debug: test RPC tunnel" command. Auto-deploy of the binary lands in a later phase.',
    });

    new Setting(contentEl)
      .setName('Daemon socket path')
      .setDesc('e.g. .obsidian-remote/server.sock (home-relative is fine)')
      .addText(t => t.setPlaceholder('.obsidian-remote/server.sock')
        .setValue(this.profile.rpcSocketPath ?? '')
        .onChange(v => { this.profile.rpcSocketPath = v.trim() || undefined; }));

    new Setting(contentEl)
      .setName('Daemon token path')
      .setDesc('Default: .obsidian-remote/token (home-relative)')
      .addText(t => t.setPlaceholder('.obsidian-remote/token')
        .setValue(this.profile.rpcTokenPath ?? '')
        .onChange(v => { this.profile.rpcTokenPath = v.trim() || undefined; }));

    const footer = contentEl.createDiv('conflict-footer');
    footer.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    footer.createEl('button', { text: 'Save', cls: 'mod-cta' }).onclick = () => {
      if (!this.validate()) return;
      this.onSave(this.profile);
      this.close();
    };
  }

  private applyConfigEntry(e: SshConfigEntry) {
    this.profile.name            = e.alias;
    this.profile.host            = e.hostname;
    this.profile.port            = e.port;
    this.profile.username        = e.user;
    if (e.identityFile) {
      this.profile.authMethod    = 'privateKey';
      this.profile.privateKeyPath = e.identityFile;
    }
    if (e.proxyJump) {
      this.profile.jumpHost = { host: e.proxyJump, port: 22, username: e.user, authMethod: 'privateKey' };
    }
  }

  private validate(): boolean {
    if (!this.profile.host) { new Notice('Host is required'); return false; }
    if (!this.profile.username) { new Notice('Username is required'); return false; }
    if (!this.profile.remotePath) { new Notice('Remote vault path is required'); return false; }
    if (!this.profile.name) { new Notice('Profile name is required'); return false; }
    return true;
  }

  onClose() { this.contentEl.empty(); }
}
