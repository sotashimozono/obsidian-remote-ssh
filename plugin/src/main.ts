import { Plugin, Notice, FileSystemAdapter, TFile, TFolder } from 'obsidian';
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
import { ResourceBridge } from './adapter/ResourceBridge';
import { WriteConflictModal } from './ui/WriteConflictModal';
import { SftpRemoteFsClient } from './adapter/SftpRemoteFsClient';
import { RpcRemoteFsClient } from './adapter/RpcRemoteFsClient';
import { establishRpcConnection } from './transport/RpcConnection';
import { ServerDeployer } from './transport/ServerDeployer';
import { ReconnectManager } from './transport/ReconnectManager';
import type { ReconnectState } from './transport/ReconnectManager';
import { DEFAULT_BACKOFF } from './transport/Backoff';
import { PathMapper, defaultClientId, defaultUserName, sanitizeClientId } from './path/PathMapper';
import { interpretWatchEvent } from './path/WatchEventFilter';
import type { FsChangedParams } from './proto/types';
import * as fs from 'fs';
import { StatusBar } from './ui/StatusBar';
import { ConnectModal } from './ui/ConnectModal';
import { SettingsTab } from './settings/SettingsTab';
import { logger } from './util/logger';
import { VaultModelBuilder, type RemoteEntry } from './vault/VaultModelBuilder';
import { ObsidianRegistry } from './shadow/ObsidianRegistry';
import { ShadowVaultBootstrap } from './shadow/ShadowVaultBootstrap';
import { ShadowVaultManager } from './shadow/ShadowVaultManager';
import { WindowSpawner } from './shadow/WindowSpawner';
import * as os from 'os';
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
  // resources (binary URL for <img> / <iframe> / <audio>)
  'getResourcePath',
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
  /** Active daemon-side fs.watch subscription id (set after debugPatchAdapter). */
  private rpcWatchSubscriptionId: string | null = null;
  /** Disposer returned by RpcClient.onNotification('fs.changed', ...). */
  private rpcWatchHandlerDisposer: (() => void) | null = null;
  /** PathMapper used by the active patched adapter; needed to interpret fs.changed paths. */
  private activePathMapper: PathMapper | null = null;
  /** Localhost HTTP bridge serving binary vault assets to the webview. */
  private resourceBridge: ResourceBridge | null = null;
  /**
   * Profile in use by the current session. Held so the reconnect
   * loop can re-issue the connect / RPC / fs.watch sequence after an
   * unexpected SSH drop without forcing the user back to the modal.
   */
  private activeProfile: SshProfile | null = null;
  /**
   * Active reconnect-loop instance. Non-null between an unexpected
   * disconnect and either recovery or final failure / cancel.
   */
  private reconnectManager: ReconnectManager | null = null;

  async onload() {
    await this.loadSettings();

    logger.setDebug(this.settings.enableDebugLog);
    logger.setMaxLines(this.settings.maxLogLines);
    this.installObservability();

    this.client = new SftpClient(this.authResolver, this.hostKeyStore);
    this.client.onClose(({ unexpected }) => {
      // Intentional disconnects are driven by `disconnect()` which
      // already handles cleanup. Unexpected ones (network drop, peer
      // killed sshd, ...) hand off to the reconnect loop, which keeps
      // the patched adapter alive via swapClient instead of forcing a
      // restore + re-patch round-trip.
      if (unexpected) {
        new Notice('Remote SSH: Connection lost — reconnecting…');
        void this.startReconnect();
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
      id: 'cancel-reconnect',
      name: 'Cancel ongoing reconnect',
      checkCallback: (checking) => {
        const active = this.reconnectManager?.isActive() ?? false;
        if (checking) return active;
        if (active) void this.cancelReconnect();
        return true;
      },
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

    this.addCommand({
      id: 'debug-dump-api',
      name: 'Debug: dump adapter / vault API surface to console.log',
      callback: () => this.debugDumpVaultAdapterAPI(),
    });

    this.addCommand({
      id: 'debug-build-vault-from-remote',
      name: 'Debug: build vault model from remote (POC)',
      checkCallback: (checking: boolean) => {
        if (!this.client?.isAlive()) return false;
        if (!checking) void this.debugBuildVaultFromRemote();
        return true;
      },
    });

    this.addCommand({
      id: 'debug-open-shadow-vault',
      name: 'Debug: open shadow vault for active profile (Phase 2 POC)',
      checkCallback: (checking: boolean) => {
        // No active profile = nothing to shadow.
        if (!this.settings.activeProfileId) return false;
        if (!checking) void this.debugOpenShadowVault();
        return true;
      },
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

    this.activeRemoteBasePath = effectivePath;
    this.activeProfile = profile;
    this.setState(SyncState.CONNECTED);
    this.settings.activeProfileId = profile.id;
    await this.saveSettings();

    // Auto-patch is the VSCode Remote-SSH equivalent of "open folder
    // on host" — without it the user sees a connected status bar but
    // their vault is still local-only. We default to ON; debug
    // workflows opt out via settings.
    if (this.settings.autoPatchAdapter) {
      const patched = await this.patchAdapter();
      if (!patched) {
        new Notice('Remote SSH: adapter patch failed — disconnecting');
        await this.disconnect().catch(() => { /* already errored */ });
        return;
      }
    }

    const userLabel = this.formatUserLabel();
    const patchSuffix = this.settings.autoPatchAdapter
      ? ''
      : ' (adapter NOT patched — autoPatchAdapter is off)';
    new Notice(
      `Remote SSH: Connected to ${profile.name} as ${userLabel} via ${transport.toUpperCase()}${rpcSummary}${patchSuffix}`,
    );
  }

  /**
   * Build a `userName@clientId` label using the active settings,
   * with sensible fallbacks. Used for the connect notice and (later)
   * for any presence info written alongside the per-client subtree.
   */
  private formatUserLabel(): string {
    const userName = (this.settings.userName?.trim() || defaultUserName());
    const clientId = this.resolveClientId();
    return `${userName}@${clientId}`;
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
   * Pick the clientId that this session should use for PathMapper.
   * Falls back to the OS hostname when the user hasn't set an
   * override; either way the result is sanitized so it's safe as a
   * directory name on the remote.
   */
  private resolveClientId(): string {
    const override = (this.settings.clientId ?? '').trim();
    if (override) return sanitizeClientId(override);
    return defaultClientId();
  }

  /**
   * Read accessor for `rpcConnection`. Used by `reconnectAttempt`
   * after `startRpcSession` may have re-populated the field via
   * `this.`, which the TypeScript flow analyser narrows away
   * because it can't see the cross-method assignment.
   */
  private currentRpcConnection(): Awaited<ReturnType<typeof establishRpcConnection>> | null {
    return this.rpcConnection;
  }

  /**
   * User-driven cancel of the in-flight reconnect loop. Differs from
   * `disconnect()` in that it doesn't try to stop a daemon (the SSH
   * session is already dead) and it leaves `activeProfileId` alone so
   * the user can hit "connect" again from the StatusBar without
   * picking the profile again.
   */
  private async cancelReconnect(): Promise<void> {
    if (!this.reconnectManager?.isActive()) return;
    this.reconnectManager.cancel();
    this.reconnectManager = null;
    // Drop the patched adapter so Obsidian stops fielding "reconnecting"
    // errors and falls back to the original FileSystemAdapter; the
    // user is on their own to reconnect.
    this.restoreAdapter();
    this.setState(SyncState.ERROR);
    new Notice('Remote SSH: Reconnect cancelled');
  }

  /**
   * Drive the reconnect loop after an unexpected SSH drop.
   *
   * Idempotent: a second unexpected close while a loop is already
   * in flight is a no-op (the manager keeps trying). Cancellation
   * happens via `disconnect()`.
   */
  private async startReconnect(): Promise<void> {
    if (this.reconnectManager?.isActive()) return;
    if (!this.activeProfile) {
      logger.warn('startReconnect: no active profile to reconnect with');
      this.setState(SyncState.ERROR);
      return;
    }
    const maxRetries = this.settings.reconnectMaxRetries ?? DEFAULT_SETTINGS.reconnectMaxRetries;
    if (maxRetries <= 0) {
      // Auto-reconnect disabled — fall back to the pre-Phase-4-K
      // behaviour: tear the patched adapter down and park on ERROR.
      logger.info('startReconnect: auto-reconnect disabled (reconnectMaxRetries <= 0)');
      this.restoreAdapter();
      this.setState(SyncState.ERROR);
      return;
    }
    this.setState(SyncState.RECONNECTING);
    // Park every adapter call on a deterministic "reconnecting" error
    // (read-from-cache where possible) so write attempts during the
    // outage don't silently corrupt remote state.
    this.dataAdapter?.setReconnecting(true);
    const manager = new ReconnectManager({
      attempt: () => this.reconnectAttempt(),
      onState: (s) => this.onReconnectStateChange(s),
      backoff: {
        ...DEFAULT_BACKOFF,
        maxRetries,
      },
    });
    this.reconnectManager = manager;
    await manager.run();
  }

  /**
   * One reconcile pass: re-establish SSH, redeploy + re-handshake the
   * daemon if the active transport is RPC, rebind the patched adapter
   * to the fresh client, and re-subscribe to fs.watch if the patched
   * adapter had been listening before. Throws to signal a retryable
   * failure.
   */
  private async reconnectAttempt(): Promise<void> {
    const profile = this.activeProfile;
    if (!profile) throw new Error('no active profile');

    // 1. SSH session.
    if (!this.client.isAlive()) {
      await this.client.connect(profile);
    }

    // 2. RPC tunnel (if the profile uses it). The previous
    // rpcConnection is dead because the underlying ssh stream is
    // gone — drop the reference and redeploy. Always-redeploy is
    // simpler than probing daemon liveness, and ServerDeployer
    // already kills any prior process at startup.
    const transport = profile.transport ?? 'sftp';
    if (this.rpcConnection) {
      try { this.rpcConnection.close(); } catch { /* already dead */ }
      this.rpcConnection = null;
    }
    if (transport === 'rpc') {
      const effectivePath = this.activeRemoteBasePath ?? normalizeRemotePath(profile.remotePath);
      await this.startRpcSession(profile, effectivePath);
    }

    // 3. Adapter rebind. If the user had patched the adapter, swap
    // its underlying client to the fresh transport instead of going
    // through restore + re-patch (which would force editors to
    // re-render and lose scroll position).
    if (this.dataAdapter) {
      // The cast hides the narrow-to-null TS did above; startRpcSession
      // may have written this.rpcConnection back via `this.`, which
      // the flow analyser doesn't track across method boundaries.
      const freshRpc = this.currentRpcConnection();
      const newClient = freshRpc
        ? new RpcRemoteFsClient(freshRpc.rpc)
        : new SftpRemoteFsClient(this.client);
      this.dataAdapter.swapClient(newClient);
    }

    // 4. fs.watch re-subscribe. The old subscription id is dead with
    // its session, so clear local bookkeeping before resubscribing.
    this.rpcWatchSubscriptionId = null;
    if (this.rpcWatchHandlerDisposer) {
      this.rpcWatchHandlerDisposer();
      this.rpcWatchHandlerDisposer = null;
    }
    if (this.activePathMapper && this.rpcConnection) {
      await this.subscribeToFsChanged();
    }
  }

  /**
   * Project the manager's state onto the StatusBar + Notice surface
   * and, on terminal states, clean up.
   */
  private onReconnectStateChange(s: ReconnectState): void {
    if (s.kind === 'waiting') {
      const seconds = Math.max(1, Math.round(s.delayMs / 1000));
      this.statusBar.update(
        SyncState.RECONNECTING,
        `Remote SSH: Reconnecting (${s.attempt}/${s.totalAttempts}) in ${seconds}s…`,
      );
    } else if (s.kind === 'attempting') {
      this.statusBar.update(
        SyncState.RECONNECTING,
        `Remote SSH: Reconnecting (attempt ${s.attempt}/${s.totalAttempts})…`,
      );
    } else if (s.kind === 'recovered') {
      this.dataAdapter?.setReconnecting(false);
      this.setState(SyncState.CONNECTED);
      new Notice('Remote SSH: Reconnected');
      this.reconnectManager = null;
    } else if (s.kind === 'failed') {
      // Give up: tear the patched adapter down so Obsidian falls
      // back to local file:// reads instead of blocking forever on a
      // dead transport. restoreAdapter clears dataAdapter so the
      // setReconnecting flag goes with it.
      this.restoreAdapter();
      this.setState(SyncState.ERROR);
      new Notice(`Remote SSH: Reconnect failed — ${s.reason}`);
      this.reconnectManager = null;
    } else if (s.kind === 'cancelled') {
      this.dataAdapter?.setReconnecting(false);
      this.reconnectManager = null;
    }
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
    // Stop any in-flight reconnect loop before tearing down so the
    // attempt callback doesn't observe a half-disposed session.
    if (this.reconnectManager) {
      this.reconnectManager.cancel();
      this.reconnectManager = null;
    }
    this.restoreAdapter();
    this.activeRemoteBasePath = null;
    this.activeProfile = null;

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

  /**
   * Build the SftpDataAdapter, start the ResourceBridge, monkey-patch
   * `app.vault.adapter`, and subscribe to fs.watch when the active
   * transport is RPC.
   *
   * Returns true on success, false on failure. Silent — the caller
   * decides what notice (if any) to surface; both
   * `connectProfile`'s auto-patch and the manual debug command have
   * different opinions on phrasing.
   */
  private async patchAdapter(): Promise<boolean> {
    if (this.state !== SyncState.CONNECTED || !this.activeRemoteBasePath) {
      logger.warn('patchAdapter: state is not CONNECTED');
      return false;
    }
    if (this.patcher?.isPatched()) {
      logger.info('patchAdapter: adapter already patched');
      return true;
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
    const clientId = this.resolveClientId();
    const mapper = new PathMapper(clientId);
    logger.info(`PathMapper: clientId="${clientId}"`);

    // Spin up the localhost binary bridge so getResourcePath has
    // somewhere to send Obsidian. The bridge is best-effort: if it
    // fails to bind we still patch and just lose image rendering.
    const bridge = new ResourceBridge();
    try {
      await bridge.start(p => this.fetchBinaryForBridge(p));
      this.resourceBridge = bridge;
    } catch (e) {
      logger.warn(`ResourceBridge: start failed: ${(e as Error).message}`);
      this.resourceBridge = null;
    }

    // The Go daemon already knows the absolute vault root via its
    // `--vault-root` flag, so RPC clients must send paths RELATIVE to
    // that root (empty string for the root itself). Sending the same
    // `work/VaultDev` prefix the SFTP path needs would double up:
    // daemon-side `Resolve(absRoot, "work/VaultDev")` becomes
    // `<absRoot>/work/VaultDev`, missing the real vault entirely
    // (or — when a stale doubled mirror exists — quietly listing it).
    // The SFTP transport has no such root-knowing server; it does need
    // the prefix to anchor calls at the vault.
    const adapterRemoteBase = this.rpcConnection ? '' : this.activeRemoteBasePath;
    this.dataAdapter = new SftpDataAdapter(
      fsClient,
      adapterRemoteBase,
      this.readCache,
      this.dirCache,
      this.app.vault.getName(),
      mapper,
      this.resourceBridge,
      // On a precondition-failed write, surface a modal asking
      // whether to clobber the remote. Only meaningful on the RPC
      // transport (the SFTP wrapper ignores expectedMtime).
      (vaultPath) => new WriteConflictModal(this.app, vaultPath).prompt(),
    );
    this.patcher = new AdapterPatcher(targetAdapter, this.dataAdapter);
    try {
      this.patcher.patch(PATCHED_METHODS as unknown as ReadonlyArray<keyof object & string>);
      this.activePathMapper = mapper;
      logger.info(`Adapter patched via ${transportLabel}: [${PATCHED_METHODS.join(', ')}]`);
    } catch (e) {
      logger.error(`Adapter patch failed: ${(e as Error).message}`);
      this.patcher = null;
      this.dataAdapter = null;
      this.readCache = null;
      this.dirCache = null;
      // Patch failed before we ever served a URL, so no point keeping
      // the bridge alive for nobody.
      void this.stopResourceBridge();
      return false;
    }

    // Live-update subscription is only meaningful on the RPC transport;
    // the SFTP fallback has no notification channel.
    if (this.rpcConnection) {
      void this.subscribeToFsChanged();
    }

    // Force Obsidian to walk the vault root through the just-patched
    // adapter so the in-memory file model matches the remote — without
    // this, File Explorer keeps showing whatever local state it had
    // when the vault opened (e.g. a dev-vault that's a copy of the
    // user's main vault). Failure here is non-fatal; the adapter is
    // already patched and reads will work.
    await this.reconcileVaultRoot();
    return true;
  }

  /**
   * Bring the vault's in-memory file model in line with whatever the
   * current adapter sees on disk. Used right after a successful
   * `patchAdapter` (so File Explorer shows the remote vault) and
   * after `restoreAdapter` (so the local view comes back).
   *
   * The diagnostic dump in PR #54 confirmed `app.vault.adapter`
   * exposes `reconcileFile(path)` but **not** `reconcileFolder` /
   * `vault.scan` on the user's Obsidian build (1.5+ era), and that
   * `reconcileFile('')` blows up with "startsWith of undefined" —
   * the API expects an actual file path, not the root.
   *
   * So we drive it ourselves:
   *   1. Walk every file currently visible through the (patched)
   *      adapter and call `reconcileFile(path)` for each. New files
   *      land in the vault's TFile map; existing ones get their
   *      mtime checked.
   *   2. Iterate the vault's known TFile entries and call
   *      `reconcileFile(path)` for every file the walk *didn't*
   *      already touch. The adapter's stat returns "not found" for
   *      those, and Obsidian fires the deletion path internally.
   *
   * The 2-pass converges the model in both directions. Folders are
   * derived from file paths, so we don't need a separate folder
   * reconcile.
   */
  private async reconcileVaultRoot(): Promise<void> {
    type ReconcileFile = (path: string, oldPath?: string) => void | Promise<void>;
    const adapter = this.app.vault.adapter as unknown as {
      reconcileFile?: ReconcileFile;
    };
    if (typeof adapter.reconcileFile !== 'function') {
      logger.warn(
        'app.vault.adapter.reconcileFile unavailable on this Obsidian build. '
        + 'Run "Remote SSH: Debug: dump adapter / vault API surface" '
        + 'and report back so we can target a different hook.',
      );
      return;
    }
    const reconcile = adapter.reconcileFile.bind(this.app.vault.adapter);

    // Pass 1: walk the (patched) adapter's view, reconcile every
    // file we find. We use a manual BFS over `list(folder)` rather
    // than `listRecursive` because not every adapter implementation
    // exposes the recursive flavour.
    const seenRemote = new Set<string>();
    const queue: string[] = [''];
    while (queue.length > 0) {
      const folder = queue.shift()!;
      let listing: { files: string[]; folders: string[] };
      try {
        listing = await this.app.vault.adapter.list(folder);
      } catch (e) {
        logger.warn(`reconcileVaultRoot: list("${folder}") failed: ${(e as Error).message}`);
        continue;
      }
      for (const file of listing.files) {
        seenRemote.add(file);
        try {
          await reconcile(file);
        } catch (e) {
          logger.warn(`reconcileVaultRoot: reconcileFile("${file}") threw: ${(e as Error).message}`);
        }
      }
      for (const child of listing.folders) {
        queue.push(child);
      }
    }

    // Pass 2: anything in the vault model that the walk didn't see
    // is a leftover from before the swap. reconcileFile sees a stat
    // miss and fires the deletion path; the entry leaves the vault
    // model on its own.
    const known = this.app.vault.getFiles();
    let dropped = 0;
    for (const f of known) {
      if (seenRemote.has(f.path)) continue;
      try {
        await reconcile(f.path);
        dropped++;
      } catch (e) {
        logger.warn(`reconcileVaultRoot: drop reconcile("${f.path}") threw: ${(e as Error).message}`);
      }
    }
    logger.info(
      `Vault model reconciled: ${seenRemote.size} adapter files visited, `
      + `${dropped} stale entries pruned`,
    );
  }

  /**
   * Diagnostic command: log the method names on `app.vault.adapter`
   * and `app.vault` (own + first-prototype) so we can target the
   * right reconcile-equivalent on Obsidian builds where the usual
   * suspects aren't reachable. Surfaces only function-typed members
   * to keep the log readable.
   */
  private debugDumpVaultAdapterAPI(): void {
    const fnsOn = (obj: object): string[] => {
      const own = Object.getOwnPropertyNames(obj)
        .filter(k => typeof (obj as Record<string, unknown>)[k] === 'function');
      const proto = Object.getPrototypeOf(obj);
      const inherited = proto
        ? Object.getOwnPropertyNames(proto)
            .filter(k => typeof (proto as Record<string, unknown>)[k] === 'function')
        : [];
      return [...new Set([...own, ...inherited])].sort();
    };

    const adapterFns = fnsOn(this.app.vault.adapter as unknown as object);
    const vaultFns   = fnsOn(this.app.vault as unknown as object);

    logger.info(`debug-api: app.vault.adapter functions (${adapterFns.length}):`);
    for (const n of adapterFns) logger.info(`  - ${n}`);
    logger.info(`debug-api: app.vault functions (${vaultFns.length}):`);
    for (const n of vaultFns) logger.info(`  - ${n}`);

    new Notice(
      `Remote SSH: dumped ${adapterFns.length} adapter + ${vaultFns.length} `
      + 'vault method names to console.log',
    );
  }

  /**
   * POC for the shadow-vault architecture (see
   * docs/architecture-shadow-vault.md, Phase 1): walk the patched
   * adapter, then hand the resulting entry list to `VaultModelBuilder`
   * which materialises TFile/TFolder objects in `app.vault.fileMap`
   * and fires `vault.trigger('create', file)` for each new file. File
   * Explorer should redraw with the remote tree.
   *
   * Stat is intentionally skipped per file in this POC — every entry
   * lands with zero ctime/mtime/size. Shadow-vault Phase 4 will
   * decide whether to batch-stat at walk time or stat lazily.
   *
   * Run from a vault that's already connected to a profile via the
   * existing in-place patch flow (Tier 1-A); the command is hidden
   * unless `this.client?.isAlive()`.
   */
  private async debugBuildVaultFromRemote(): Promise<void> {
    const adapter = this.app.vault.adapter as unknown as {
      list(p: string): Promise<{ files: string[]; folders: string[] }>;
    };

    const start = Date.now();
    new Notice('Remote SSH POC: walking remote tree…');

    const entries: RemoteEntry[] = [];
    const queue: string[] = [''];
    while (queue.length > 0) {
      const folder = queue.shift()!;
      let listing: { files: string[]; folders: string[] };
      try {
        listing = await adapter.list(folder);
      } catch (e) {
        logger.warn(`debug-build-vault: list("${folder}") failed: ${(e as Error).message}`);
        continue;
      }
      for (const sub of listing.folders) {
        if (!sub) continue;
        entries.push({ path: sub, isDirectory: true, ctime: 0, mtime: 0, size: 0 });
        queue.push(sub);
      }
      for (const file of listing.files) {
        if (!file) continue;
        entries.push({ path: file, isDirectory: false, ctime: 0, mtime: 0, size: 0 });
      }
    }
    const walkMs = Date.now() - start;
    logger.info(`debug-build-vault: walked ${entries.length} entries in ${walkMs}ms`);

    const builder = new VaultModelBuilder(this.app.vault, { TFile, TFolder });
    const result = await builder.build(entries);
    const totalMs = Date.now() - start;

    const summary =
      `built ${result.filesAdded}f + ${result.foldersAdded}d, ` +
      `skipped ${result.skipped}, errors ${result.errors.length} (${totalMs}ms)`;
    new Notice(`Remote SSH POC: ${summary}`);
    if (result.errors.length > 0) {
      logger.warn(
        `debug-build-vault: first 5 errors: ${JSON.stringify(result.errors.slice(0, 5), null, 2)}`,
      );
    }
  }

  /**
   * POC for the shadow-vault flow (Phase 2 in
   * docs/architecture-shadow-vault.md): bootstrap the shadow vault
   * for the active profile and open it in a new Obsidian window.
   * Phase 4 will wire the new window's plugin onload to auto-connect
   * and run VaultModelBuilder; here we only verify Phase 2's half:
   * the dir gets created with the right contents and Obsidian opens
   * a window pointed at it.
   *
   * Does NOT require an SSH connection — the shadow vault setup is
   * a local-disk operation; the connect happens later, in the
   * shadow window.
   */
  private async debugOpenShadowVault(): Promise<void> {
    const profileId = this.settings.activeProfileId;
    if (!profileId) {
      new Notice('Remote SSH POC: no active profile selected');
      return;
    }
    const profile = this.settings.profiles.find(p => p.id === profileId);
    if (!profile) {
      new Notice(`Remote SSH POC: active profile id ${profileId} not found in profiles list`);
      return;
    }

    // Source dir: where this running plugin lives, so the shadow
    // vault's plugin install symlinks/copies the same bundle.
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice('Remote SSH POC: vault is not FileSystemAdapter-backed; cannot locate plugin source');
      return;
    }
    const sourcePluginDir = path.join(adapter.getBasePath(), '.obsidian', 'plugins', this.manifest.id);

    // Shadow vaults live under ~/.obsidian-remote/vaults/ on every
    // OS (per the architecture doc). os.homedir() resolves at
    // runtime — no hardcoded user.
    const baseDir = path.join(os.homedir(), '.obsidian-remote', 'vaults');

    const registry = new ObsidianRegistry(ObsidianRegistry.defaultConfigPath());
    const bootstrap = new ShadowVaultBootstrap(baseDir, sourcePluginDir, registry);
    const spawner = new WindowSpawner();
    const manager = new ShadowVaultManager(bootstrap, spawner);

    try {
      const result = await manager.openShadowFor(profile, this.settings.profiles);
      const where = result.layout.vaultDir;
      const how = result.pluginInstallMethod;
      const reg = result.registryCreated ? 'newly registered' : 'reused';
      new Notice(`Remote SSH POC: opened shadow vault for ${profile.name} (${how}, ${reg})`);
      logger.info(`debug-open-shadow-vault: vault=${where}, registry id=${result.registryId} (${reg}), plugin=${how}`);
    } catch (e) {
      const msg = (e as Error).message;
      logger.error(`debug-open-shadow-vault: ${msg}`);
      new Notice(`Remote SSH POC: shadow vault failed — ${msg}`);
    }
  }

  /**
   * Manual command-palette entry point for adapter patching. Used
   * during development to inspect pre-patch behaviour or to re-patch
   * after a manual restore — `connectProfile` runs the same flow
   * automatically when `settings.autoPatchAdapter` is true.
   */
  private async debugPatchAdapter(): Promise<void> {
    if (this.state !== SyncState.CONNECTED || !this.activeRemoteBasePath) {
      new Notice('Remote SSH: connect first');
      return;
    }
    if (this.patcher?.isPatched()) {
      new Notice('Remote SSH: adapter already patched');
      return;
    }
    const transportLabel = this.rpcConnection ? 'RPC' : 'SFTP';
    const ok = await this.patchAdapter();
    if (ok) {
      new Notice(`Remote SSH: adapter patched via ${transportLabel} (${PATCHED_METHODS.length} methods)`);
    } else {
      new Notice('Remote SSH: adapter patch failed (see console.log)');
    }
  }

  /**
   * Register an `fs.changed` notification handler and ask the daemon to
   * watch the entire vault. Failure here is non-fatal: the adapter
   * still works, the only loss is auto-refresh on remote-side edits.
   */
  private async subscribeToFsChanged(): Promise<void> {
    if (!this.rpcConnection) return;
    if (this.rpcWatchSubscriptionId) return;

    const rpc = this.rpcConnection.rpc;
    // Register the notification handler *before* sending fs.watch so we
    // can't miss the very first event the daemon emits.
    const handler = (params: FsChangedParams) => this.handleFsChanged(params);
    this.rpcWatchHandlerDisposer = rpc.onNotification('fs.changed', handler);

    try {
      const result = await rpc.call('fs.watch', { path: '', recursive: true });
      this.rpcWatchSubscriptionId = result.subscriptionId;
      logger.info(`fs.watch subscribed: ${this.rpcWatchSubscriptionId}`);
    } catch (e) {
      logger.error(`fs.watch failed: ${(e as Error).message}`);
      this.rpcWatchHandlerDisposer?.();
      this.rpcWatchHandlerDisposer = null;
    }
  }

  /**
   * Translate a daemon-pushed `fs.changed` notification into a cache
   * invalidation + a vault reconcile so the File Explorer, Quick
   * Switcher, etc. pick up creates / deletes / renames the same way
   * Obsidian's own filesystem watcher would.
   */
  private handleFsChanged(params: FsChangedParams): void {
    if (!this.dataAdapter) return;
    if (this.rpcWatchSubscriptionId && params.subscriptionId !== this.rpcWatchSubscriptionId) {
      return;
    }

    const action = interpretWatchEvent(params.path, this.activePathMapper);
    if (!action) return;

    this.dataAdapter.invalidateRemotePath(action.remotePath);

    let newVaultPath: string | undefined;
    if (params.event === 'renamed' && params.newPath) {
      const newAction = interpretWatchEvent(params.newPath, this.activePathMapper);
      if (newAction) {
        this.dataAdapter.invalidateRemotePath(newAction.remotePath);
        newVaultPath = newAction.vaultPath;
      }
    }

    // Reconcile is async (it stats through the patched SFTP adapter).
    // The notification handler is sync, so we kick the work off and
    // log any failure rather than letting it bubble up to RpcClient.
    void this.reconcileVaultPath(action.vaultPath, newVaultPath, params.event);
  }

  /**
   * Push a single path through `app.vault.adapter.reconcileFile` (or
   * `reconcileFolder`) so Obsidian's vault model reflects what the
   * daemon just told us happened on disk.
   *
   * `reconcileFile` and `reconcileFolder` are private FileSystemAdapter
   * methods. They are not in the public typings, but are de-facto
   * stable across recent Obsidian versions and are the same API
   * Obsidian's own filesystem watcher uses. We try-call them and fall
   * back to a `vault.trigger('modify', ...)` for known files when
   * they're missing — that fallback only handles in-place edits, but
   * it's still better than nothing on an Obsidian build that has
   * dropped the API.
   */
  private async reconcileVaultPath(
    oldVaultPath: string,
    newVaultPath: string | undefined,
    event: FsChangedParams['event'],
  ): Promise<void> {
    const adapter = this.app.vault.adapter as unknown as ReconcileCapableAdapter;
    const isRename = newVaultPath !== undefined && newVaultPath !== oldVaultPath;
    const targetPath = newVaultPath ?? oldVaultPath;

    // Decide file vs folder. After a delete the stat will fail, so
    // fall back to whatever Obsidian still has cached for the old path.
    let isFolder = false;
    try {
      const s = await this.app.vault.adapter.stat(targetPath);
      if (s) {
        isFolder = s.type === 'folder';
      } else {
        isFolder = this.lookupIsFolder(oldVaultPath);
      }
    } catch {
      isFolder = this.lookupIsFolder(oldVaultPath);
    }

    const reconcile = isFolder ? adapter.reconcileFolder : adapter.reconcileFile;
    if (typeof reconcile === 'function') {
      try {
        await reconcile.call(adapter, targetPath, isRename ? oldVaultPath : undefined);
        return;
      } catch (e) {
        logger.warn(`reconcile (${event}) failed for ${targetPath}: ${(e as Error).message}`);
        return;
      }
    }

    // Fallback path: Obsidian build doesn't expose reconcile*. We can
    // still service in-place edits on already-known files via trigger;
    // creates / deletes / renames will only show up after a reload.
    logger.warn(
      'adapter.reconcileFile/reconcileFolder unavailable on this Obsidian build; ' +
      `falling back to vault.trigger for ${event} ${targetPath}`,
    );
    const file = this.app.vault.getAbstractFileByPath(oldVaultPath);
    if (file && event === 'modified') {
      (this.app.vault as unknown as { trigger: (name: string, ...args: unknown[]) => void })
        .trigger('modify', file);
    }
  }

  /**
   * Best-effort "is the path a folder" check using whatever Obsidian
   * still has in its in-memory model. Used as a fallback when stat
   * fails (e.g. after a delete) so we still pick the right reconcile
   * variant.
   */
  private lookupIsFolder(vaultPath: string): boolean {
    const af = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!af) return false;
    return (af as { children?: unknown }).children !== undefined;
  }

  /**
   * Drop the daemon-side subscription and the local notification
   * handler. Safe to call when nothing was subscribed (the patch
   * never ran, the RPC tunnel was never established, etc.).
   */
  private unsubscribeFromFsChanged(): void {
    const id = this.rpcWatchSubscriptionId;
    this.rpcWatchSubscriptionId = null;
    this.activePathMapper = null;

    if (id && this.rpcConnection) {
      // Best-effort: if the daemon-side subscription is already gone
      // (process restart, connection drop) the call will reject and
      // we just log it.
      this.rpcConnection.rpc.call('fs.unwatch', { subscriptionId: id })
        .catch(e => logger.warn(`fs.unwatch failed: ${(e as Error).message}`));
    }
    if (this.rpcWatchHandlerDisposer) {
      this.rpcWatchHandlerDisposer();
      this.rpcWatchHandlerDisposer = null;
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
    // Drop the watch subscription before tearing the adapter down so
    // any in-flight fs.changed callbacks find a still-valid adapter
    // (or, if the handler races, a null `dataAdapter` which it tolerates).
    this.unsubscribeFromFsChanged();
    const wasPatched = this.patcher?.isPatched() ?? false;
    if (wasPatched) {
      try {
        this.patcher!.restore();
        logger.info('Adapter restored');
      } catch (e) {
        logger.error(`Adapter restore failed: ${(e as Error).message}`);
      }
    }
    this.patcher = null;
    this.dataAdapter = null;
    this.readCache = null;
    this.dirCache = null;
    // Bridge tears down asynchronously; we don't await here because
    // restoreAdapter must remain sync for the connection-close hook.
    void this.stopResourceBridge();
    // Walk the vault root through the now-restored FileSystemAdapter
    // so File Explorer goes back to showing local files (the model
    // would otherwise stay frozen on whatever the patched remote view
    // was reconciled to). Fire-and-forget — this method needs to stay
    // sync for the SftpClient.onClose handler.
    if (wasPatched) {
      void this.reconcileVaultRoot();
    }
  }

  /**
   * Bridge → adapter glue: fetch a binary asset through the patched
   * adapter so the bridge benefits from caching and PathMapper
   * translation. Returns `Uint8Array` as the bridge expects.
   */
  private async fetchBinaryForBridge(vaultPath: string): Promise<Uint8Array> {
    if (!this.dataAdapter) {
      throw new Error('adapter is not patched');
    }
    return this.dataAdapter.fetchBinaryForBridge(vaultPath);
  }

  /** Stop the resource bridge if running. Idempotent. */
  private async stopResourceBridge(): Promise<void> {
    const bridge = this.resourceBridge;
    if (!bridge) return;
    this.resourceBridge = null;
    try {
      await bridge.stop();
    } catch (e) {
      logger.warn(`ResourceBridge: stop failed: ${(e as Error).message}`);
    }
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

/**
 * Shape of `app.vault.adapter` we rely on for reconciliation. The
 * methods are not part of Obsidian's public DataAdapter typings — we
 * reach them via FileSystemAdapter's private surface and try-call
 * them, so the type is intentionally narrow and optional.
 */
interface ReconcileCapableAdapter {
  reconcileFile?: (realPath: string, oldRealPath?: string) => Promise<void>;
  reconcileFolder?: (realPath: string, oldRealPath?: string) => Promise<void>;
}
