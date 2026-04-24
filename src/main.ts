import { Plugin, Notice, WorkspaceLeaf } from 'obsidian';
import type { PluginSettings, SshProfile } from './types';
import { DEFAULT_SETTINGS, PLUGIN_ID } from './constants';
import { ConnectionPool } from './ssh/ConnectionPool';
import { AuthResolver } from './ssh/AuthResolver';
import { HostKeyStore } from './ssh/HostKeyStore';
import { SecretStore } from './ssh/SecretStore';
import { SyncEngine } from './sync/SyncEngine';
import { StatusBar } from './ui/StatusBar';
import { ConnectModal } from './ui/ConnectModal';
import { ConflictModal } from './ui/ConflictModal';
import { SyncLogView, SYNC_LOG_VIEW_TYPE } from './ui/SyncLogView';
import { SettingsTab } from './settings/SettingsTab';
import { LicenseGate } from './license/LicenseGate';
import { logger } from './util/logger';
import * as path from 'path';
import * as os from 'os';

export default class RemoteSshPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  gate = new LicenseGate();

  private secretStore  = new SecretStore();
  private authResolver = new AuthResolver(this.secretStore);
  private hostKeyStore = new HostKeyStore();
  private pool!: ConnectionPool;
  private engine!: SyncEngine;
  private statusBar!: StatusBar;

  async onload() {
    await this.loadSettings();

    this.pool   = new ConnectionPool(this.authResolver, this.hostKeyStore, this.gate);
    this.engine = new SyncEngine(this.pool, this.app, this, this.gate);

    logger.setDebug(this.settings.enableDebugLog);
    logger.setMaxLines(this.settings.maxLogLines);

    await this.gate.initialize(this.settings.licenseKey);

    this.addSettingTab(new SettingsTab(this.app, this));

    this.registerView(SYNC_LOG_VIEW_TYPE, leaf => new SyncLogView(leaf));

    this.statusBar = new StatusBar(this, () => this.onStatusBarClick());
    this.engine.onState(state => this.statusBar.update(state));

    this.engine.onConflict = async (conflicts) => {
      return new Promise(resolve => {
        new ConflictModal(this.app, conflicts, resolve).open();
      });
    };

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

    this.addCommand({
      id: 'force-sync',
      name: 'Force full sync now',
      callback: () => this.engine.forceFullSync().catch(e => new Notice(`Sync error: ${e.message}`)),
    });

    this.addCommand({
      id: 'open-sync-log',
      name: 'Open sync log',
      callback: () => this.openSyncLog(),
    });

    // Auto-reconnect if was connected on last unload
    if (this.settings.activeProfileId) {
      const profile = this.settings.profiles.find(p => p.id === this.settings.activeProfileId);
      if (profile) {
        logger.info(`Auto-reconnecting to ${profile.name}`);
        this.connectProfile(profile).catch(e =>
          new Notice(`Auto-reconnect failed: ${e.message}`)
        );
      }
    }
  }

  async onunload() {
    await this.engine.disconnect().catch(() => {});
    this.pool.destroyAll();
    this.statusBar.remove();
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
    const indexPath = path.join(
      os.homedir(),
      '.obsidian-remote',
      profile.id,
      'index.json',
    );

    const doConnect = async () => {
      await this.engine.connect(profile, indexPath);
      this.settings.activeProfileId = profile.id;
      await this.saveSettings();
      new Notice(`Remote SSH: Connected to ${profile.name}`);
    };

    // If auth needs a secret interactively, show ConnectModal first
    const needsInteractive = (
      profile.authMethod === 'password' ||
      (profile.authMethod === 'privateKey' && !profile.privateKeyPath)
    );

    if (needsInteractive) {
      new ConnectModal(this.app, [profile], this.authResolver, doConnect).open();
    } else {
      await doConnect().catch(e => new Notice(`Connect failed: ${e.message}`));
    }
  }

  async disconnect() {
    await this.engine.disconnect();
    this.settings.activeProfileId = null;
    await this.saveSettings();
    new Notice('Remote SSH: Disconnected');
  }

  openSyncLog() {
    const existing = this.app.workspace.getLeavesOfType(SYNC_LOG_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
    } else {
      const leaf = this.app.workspace.getLeaf(true);
      leaf.setViewState({ type: SYNC_LOG_VIEW_TYPE, active: true });
    }
  }

  private promptConnect() {
    const { profiles } = this.settings;
    if (profiles.length === 0) {
      new Notice('Remote SSH: No profiles configured. Add one in Settings → Remote SSH.');
      return;
    }
    // Show ConnectModal for both single and multi-profile cases
    // Single profile: skips picker and goes straight to auth step
    new ConnectModal(
      this.app,
      profiles,
      this.authResolver,
      profile => this.connectProfile(profile),
    ).open();
  }

  private onStatusBarClick() {
    const state = this.engine.getState();
    const { SyncState } = require('./types');
    if (state === SyncState.IDLE || state === SyncState.ERROR) {
      this.promptConnect();
    } else if (state === SyncState.WATCHING) {
      this.engine.forceFullSync().catch(e => new Notice(`Sync error: ${e.message}`));
    }
  }
}
