import { App, FileSystemAdapter, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import { telemetry, telemetryLogPath, type TelemetryRecord } from '../util/Telemetry';
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
    ;

    new Setting(containerEl).setName("SSH profiles").setHeading();
    containerEl.createEl('p', {
      text:
        'Connecting to a profile opens the remote vault in a new Obsidian window — ' +
        'a "shadow vault" specific to that profile. The current vault stays untouched.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Add profile')
      .addButton(btn => btn
        .setButtonText('Add')
        .onClick(() => {
          new ProfileForm(this.app, null, (p) => {
            this.plugin.settings.profiles.push(p);
            void this.plugin.saveSettings().then(() => this.display());
          }, this.plugin.getProfileFormDeps()).open();
        }));

    for (const profile of this.plugin.settings.profiles) {
      this.renderProfileRow(containerEl, profile);
    }

    new Setting(containerEl).setName("This device").setHeading();

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

    this.renderDaemonPanel(containerEl);

    this.renderTelemetryPanel(containerEl);

    new Setting(containerEl).setName("Advanced").setHeading();

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

    this.renderTerminalPanel(containerEl);
  }

  /**
   * #149 — terminal pane settings. The View reads these on every
   * `onOpen` (no event subscription), so changes take effect the
   * next time the user opens the terminal pane. Unset / blank values
   * fall back to xterm.js defaults via `?? 12 / ?? 1000` in the View.
   */
  private renderTerminalPanel(containerEl: HTMLElement) {
    new Setting(containerEl).setName('Terminal').setHeading();

    new Setting(containerEl)
      .setName('Shell command')
      .setDesc(
        'Override the remote shell. Leave blank to use the remote user\'s '
        + 'login shell ($SHELL). Example: "/usr/bin/zsh -l".',
      )
      .addText(t => t
        // Description text below names $SHELL explicitly; placeholder
        // stays linter-friendly with a sentence-case noun phrase.
        .setPlaceholder('Default login shell')
        .setValue(this.plugin.settings.terminalShell ?? '')
        .onChange(async v => {
          const trimmed = v.trim();
          this.plugin.settings.terminalShell = trimmed === '' ? undefined : trimmed;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Font size (px)')
      .addText(t => t
        .setPlaceholder('12')
        .setValue(String(this.plugin.settings.terminalFontSize ?? 12))
        .onChange(async v => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 6 && n <= 32) {
            this.plugin.settings.terminalFontSize = n;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Scrollback (lines)')
      .setDesc('Lines kept in the terminal\'s in-memory buffer. Bigger = more memory; not persisted across re-opens.')
      .addText(t => t
        .setPlaceholder('1000')
        .setValue(String(this.plugin.settings.terminalScrollback ?? 1000))
        .onChange(async v => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 100 && n <= 100_000) {
            this.plugin.settings.terminalScrollback = n;
            await this.plugin.saveSettings();
          }
        }));
  }

  private renderTelemetryPanel(containerEl: HTMLElement) {
    new Setting(containerEl).setName('Telemetry').setHeading();

    new Setting(containerEl)
      .setName('Enable anonymous telemetry')
      .setDesc(
        'Locally count error categories and reconnect-state outcomes. ' +
        'Stays on disk under the plugin folder; nothing is sent over the network. ' +
        'Useful for pasting a counter snapshot into a bug report.',
      )
      .addToggle(t => t.setValue(this.plugin.settings.telemetryEnabled ?? false)
        .onChange(async v => {
          this.plugin.settings.telemetryEnabled = v;
          await this.plugin.saveSettings();
          const adapter = this.app.vault.adapter;
          const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
          if (v && basePath) {
            await telemetry.setEnabled(
              true,
              telemetryLogPath(basePath, this.app.vault.configDir, this.plugin.manifest.id),
            );
          } else {
            await telemetry.setEnabled(false);
          }
          this.display();
        }));

    if (!telemetry.isEnabled()) return;

    new Setting(containerEl)
      .setName('Counters')
      .setDesc('In-memory deltas since the last flush.')
      .addButton(btn => btn
        .setButtonText('View')
        .onClick(() => this.showTelemetryCounters()))
      .addButton(btn => btn
        .setButtonText('Flush now')
        .onClick(async () => {
          await telemetry.flush();
          new Notice('Remote SSH: telemetry flushed');
        }))
      .addButton(btn => btn
        .setButtonText('Reset')
        .setWarning()
        .onClick(() => {
          telemetry.reset();
          new Notice('Remote SSH: in-memory telemetry counters cleared');
        }));
  }

  private showTelemetryCounters() {
    const records = telemetry.snapshot();
    new TelemetryViewModal(this.app, records).open();
  }

  private renderDaemonPanel(containerEl: HTMLElement) {
    const status = this.plugin.getDaemonStatus();
    if (status.status === 'none') return;

    new Setting(containerEl).setName('Daemon').setHeading();

    const badge = status.status === 'running' ? '🟢 Running' : '🔴 Down';
    const desc = status.status === 'running'
      ? `v${status.version}, ${status.capabilities} capabilities`
      : 'RPC connection lost';

    new Setting(containerEl)
      .setName(badge)
      .setDesc(desc)
      .addButton(btn => btn
        .setButtonText('Restart')
        .setWarning()
        .onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Restarting…');
          try {
            await this.plugin.restartDaemon();
            new Notice('Remote SSH: daemon restarted');
          } catch (e) {
            new Notice(`Restart failed: ${(e as Error).message}`);
          }
          this.display();
        }))
      .addButton(btn => btn
        .setButtonText('View log')
        .onClick(async () => {
          try {
            const log = await this.plugin.readDaemonLog();
            this.renderLogTail(containerEl, log);
          } catch (e) {
            new Notice(`Failed to read log: ${(e as Error).message}`);
          }
        }));
  }

  private renderLogTail(containerEl: HTMLElement, log: string) {
    containerEl.querySelector('.remote-ssh-daemon-log')?.remove();

    const panel = containerEl.createDiv({ cls: 'remote-ssh-daemon-log' });
    new Setting(panel).setName('Daemon log (last 50 lines)').setHeading();
    const pre = panel.createEl('pre', { cls: 'remote-ssh-log-pre' });
    pre.textContent = log;
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
        // `isActive` only goes true inside a shadow window whose
        // plugin instance has connected to this profile. From the
        // original window's Settings, isActive is always false and
        // the button reads "Connect" → opens the shadow vault.
        .setButtonText(isActive ? 'Disconnect' : 'Connect')
        .setCta()
        .onClick(async () => {
          if (isActive) {
            await this.plugin.disconnect();
          } else {
            await this.plugin.openShadowVaultFor(profile);
          }
          this.display();
        }))
      .addButton(btn => btn.setButtonText('Edit').onClick(() => {
        new ProfileForm(this.app, profile, (updated) => {
          const idx = this.plugin.settings.profiles.findIndex(p => p.id === updated.id);
          if (idx >= 0) this.plugin.settings.profiles[idx] = updated;
          void this.plugin.saveSettings().then(() => this.display());
        }, this.plugin.getProfileFormDeps()).open();
      }))
      .addButton(btn => btn.setButtonText('Delete').setWarning().onClick(async () => {
        if (isActive) await this.plugin.disconnect();
        this.plugin.settings.profiles = this.plugin.settings.profiles.filter(p => p.id !== profile.id);
        await this.plugin.saveSettings();
        this.display();
      }));
  }
}

