import { Plugin, Notice, FileSystemAdapter } from 'obsidian';
import type { PluginSettings, SshProfile } from './types';
import { SyncState } from './types';
import { DEFAULT_SETTINGS } from './constants';
import { SftpClient } from './ssh/SftpClient';
import { AuthResolver } from './ssh/AuthResolver';
import { HostKeyStore } from './ssh/HostKeyStore';
import { SecretStore } from './ssh/SecretStore';
import { StatusBar } from './ui/StatusBar';
import { ConnectModal } from './ui/ConnectModal';
import { SettingsTab } from './settings/SettingsTab';
import { logger } from './util/logger';
import { installErrorHook, uninstallErrorHook } from './util/errorHook';
import * as path from 'path';

export default class RemoteSshPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;

  private secretStore  = new SecretStore();
  private authResolver = new AuthResolver(this.secretStore);
  private hostKeyStore = new HostKeyStore();
  private client!: SftpClient;
  private statusBar!: StatusBar;
  private state: SyncState = SyncState.IDLE;

  async onload() {
    await this.loadSettings();

    logger.setDebug(this.settings.enableDebugLog);
    logger.setMaxLines(this.settings.maxLogLines);
    this.installObservability();

    this.client = new SftpClient(this.authResolver, this.hostKeyStore);
    this.client.onClose(({ unexpected }) => {
      if (unexpected) {
        this.setState(SyncState.ERROR);
        new Notice('Remote SSH: Connection lost');
      }
    });

    this.addSettingTab(new SettingsTab(this.app, this));

    this.statusBar = new StatusBar(this, () => this.onStatusBarClick());
    this.statusBar.update(this.state);

    this.addCommand({
      id: 'connect',
      name: 'Connect to remote vault',
      callback: () => this.promptConnect(),
    });

    this.addCommand({
      id: 'disconnect',
      name: 'Disconnect from remote vault',
      callback: () => this.disconnect(),
    });
  }

  async onunload() {
    await this.disconnect().catch(() => {});
    this.statusBar?.remove();
    this.uninstallObservability();
  }

  private installObservability(): void {
    try {
      const adapter = this.app.vault.adapter;
      if (adapter instanceof FileSystemAdapter) {
        const base = adapter.getBasePath();
        const logPath = path.join(base, '.obsidian', 'plugins', this.manifest.id, 'console.log');
        logger.installFileSink(logPath);
      } else {
        logger.warn('vault.adapter is not FileSystemAdapter; file sink disabled');
      }
    } catch (e) {
      logger.warn(`installFileSink failed: ${(e as Error).message}`);
    }
    logger.wrapConsole();
    installErrorHook();
    logger.info(`Plugin ${this.manifest.id} v${this.manifest.version} loaded`);
  }

  private uninstallObservability(): void {
    logger.info(`Plugin ${this.manifest.id} unloading`);
    uninstallErrorHook();
    logger.unwrapConsole();
    logger.uninstallFileSink();
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
    if (saved?.hostKeyStore) {
      this.hostKeyStore.load(saved.hostKeyStore);
    }
    if (saved?.secrets) {
      this.secretStore.load(saved.secrets);
    }
  }

  async saveSettings() {
    await this.saveData({
      ...this.settings,
      hostKeyStore: this.hostKeyStore.serialize(),
      secrets: this.secretStore.serialize(),
    });
  }

  async connectProfile(profile: SshProfile) {
    if (this.client.isAlive()) {
      new Notice('Remote SSH: Already connected. Disconnect first.');
      return;
    }
    this.setState(SyncState.CONNECTING);
    try {
      await this.client.connect(profile);
      // Smoke test: list the remote vault path so we surface auth/path errors immediately.
      const entries = await this.client.list(profile.remotePath);
      logger.info(`Smoke test: list ${profile.remotePath} returned ${entries.length} entries`);
    } catch (e) {
      this.setState(SyncState.ERROR);
      const msg = (e as Error).message;
      logger.error(`Connect failed: ${msg}`);
      new Notice(`Remote SSH: Connect failed — ${msg}`);
      try { await this.client.disconnect(); } catch { /* ignore */ }
      return;
    }
    this.setState(SyncState.CONNECTED);
    this.settings.activeProfileId = profile.id;
    await this.saveSettings();
    new Notice(`Remote SSH: Connected to ${profile.name} (adapter wiring pending — Phase 4-E onward)`);
  }

  async disconnect() {
    if (this.state === SyncState.IDLE) return;
    try {
      await this.client.disconnect();
    } catch (e) {
      logger.warn(`disconnect: ${(e as Error).message}`);
    }
    this.setState(SyncState.IDLE);
    this.settings.activeProfileId = null;
    await this.saveSettings();
    new Notice('Remote SSH: Disconnected');
  }

  private setState(s: SyncState) {
    this.state = s;
    this.statusBar?.update(s);
  }

  private promptConnect() {
    const { profiles } = this.settings;
    if (profiles.length === 0) {
      new Notice('Remote SSH: No profiles configured. Add one in Settings → Remote SSH.');
      return;
    }
    new ConnectModal(
      this.app,
      profiles,
      this.authResolver,
      profile => this.connectProfile(profile),
    ).open();
  }

  private onStatusBarClick() {
    if (this.state === SyncState.IDLE || this.state === SyncState.ERROR) {
      this.promptConnect();
    } else if (this.state === SyncState.CONNECTED) {
      this.disconnect();
    }
  }
}
