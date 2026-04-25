import { App, PluginSettingTab, Setting } from 'obsidian';
import type RemoteSshPlugin from '../main';
import { ProfileForm } from './ProfileForm';
import type { SshProfile } from '../types';

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
  }

  private renderProfileRow(containerEl: HTMLElement, profile: SshProfile) {
    const isActive = this.plugin.settings.activeProfileId === profile.id;

    new Setting(containerEl)
      .setName(`${profile.name}`)
      .setDesc(`${profile.username}@${profile.host}:${profile.port}  →  ${profile.remotePath}`)
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
