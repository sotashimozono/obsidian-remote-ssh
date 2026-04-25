import { Plugin, Notice, FileSystemAdapter } from 'obsidian';
import type { PluginSettings, SshProfile } from './types';
import { SyncState } from './types';
import { DEFAULT_SETTINGS } from './constants';
import { SftpClient } from './ssh/SftpClient';
import { AuthResolver } from './ssh/AuthResolver';
import { HostKeyStore } from './ssh/HostKeyStore';
import { SecretStore } from './ssh/SecretStore';
import { ReadCache } from './cache/ReadCache';
import { DirCache } from './cache/DirCache';
import { SftpDataAdapter } from './adapter/SftpDataAdapter';
import { AdapterPatcher } from './adapter/AdapterPatcher';
import { SftpRemoteFsClient } from './adapter/SftpRemoteFsClient';
import { RpcRemoteFsClient } from './adapter/RpcRemoteFsClient';
import { establishRpcConnection } from './transport/RpcConnection';
import { ServerDeployer } from './transport/ServerDeployer';
import { PathMapper, defaultClientId } from './path/PathMapper';
import * as fs from 'fs';
import { StatusBar } from './ui/StatusBar';
import { ConnectModal } from './ui/ConnectModal';
import { SettingsTab } from './settings/SettingsTab';
import { logger } from './util/logger';
import { installErrorHook, uninstallErrorHook } from './util/errorHook';
import { normalizeRemotePath } from './util/pathUtils';
import * as path from 'path';

const PATCHED_METHODS = [
  // read-side
  'getName', 'exists', 'stat', 'list', 'read', 'readBinary',
  // write-side
  'write', 'writeBinary', 'append', 'appendBinary', 'process',
  // fs ops
  'mkdir', 'remove', 'rmdir', 'rename', 'copy',
  // trash
  'trashSystem', 'trashLocal',
] as const;

