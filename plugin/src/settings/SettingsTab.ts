import { App, PluginSettingTab, Setting } from 'obsidian';
import type RemoteSshPlugin from '../main';
import { ProfileForm } from './ProfileForm';
import type { SshProfile } from '../types';
import {
  defaultClientId,
  defaultUserName,
  sanitizeClientId,
} from '../path/PathMapper';

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: RemoteSshPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Remote SSH' });

    containerEl.createEl('h3', { text: 'SSH Profiles' });

    new Setting(containerEl)
      .setName('Add profile')
      .addButton(btn => btn
        .setButtonText('+ Add')
        .onClick(() => {
          new ProfileForm(this.app, null, async (p) => {
            this.plugin.settings.profiles.push(p);
            await this.plugin.saveSettings();
            this.display();
          }).open();
        }));

    for (const profile of this.plugin.settings.profiles) {
      this.renderProfileRow(containerEl, profile);
    }

    containerEl.createEl('h3', { text: 'This device' });

    new Setting(containerEl)
      .setName('Client ID')
      .setDesc(
        'Per-device subtree name on the remote. Leave blank to use the '
        + `OS hostname. Current default: "${defaultClientId()}". Allowed `
        + 'characters: A-Z a-z 0-9 . - _ (anything else is replaced with "-"). '
        + 'Changing this leaves the old subtree behind on the remote — '
        + 'workspace layout, recent files, etc. start fresh.',
      )
      .addText(t => t
        .setPlaceholder(defaultClientId())
        .setValue(this.plugin.settings.clientId)
        .onChange(async v => {
          // Empty string = "use the default"; non-empty values are
          // sanitized so a typo'd entry can't produce an invalid path.
          this.plugin.settings.clientId = v.trim() === '' ? '' : sanitizeClientId(v);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('User name')
      .setDesc(
        'Display name for this device. Cosmetic for now — surfaces in '
        + 'connect notices and (eventually) multi-client presence info on '
        + `the remote. Default: "${defaultUserName()}".`,
      )
      .addText(t => t
        .setPlaceholder(defaultUserName())
        .setValue(this.plugin.settings.userName)
        .onChange(async v => {
          this.plugin.settings.userName = v.trim();
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Advanced' });
    new Setting(containerEl)
      .setName('Debug logging')
      .addToggle(t => t.setValue(this.plugin.settings.enableDebugLog)
        .onChange(async v => {
          this.plugin.settings.enableDebugLog = v;
          await this.plugin.saveSettings();
          const { logger } = await import('../util/logger');
          logger.setDebug(v);
        }));

    new Setting(containerEl)
      .setName('Reconnect attempts after unexpected disconnect')
      .setDesc('Number of times to retry the connection with exponential backoff before giving up. Set to 0 to disable auto-reconnect.')
      .addText(t => t
        .setPlaceholder('5')
        .setValue(String(this.plugin.settings.reconnectMaxRetries))
        .onChange(async v => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 0 && n <= 100) {
            this.plugin.settings.reconnectMaxRetries = n;
            await this.plugin.saveSettings();
          }
        }));
  }

  private renderProfileRow(containerEl: HTMLElement, profile: SshProfile) {
    const isActive = this.plugin.isConnected()
      && this.plugin.settings.activeProfileId === profile.id;

    const transport = (profile.transport ?? 'sftp').toUpperCase();
    new Setting(containerEl)
      .setName(`${profile.name}`)
      .setDesc(
        `${profile.username}@${profile.host}:${profile.port}  →  ${profile.remotePath}  ` +
        `[${transport}]`,
      )
      .addButton(btn => btn
        .setButtonText(isActive ? 'Disconnect' : 'Connect')
        .setCta()
        .onClick(async () => {
          if (isActive) {
            await this.plugin.disconnect();
          } else {
            await this.plugin.connectProfile(profile);
          }
          this.display();
        }))
      .addButton(btn => btn.setButtonText('Edit').onClick(() => {
        new ProfileForm(this.app, profile, async (updated) => {
          const idx = this.plugin.settings.profiles.findIndex(p => p.id === updated.id);
          if (idx >= 0) this.plugin.settings.profiles[idx] = updated;
          await this.plugin.saveSettings();
          this.display();
        }).open();
      }))
      .addButton(btn => btn.setButtonText('Delete').setWarning().onClick(async () => {
        if (isActive) await this.plugin.disconnect();
        this.plugin.settings.profiles = this.plugin.settings.profiles.filter(p => p.id !== profile.id);
        await this.plugin.saveSettings();
        this.display();
      }));
  }
}