/**
 * Read-only modal that shows the in-memory telemetry counters as a
 * single text block (one line per counter). The "Copy" button hands
 * the same block to the clipboard so a BRAT tester can paste it
 * straight into a bug report — that's the entire point of the F22
 * surface.
 */
class TelemetryViewModal extends Modal {
  constructor(app: App, private readonly records: TelemetryRecord[]) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Telemetry counters' });
    contentEl.createEl('p', {
      text: 'In-memory deltas since the last flush. Safe to paste into a bug report.',
      cls: 'setting-item-description',
    });

    const text = this.formatRecords();
    const pre = contentEl.createEl('pre', { cls: 'remote-ssh-log-pre' });
    pre.textContent = text || '(no counters yet)';

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText('Copy to clipboard')
        .setCta()
        .onClick(() => {
          void navigator.clipboard.writeText(text);
          new Notice('Copied to clipboard');
        }))
      .addButton(btn => btn
        .setButtonText('Close')
        .onClick(() => this.close()));
  }

  onClose() { this.contentEl.empty(); }

  private formatRecords(): string {
    return this.records
      .map(r => r.kind === 'error'
        ? `error  ${r.category ?? '?'}${r.code !== undefined ? ` code=${r.code}` : ''}  ×${r.count}`
        : `recon  ${r.state ?? '?'}  ×${r.count}`)
      .sort()
      .join('\n');
  }
}