export default class RemoteSshPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;

  private secretStore  = new SecretStore();
  private authResolver = new AuthResolver(this.secretStore);
  private hostKeyStore = new HostKeyStore();
  private client!: SftpClient;
  private statusBar!: StatusBar;
  private state: SyncState = SyncState.IDLE;
  private patcher: AdapterPatcher<object> | null = null;
  private dataAdapter: SftpDataAdapter | null = null;
  private readCache: ReadCache | null = null;
  private dirCache: DirCache | null = null;
  private activeRemoteBasePath: string | null = null;
  /** Authenticated daemon session, populated when the active profile uses transport='rpc'. */
  private rpcConnection: Awaited<ReturnType<typeof establishRpcConnection>> | null = null;
  /** ServerDeployer that owns the daemon process; invoked on disconnect to tear it down. */
  private daemonDeployer: ServerDeployer | null = null;

  async onload() {
    await this.loadSettings();

    logger.setDebug(this.settings.enableDebugLog);
    logger.setMaxLines(this.settings.maxLogLines);
    this.installObservability();

    this.client = new SftpClient(this.authResolver, this.hostKeyStore);
    this.client.onClose(({ unexpected }) => {
      if (unexpected) {
        this.restoreAdapter();
        this.setState(SyncState.ERROR);
        new Notice('Remote SSH: Connection lost');
      }
    });
    this.activeRemoteBasePath = null;

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

    this.addCommand({
      id: 'debug-patch-adapter',
      name: 'Debug: patch app.vault.adapter onto SFTP (read-side only)',
      callback: () => this.debugPatchAdapter(),
    });

    this.addCommand({
      id: 'debug-restore-adapter',
      name: 'Debug: restore app.vault.adapter to its original',
      callback: () => this.debugRestoreAdapter(),
    });

    this.addCommand({
      id: 'debug-list-root',
      name: 'Debug: list vault root via current adapter',
      callback: () => this.debugListRoot(),
    });

    this.addCommand({
      id: 'debug-test-rpc-tunnel',
      name: 'Debug: test RPC tunnel against obsidian-remote-server',
      callback: () => this.debugTestRpcTunnel(),
    });
  }

  async onunload() {
    // Restore adapter first so any in-flight Obsidian read calls see the
    // original FileSystemAdapter again before we tear down the SSH session.
    this.restoreAdapter();
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
    // We never come back online already connected; activeProfileId from disk
    // is stale on startup and only confuses the settings UI.
    this.settings.activeProfileId = null;
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
    const effectivePath = normalizeRemotePath(profile.remotePath);
    if (effectivePath !== profile.remotePath) {
      logger.info(`remotePath normalized: "${profile.remotePath}" → "${effectivePath}"`);
    }
    try {
      await this.client.connect(profile);
      const entries = await this.client.list(effectivePath);
      logger.info(`Smoke test: list ${effectivePath} returned ${entries.length} entries`);
    } catch (e) {
      this.setState(SyncState.ERROR);
      const msg = (e as Error).message;
      logger.error(`Connect failed: ${msg}`);
      new Notice(`Remote SSH: Connect failed — ${msg}`);
      try { await this.client.disconnect(); } catch { /* ignore */ }
      return;
    }

    const transport = profile.transport ?? 'sftp';
    let rpcSummary = '';
    if (transport === 'rpc') {
      try {
        await this.startRpcSession(profile, effectivePath);
        const caps = this.rpcConnection?.info.capabilities.length ?? 0;
        const ver  = this.rpcConnection?.info.version ?? '?';
        rpcSummary = ` — daemon ${ver}, ${caps} capabilities`;
      } catch (e) {
        // RPC startup failed; tear the SFTP session back down so the user
        // can retry from a clean state instead of half-connected.
        this.setState(SyncState.ERROR);
        const msg = (e as Error).message;
        logger.error(`RPC startup failed: ${msg}`);
        new Notice(`Remote SSH: RPC startup failed — ${msg}`);
        try { await this.client.disconnect(); } catch { /* ignore */ }
        return;
      }
    }

    // Adapter is NOT patched on connect: Obsidian still has paths it expects
    // to read locally (`.obsidian/workspace.json`, plugin data, etc.) until
    // PathMapper (Phase 4-J0) can redirect those to a per-client subtree.
    // Use the "Debug: patch adapter" command to opt in for now.
    this.activeRemoteBasePath = effectivePath;
    this.setState(SyncState.CONNECTED);
    this.settings.activeProfileId = profile.id;
    await this.saveSettings();
    new Notice(
      `Remote SSH: Connected to ${profile.name} via ${transport.toUpperCase()}${rpcSummary} ` +
      `(adapter NOT patched — use "Debug: patch adapter" to opt in)`,
    );
  }

  /**
   * Auto-deploy the daemon binary, open a unix-socket Duplex, and run
   * the framed `auth` + `server.info` handshake. On success
   * `this.rpcConnection` and `this.daemonDeployer` are populated and
   * the adapter patch flow can switch to the RPC transport.
   *
   * Throws on any step so callers can roll the SFTP session back.
   */
  private async startRpcSession(profile: SshProfile, effectivePath: string): Promise<void> {
    const localBinaryPath = this.locateDaemonBinary();
    if (!localBinaryPath) {
      throw new Error(
        'daemon binary not staged. Run `npm run build:server` (or `build:full`) and reload the plugin.',
      );
    }

    const remoteBinaryPath = '.obsidian-remote/server';
    const remoteSocketPath = profile.rpcSocketPath?.trim() || '.obsidian-remote/server.sock';
    const remoteTokenPath  = profile.rpcTokenPath?.trim()  || '.obsidian-remote/token';

    logger.info(`startRpcSession: deploying daemon to serve ${effectivePath}`);
    const deployer = new ServerDeployer(this.client);
    const deploy = await deployer.deploy({
      localBinaryPath,
      remoteBinaryPath,
      remoteVaultRoot: effectivePath,
      remoteSocketPath,
      remoteTokenPath,
    });
    this.daemonDeployer = deployer;
    logger.info(`startRpcSession: daemon up; token len=${deploy.token.length}`);

    const stream = await this.client.openUnixStream(deploy.remoteSocketPath);
    this.rpcConnection = await establishRpcConnection({ stream, token: deploy.token });
    logger.info(
      `startRpcSession: handshake complete; daemon ${this.rpcConnection.info.version} ` +
      `(protocol v${this.rpcConnection.info.protocolVersion})`,
    );
  }

  /**
   * Idempotent: it always restores the adapter, drops the active SSH
   * client, clears `activeProfileId`, and parks the state machine on
   * IDLE. Calling it from a stale UI button (where state was already
   * IDLE because the plugin had just reloaded) is a supported flow.
   */
  async disconnect() {
    const wasActive = this.state !== SyncState.IDLE
      || this.client?.isAlive()
      || this.settings.activeProfileId !== null;
    this.restoreAdapter();
    this.activeRemoteBasePath = null;

    // Close the RPC tunnel before stopping the daemon so the daemon
    // sees a clean disconnect rather than a half-open socket.
    if (this.rpcConnection) {
      try { this.rpcConnection.close(); }
      catch (e) { logger.warn(`rpcConnection.close: ${(e as Error).message}`); }
      this.rpcConnection = null;
    }
    if (this.daemonDeployer && this.client?.isAlive()) {
      try { await this.daemonDeployer.stop(); }
      catch (e) { logger.warn(`daemon stop: ${(e as Error).message}`); }
    }
    this.daemonDeployer = null;

    if (this.client?.isAlive()) {
      try {
        await this.client.disconnect();
      } catch (e) {
        logger.warn(`disconnect: ${(e as Error).message}`);
      }
    }
    this.setState(SyncState.IDLE);
    if (this.settings.activeProfileId !== null) {
      this.settings.activeProfileId = null;
      await this.saveSettings();
    }
    if (wasActive) new Notice('Remote SSH: Disconnected');
  }

  private debugPatchAdapter(): void {
    if (this.state !== SyncState.CONNECTED || !this.activeRemoteBasePath) {
      new Notice('Remote SSH: connect first');
      return;
    }
    if (this.patcher?.isPatched()) {
      new Notice('Remote SSH: adapter already patched');
      return;
    }
    const targetAdapter = this.app.vault.adapter as unknown as object;
    this.readCache = new ReadCache();
    this.dirCache = new DirCache();
    // Pick the transport that matches the active session: when an
    // RPC tunnel is up, route everything through the daemon; otherwise
    // fall back to the direct-SFTP wrapper. The adapter itself is
    // unaware of the choice — both clients implement RemoteFsClient.
    const fsClient = this.rpcConnection
      ? new RpcRemoteFsClient(this.rpcConnection.rpc)
      : new SftpRemoteFsClient(this.client);
    const transportLabel = this.rpcConnection ? 'RPC' : 'SFTP';
    // Per-client path remapping: client-private files like
    // .obsidian/workspace.json get redirected into a per-client subtree
    // on the remote so two machines on the same vault don't trample
    // each other's UI state. Phase 4-J0.
    const clientId = defaultClientId();
    const mapper = new PathMapper(clientId);
    logger.info(`PathMapper: clientId="${clientId}"`);
    this.dataAdapter = new SftpDataAdapter(
      fsClient,
      this.activeRemoteBasePath,
      this.readCache,
      this.dirCache,
      this.app.vault.getName(),
      mapper,
    );
    this.patcher = new AdapterPatcher(targetAdapter, this.dataAdapter);
    try {
      this.patcher.patch(PATCHED_METHODS as unknown as ReadonlyArray<keyof object & string>);
      logger.info(`Adapter patched via ${transportLabel}: [${PATCHED_METHODS.join(', ')}]`);
      new Notice(`Remote SSH: adapter patched via ${transportLabel} (${PATCHED_METHODS.length} methods)`);
    } catch (e) {
      logger.error(`Adapter patch failed: ${(e as Error).message}`);
      this.patcher = null;
      this.dataAdapter = null;
      this.readCache = null;
      this.dirCache = null;
      new Notice(`Adapter patch failed: ${(e as Error).message}`);
    }
  }

  private debugRestoreAdapter(): void {
    if (!this.patcher?.isPatched()) {
      new Notice('Remote SSH: adapter is not patched');
      return;
    }
    this.restoreAdapter();
    new Notice('Remote SSH: adapter restored');
  }

  private restoreAdapter(): void {
    if (this.patcher?.isPatched()) {
      try {
        this.patcher.restore();
        logger.info('Adapter restored');
      } catch (e) {
        logger.error(`Adapter restore failed: ${(e as Error).message}`);
      }
    }
    this.patcher = null;
    this.dataAdapter = null;
    this.readCache = null;
    this.dirCache = null;
  }

  private async debugListRoot(): Promise<void> {
    try {
      const out = await this.app.vault.adapter.list('');
      const via = this.patcher?.isPatched() ? 'PATCHED (SFTP)' : 'ORIGINAL (local)';
      logger.info(`debugListRoot via ${via}: ${out.files.length} files, ${out.folders.length} folders`);
      logger.info(`  files (first 5): ${out.files.slice(0, 5).join(', ')}`);
      logger.info(`  folders (first 5): ${out.folders.slice(0, 5).join(', ')}`);
      new Notice(`List via ${via}: ${out.files.length} files, ${out.folders.length} folders (see console.log)`);
    } catch (e) {
      logger.error(`debugListRoot failed: ${(e as Error).message}`);
      new Notice(`debugListRoot failed: ${(e as Error).message}`);
    }
  }

  /**
   * Full α-path round-trip with auto-deploy:
   *   1. Locate the staged daemon binary inside the plugin folder.
   *   2. Upload it over the existing SFTP session, kill any prior
   *      daemon, start the new one with `nohup`, wait for the token
   *      to land on disk.
   *   3. Open a unix-socket Duplex through the same SSH connection.
   *   4. Run `auth` + `server.info`.
   *   5. Smoke-list `activeRemoteBasePath` via `RpcRemoteFsClient`.
   *
   * Each step logs to `console.log` so the daemon and plugin can be
   * debugged in tandem. Optional overrides on the active profile
   * (`rpcSocketPath`, `rpcTokenPath`) are honoured; both default to
   * `.obsidian-remote/{server.sock,token}` (home-relative).
   */
  private async debugTestRpcTunnel(): Promise<void> {
    if (this.state !== SyncState.CONNECTED || !this.client.isAlive()) {
      new Notice('Remote SSH: connect first (the RPC tunnel rides the SFTP session)');
      return;
    }
    const activeId = this.settings.activeProfileId;
    const profile = this.settings.profiles.find(p => p.id === activeId);
    if (!profile) {
      new Notice('Remote SSH: no active profile');
      return;
    }

    const localBinaryPath = this.locateDaemonBinary();
    if (!localBinaryPath) {
      new Notice(
        'Remote SSH: daemon binary not staged. ' +
        'Run `npm run build:server` (or `build:full`) and reload the plugin.',
      );
      return;
    }

    const remoteVaultRoot = normalizeRemotePath(profile.remotePath);
    const remoteBinaryPath = '.obsidian-remote/server';
    const remoteSocketPath = profile.rpcSocketPath?.trim() || '.obsidian-remote/server.sock';
    const remoteTokenPath  = profile.rpcTokenPath?.trim()  || '.obsidian-remote/token';

    logger.info(`debugTestRpcTunnel: local binary = ${localBinaryPath}`);
    logger.info(`debugTestRpcTunnel: remote vault = ${remoteVaultRoot}`);
    logger.info(`debugTestRpcTunnel: remote socket = ${remoteSocketPath}`);

    let connection: Awaited<ReturnType<typeof establishRpcConnection>> | null = null;
    try {
      const deployer = new ServerDeployer(this.client);
      const deploy = await deployer.deploy({
        localBinaryPath,
        remoteBinaryPath,
        remoteVaultRoot,
        remoteSocketPath,
        remoteTokenPath,
      });
      logger.info(`debugTestRpcTunnel: daemon up; token len=${deploy.token.length}`);

      const stream = await this.client.openUnixStream(deploy.remoteSocketPath);
      connection = await establishRpcConnection({ stream, token: deploy.token });

      const rpcFs = new RpcRemoteFsClient(connection.rpc);
      const entries = await rpcFs.list(remoteVaultRoot);
      logger.info(`debugTestRpcTunnel: list("${remoteVaultRoot}") returned ${entries.length} entries`);
      for (const e of entries.slice(0, 5)) {
        logger.info(`  - ${e.name} (${e.isDirectory ? 'dir' : 'file'}, ${e.size}B, mtime ${e.mtime})`);
      }
      new Notice(
        `RPC OK: daemon ${connection.info.version}, ${entries.length} entries at "${remoteVaultRoot}" ` +
        `(see console.log)`,
      );
    } catch (e) {
      const msg = (e as Error).message;
      logger.error(`debugTestRpcTunnel failed: ${msg}`);
      new Notice(`RPC test failed: ${msg}`);
    } finally {
      try { connection?.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Resolve the staged Linux/amd64 daemon binary that lives next to
   * `main.js` in the plugin's vault folder. Returns the absolute path
   * or `null` if the binary hasn't been built (run `npm run
   * build:server` to populate it). Other architectures land in
   * follow-up phases.
   */
  private locateDaemonBinary(): string | null {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    const candidate = path.join(
      adapter.getBasePath(),
      '.obsidian', 'plugins', this.manifest.id,
      'server-bin', 'obsidian-remote-server-linux-amd64',
    );
    return fs.existsSync(candidate) ? candidate : null;
  }

  isConnected(): boolean {
    return this.state === SyncState.CONNECTED;
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
