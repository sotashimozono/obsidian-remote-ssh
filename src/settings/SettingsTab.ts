import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
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

    // License
    containerEl.createEl('h3', { text: 'License' });
    const tier = this.plugin.gate.tierLabel;
    containerEl.createEl('p', {
      text: `Current tier: ${tier}`,
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('License key')
      .setDesc(this.plugin.gate.isPro
        ? `Pro license active (${this.plugin.gate.licenseEmail})`
        : 'Enter your Pro license key to unlock additional features')
      .addText(t => t
        .setPlaceholder('eyJ...')
        .setValue(this.plugin.settings.licenseKey)
        .onChange(async v => {
          this.plugin.settings.licenseKey = v;
          await this.plugin.gate.initialize(v);
          await this.plugin.saveSettings();
          this.display();
        }));

    // Profiles
    containerEl.createEl('h3', { text: 'SSH Profiles' });

    const canAdd = this.plugin.gate.canAddProfile(this.plugin.settings.profiles.length);
    const addBtn = new Setting(containerEl)
      .setName('Add profile')
      .addButton(btn => btn
        .setButtonText('+ Add')
        .setDisabled(!canAdd)
        .onClick(() => {
          new ProfileForm(this.app, null, async (p) => {
            this.plugin.settings.profiles.push(p);
            await this.plugin.saveSettings();
            this.display();
          }).open();
        }));

    if (!canAdd) {
      addBtn.setDesc('Upgrade to Pro to add multiple profiles');
    }

    for (const profile of this.plugin.settings.profiles) {
      this.renderProfileRow(containerEl, profile);
    }

    // Debug
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
      .setName('Open sync log')
      .addButton(btn => btn.setButtonText('Open').onClick(() => {
        this.plugin.openSyncLog();
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
