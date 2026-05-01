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
import { ThreeWayMergeModal } from './ui/ThreeWayMergeModal';
import { KbdInteractiveModal } from './ui/KbdInteractiveModal';
import { HostKeyMismatchModal } from './ui/HostKeyMismatchModal';
import { AncestorTracker } from './conflict/AncestorTracker';
import { OfflineQueue } from './offline/OfflineQueue';
import { QueueReplayer } from './offline/QueueReplayer';
import { PendingEditsBar } from './ui/PendingEditsBar';
import { PendingEditsModal } from './ui/PendingEditsModal';
import { SftpRemoteFsClient } from './adapter/SftpRemoteFsClient';
import { RpcRemoteFsClient } from './adapter/RpcRemoteFsClient';
import { establishRpcConnection } from './transport/RpcConnection';
import { ServerDeployer, resolveRemotePath } from './transport/ServerDeployer';
import { tryReuseExistingDaemon } from './transport/DaemonProbe';
import { ReconnectManager } from './transport/ReconnectManager';
import type { ReconnectState } from './transport/ReconnectManager';
import { DEFAULT_BACKOFF } from './transport/Backoff';
import { PathMapper, defaultClientId, defaultUserName, sanitizeClientId } from './path/PathMapper';
import * as fs from 'fs';
import { StatusBar } from './ui/StatusBar';
import { ConnectModal } from './ui/ConnectModal';
import { SettingsTab } from './settings/SettingsTab';
import { logger } from './util/logger';
import { classifyToNotice } from './transport/errorTaxonomy';
import { VaultModelBuilder } from './vault/VaultModelBuilder';
import { FsChangeListener } from './vault/FsChangeListener';
import { BulkWalker } from './vault/BulkWalker';
import { ObsidianRegistry } from './shadow/ObsidianRegistry';
import { ShadowVaultBootstrap } from './shadow/ShadowVaultBootstrap';
import { ShadowVaultManager } from './shadow/ShadowVaultManager';
import { WindowSpawner } from './shadow/WindowSpawner';
import { ShadowStartupCoordinator } from './shadow/ShadowStartupCoordinator';
import * as os from 'os';
import { ObservabilityInstaller } from './util/ObservabilityInstaller';
import { normalizeRemotePath } from './util/pathUtils';
import * as path from 'path';
import { errorMessage } from "./util/errorMessage";

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
  // basePath surface — patched so plugins that join paths against
  // it (Templater's tp.file.path, Kanban clipboard paste, Importer,
  // Copilot — see docs/plugin-compatibility.md "basePath compat
  // survey") get the shadow-vault local root explicitly. The natural
  // FileSystemAdapter getter already returns this value, but routing
  // through the replacement makes the contract explicit and gives
  // tests a single hook to assert on. #170, follow-up to #133.
  'basePath', 'getBasePath',
] as const;

export default class RemoteSshPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;

  private secretStore  = new SecretStore();
  private authResolver = new AuthResolver(this.secretStore);
  private hostKeyStore = new HostKeyStore();
  private client!: SftpClient;
  private statusBar!: StatusBar;
  private state: SyncState = SyncState.IDLE;
  // Use a string-keyed record for the generic so `keyof T & string` resolves
  // to `string`; an `object` here would collapse to `never` and would reject
  // the PATCHED_METHODS tuple at the patcher call site.
  private patcher: AdapterPatcher<Record<string, unknown>> | null = null;
  private dataAdapter: SftpDataAdapter | null = null;
  private readCache: ReadCache | null = null;
  private dirCache: DirCache | null = null;
  /** Per-session ancestor snapshot store wired into the patched adapter (E2-α). */
  private ancestorTracker: AncestorTracker | null = null;
  /**
   * Persistent offline-write queue (E2-β). Created on first patch
   * and reused thereafter; pending entries from a previous session
   * are replayed on reconnect by the (upcoming) QueueReplayer.
   */
  private offlineQueue: OfflineQueue | null = null;
  /**
   * Status-bar indicator for queued offline edits (E2-β.4). Hidden
   * when the queue is empty; click opens `PendingEditsModal`.
   */
  private pendingEditsBar: PendingEditsBar | null = null;
  private activeRemoteBasePath: string | null = null;
  /** Authenticated daemon session, populated when the active profile uses transport='rpc'. */
  private rpcConnection: Awaited<ReturnType<typeof establishRpcConnection>> | null = null;
  /** ServerDeployer that owns the daemon process; invoked on disconnect to tear it down. */
  private daemonDeployer: ServerDeployer | null = null;
  /** Owns the daemon fs.watch subscription + notification dispatch. */
  private fsChangeListener!: FsChangeListener;
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
  private observability: ObservabilityInstaller | null = null;

  async onload() {
    await this.loadSettings();

    logger.setDebug(this.settings.enableDebugLog);
    logger.setMaxLines(this.settings.maxLogLines);
    const adapter = this.app.vault.adapter;
    const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
    this.observability = new ObservabilityInstaller(this.manifest, basePath, this.app.vault.configDir);
    this.observability.install();

    this.fsChangeListener = new FsChangeListener(this.app);

    this.client = new SftpClient(
      this.authResolver,
      this.hostKeyStore,
      // keyboard-interactive (TOTP / RSA SecurID / Duo Push / PAM PIN)
      // — wired here so the SftpClient stays UI-agnostic and the
      // integration test fixtures (which construct it with two
      // args) keep working unchanged. The handler returns `null` on
      // user-cancel; SftpClient forwards `[]` to ssh2's `finish`,
      // which fails the auth round and surfaces as a normal connect
      // error in the connect promise rejection.
      (prompts) => new KbdInteractiveModal(this.app, prompts).prompt(),
      // host-key mismatch recovery (#132). On fingerprint change,
      // surface both fingerprints to the user; 'trust' re-pins the
      // new key and proceeds, 'abort' fails the connect with a
      // host-key category error. Without this handler the existing
      // sync verify() path stays as-is for tests / non-UI callers.
      (info) => new HostKeyMismatchModal(this.app, info).prompt(),
    );
    this.client.onClose(({ unexpected }) => {
      // Intentional disconnects are driven by `disconnect()` which
      // already handles cleanup. Unexpected ones (network drop, peer
      // killed sshd, ...) hand off to the reconnect loop, which keeps
      // the patched adapter alive via swapClient instead of forcing a
      // restore + re-patch round-trip.
      if (unexpected) {
        new Notice('Remote SSH: connection lost — reconnecting…');
        void this.startReconnect();
      }
    });
    this.activeRemoteBasePath = null;

    this.addSettingTab(new SettingsTab(this.app, this));

    this.statusBar = new StatusBar(this, () => this.onStatusBarClick());
    this.statusBar.update(this.state);

    // Pending-edits indicator: shown only when the offline queue has
    // entries. Click opens the read-only listing + "discard all"
    // button. The bar starts hidden; `replayOfflineQueue` and the
    // queue-aware adapter writes call into our refresh helper.
    this.pendingEditsBar = new PendingEditsBar(this, () => void this.showPendingEditsModal());

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
        if (active) this.cancelReconnect();
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
      name: 'Debug: test daemon tunnel',
      callback: () => this.debugTestRpcTunnel(),
    });

    this.addCommand({
      id: 'reconnect',
      name: 'Reconnect to remote (shadow vault auto-connect)',
      checkCallback: (checking: boolean) => {
        // Only meaningful inside a shadow window (= a vault whose
        // data.json has the autoConnectProfileId marker). Outside
        // that, Reconnect doesn't have a target and the regular
        // Connect command applies.
        if (!this.settings.autoConnectProfileId) return false;
        if (!checking) void this.runAutoConnect('reconnect');
        return true;
      },
    });

    // Phase 4 + 6C-prep: if this vault was opened with an
    // autoConnectProfileId marker (= a shadow vault from
    // `ShadowVaultBootstrap`):
    //   1. install any plugins listed in community-plugins.json that
    //      aren't yet on disk (marketplace download via
    //      `app.plugins.installPlugin`),
    //   2. then connect to the remote and populate the file model.
    // Done inside `onLayoutReady` so we wait for Obsidian's own
    // vault initialization to finish before touching plugins or the
    // adapter.
    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.autoConnectProfileId) return;
      void this.runShadowStartup();
    });
  }

  /**
   * Shadow window startup orchestration: prompt the user about any
   * pending plugin suggestions captured at bootstrap, fill in any
   * binaries missing from the shadow's community-plugins.json (safety
   * net for re-bootstraps), then auto-connect. Split from
   * `runAutoConnect` so the Reconnect command can re-run just the
   * connect half without re-fetching anything.
   */
  private async runShadowStartup(): Promise<void> {
    const coordinator = new ShadowStartupCoordinator(
      this.app, this.settings, () => this.saveSettings(),
    );
    await coordinator.prepareForAutoConnect();
    await this.runAutoConnect('layout-ready');
  }

  onunload() {
    // Restore adapter first so any in-flight Obsidian read calls see the
    // original FileSystemAdapter again before we tear down the SSH session.
    this.restoreAdapter();
    void this.disconnect().catch(() => { /* ignore */ });
    this.statusBar?.remove();
    this.pendingEditsBar?.remove();
    this.observability?.uninstall();
  }

  async loadSettings() {
    // `loadData()` returns `any`; cast through a known shape so downstream
    // accessors are typed. The fields we actually consume here are the
    // host-key map and the encrypted-secrets blob; everything else flows
    // into `Object.assign(...DEFAULT_SETTINGS, saved)` and is shape-checked
    // by `PluginSettings`.
    const saved = (await this.loadData()) as Partial<PluginSettings> & {
      hostKeyStore?: Record<string, string>;
      secrets?: Parameters<SecretStore['load']>[0];
    } | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
    // Migration (Phase 5): the old `autoPatchAdapter` field is gone
    // — Object.assign above doesn't pick it up because it's not in
    // DEFAULT_SETTINGS, but a stray copy could survive in saved data
    // and reappear via `saveData(...this.settings...)`. Force-strip
    // it via the cast so saveSettings doesn't write it back.
    delete (this.settings as unknown as Record<string, unknown>).autoPatchAdapter;
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
      new Notice('Remote SSH: already connected. Disconnect first.');
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
      const { notice, classified } = classifyToNotice(e);
      logger.error(`Connect failed: ${classified.title}`, {
        category: classified.category,
        code: classified.code,
        original: classified.original.message,
        profileId: profile.id,
      });
      new Notice(notice);
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
        const { notice, classified } = classifyToNotice(e);
        logger.error(`RPC startup failed: ${classified.title}`, {
          category: classified.category,
          code: classified.code,
          original: classified.original.message,
          profileId: profile.id,
        });
        new Notice(notice);
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
    // Patch the adapter unconditionally — the legacy
    // `autoPatchAdapter` opt-out was a debug knob from before the
    // shadow-vault flow took over. The shadow window's plugin needs
    // the patch every time; outside a shadow window `connectProfile`
    // isn't called from any user-facing path anymore.
    const patched = await this.patchAdapter();
    if (!patched) {
      new Notice('Remote SSH: adapter patch failed — disconnecting');
      await this.disconnect().catch(() => { /* already errored */ });
      return;
    }

    const userLabel = this.formatUserLabel();
    new Notice(
      `Remote SSH: Connected to ${profile.name} as ${userLabel} via ${transport.toUpperCase()}${rpcSummary}`,
    );

    // Drain any writes left over from a previous Electron session
    // that disconnected before its replay finished. Fire-and-forget
    // for the same reason as the post-reconnect drain.
    void this.replayOfflineQueue('after-connect');
  }

  /**
   * Phase 4 entry point: connect to the profile pointed at by
   * `settings.autoConnectProfileId`, then populate the empty shadow
   * vault from the remote tree via `VaultModelBuilder`. Called once
   * on `onLayoutReady` and again from the `Reconnect` command.
   *
   * `tag` shows up in the log line so we can tell whether a given
   * run came from the layout-ready hook or a manual reconnect.
   */
  private async runAutoConnect(tag: 'layout-ready' | 'reconnect'): Promise<void> {
    const profileId = this.settings.autoConnectProfileId;
    if (!profileId) return;
    const profile = this.settings.profiles.find(p => p.id === profileId);
    if (!profile) {
      logger.warn(
        `runAutoConnect(${tag}): autoConnectProfileId=${profileId} but no matching ` +
        'profile in data.json; skipping',
      );
      new Notice(
        `Remote SSH: shadow-vault profile id ${profileId} not found in data.json — ` +
        'cannot auto-connect',
      );
      return;
    }

    if (this.client.isAlive()) {
      logger.info(`runAutoConnect(${tag}): client already alive — disconnecting first`);
      try { await this.disconnect(); } catch { /* swallow; we're about to reconnect */ }
    }

    logger.info(`runAutoConnect(${tag}): connecting to profile ${profile.name}`);
    await this.connectProfile(profile);

    if (this.state !== SyncState.CONNECTED) {
      // connectProfile already surfaced a Notice on failure — don't
      // double up; just skip the populate.
      logger.warn(`runAutoConnect(${tag}): connect did not reach CONNECTED state; skipping populate`);
      return;
    }

    // Adapter is patched; build the file model so File Explorer
    // renders the remote tree.
    let summary: string;
    try {
      summary = await this.populateVaultFromRemote(`shadow-${tag}`);
    } catch (e) {
      const msg = errorMessage(e);
      logger.error(`runAutoConnect(${tag}): populate failed: ${msg}`);
      new Notice(`Remote SSH: connected but failed to populate vault — ${msg}`);
      return;
    }
    new Notice(`Remote SSH: ${profile.name} ready — ${summary}`);
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

    // #131: probe for an existing healthy daemon before redeploying.
    // OpenSSH's direct-streamlocal forwarding (used by openUnixStream)
    // has no concept of CWD, so resolve to absolute against the
    // remote's $HOME first. Probe failure (socket missing / token
    // unreadable / handshake error / protocol mismatch) returns null
    // and falls through to the normal deploy flow.
    const home = await this.client.getRemoteHome();
    const absSocketPath = resolveRemotePath(remoteSocketPath, home);
    const absTokenPath  = resolveRemotePath(remoteTokenPath,  home);
    const reused = await tryReuseExistingDaemon(this.client, absSocketPath, absTokenPath);
    if (reused) {
      this.rpcConnection = reused;
      // Intentionally leave `this.daemonDeployer` null — we did not
      // start this daemon, so disconnect must NOT kill it. Another
      // session may be using it. (See DaemonProbe.ts header for the
      // first-mover-still-kills caveat.)
      logger.info(
        `startRpcSession: reusing existing daemon for ${effectivePath} ` +
        `(skipped kill+redeploy)`,
      );
      return;
    }

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
  private cancelReconnect(): void {
    // Synchronous cleanup. Was previously `async` because callers used
    // to await; the body never had an await, so dropping `async` keeps
    // the same behaviour and silences `@typescript-eslint/require-await`
    // (no `await Promise.resolve()` filler needed).
    if (!this.reconnectManager?.isActive()) return;
    this.reconnectManager.cancel();
    this.reconnectManager = null;
    // Drop the patched adapter so Obsidian stops fielding "reconnecting"
    // errors and falls back to the original FileSystemAdapter; the
    // user is on their own to reconnect.
    this.restoreAdapter();
    this.setState(SyncState.ERROR);
    new Notice('Remote SSH: reconnect cancelled');
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
    this.fsChangeListener.prepareForReconnect();
    if (this.rpcConnection && this.dataAdapter) {
      await this.fsChangeListener.resumeAfterReconnect({
        rpcConnection: this.rpcConnection,
        dataAdapter: this.dataAdapter,
      });
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
      new Notice('Remote SSH: reconnected');
      this.reconnectManager = null;
      // Drain any writes that landed during the disconnect. Fire-and-
      // forget: the user's already-back state is independent of the
      // replay outcome, and individual op failures stay in the queue
      // for the next reconnect.
      void this.replayOfflineQueue('after-reconnect');
    } else if (s.kind === 'failed') {
      // Give up: tear the patched adapter down so Obsidian falls
      // back to local file:// reads instead of blocking forever on a
      // dead transport. restoreAdapter clears dataAdapter so the
      // setReconnecting flag goes with it.
      this.restoreAdapter();
      this.setState(SyncState.ERROR);
      // s.reason is a string from ReconnectManager; wrap into Error
      // so classifyError can run pattern matching on the message
      // (e.g. host-key / timeout substrings still get caught).
      const { notice, classified } = classifyToNotice(new Error(s.reason));
      logger.error(`Reconnect failed: ${classified.title}`, {
        category: classified.category,
        code: classified.code,
        original: s.reason,
      });
      new Notice(notice);
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
      catch (e) { logger.warn(`rpcConnection.close: ${errorMessage(e)}`); }
      this.rpcConnection = null;
    }
    if (this.daemonDeployer && this.client?.isAlive()) {
      try { await this.daemonDeployer.stop(); }
      catch (e) { logger.warn(`daemon stop: ${errorMessage(e)}`); }
    }
    this.daemonDeployer = null;

    if (this.client?.isAlive()) {
      try {
        await this.client.disconnect();
      } catch (e) {
        logger.warn(`disconnect: ${errorMessage(e)}`);
      }
    }
    this.setState(SyncState.IDLE);
    if (this.settings.activeProfileId !== null) {
      this.settings.activeProfileId = null;
      await this.saveSettings();
    }
    if (wasActive) new Notice('Remote SSH: disconnected');
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
    const targetAdapter = this.app.vault.adapter as unknown as Record<string, unknown>;
    // Capture the shadow vault's local root *before* patching. The
    // running window is the shadow window, so its FileSystemAdapter
    // already points at `~/.obsidian-remote/vaults/<P-id>/`; we feed
    // that value back into SftpDataAdapter so the patched basePath /
    // getBasePath surface returns it explicitly. Falls back to '' if
    // the host adapter isn't a FileSystemAdapter (mobile / unusual
    // builds) — plugins that read basePath in those environments
    // already had no useful answer. #170.
    const shadowBasePath = this.app.vault.adapter instanceof FileSystemAdapter
      ? this.app.vault.adapter.getBasePath()
      : '';
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
    // Pass `app.vault.configDir` so PathMapper builds its private-subtree
    // routing against the user's actual config directory (defaults to
    // `.obsidian` but is configurable in Obsidian's appearance settings).
    const mapper = new PathMapper(clientId, this.app.vault.configDir);
    logger.info(`PathMapper: clientId="${clientId}"`);

    // Spin up the localhost binary bridge so getResourcePath has
    // somewhere to send Obsidian. The bridge is best-effort: if it
    // fails to bind we still patch and just lose image rendering.
    //
    // When the active session is RPC AND the daemon advertises
    // `fs.thumbnail`, also wire the thumbnail fetcher — image-extension
    // requests get served from the daemon's resize path (small, cached)
    // instead of pulling the full original on every <img>.
    const bridge = new ResourceBridge();
    const fetchThumbnail = this.makeThumbnailFetcherIfSupported();
    const fetchBinaryRange = this.makeBinaryRangeFetcherIfSupported();
    try {
      await bridge.start(
        p => this.fetchBinaryForBridge(p),
        fetchThumbnail ?? undefined,
        fetchBinaryRange ?? undefined,
      );
      this.resourceBridge = bridge;
      if (fetchThumbnail) {
        logger.info('ResourceBridge: thumbnail fast path enabled (daemon supports fs.thumbnail)');
      }
      if (fetchBinaryRange) {
        logger.info('ResourceBridge: range fast path enabled (daemon supports fs.readBinaryRange)');
      }
    } catch (e) {
      logger.warn(`ResourceBridge: start failed: ${errorMessage(e)}`);
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
    // Per-session ancestor snapshot store. Powers the 3-way merge UI;
    // cleared on disconnect with the rest of the patched-adapter state.
    this.ancestorTracker = new AncestorTracker();
    // Persistent offline-write queue. Survives Electron restarts and
    // adapter restores so an in-flight disconnect doesn't drop user
    // edits. Lazily-opened the first time the adapter is patched;
    // reused on subsequent patches so the queue isn't re-replayed.
    if (!this.offlineQueue) {
      try {
        this.offlineQueue = await this.openOfflineQueue();
        const stats = this.offlineQueue.stats();
        if (stats.entries > 0) {
          logger.info(
            `OfflineQueue: opened with ${stats.entries} pending entries (${stats.bytes} bytes) ` +
            'from a previous session — the QueueReplayer will drain them on connect',
          );
        }
        // Wire the status-bar indicator to this queue. Polls every
        // 2 s; cheap (Map.size) and the user expects an at-a-glance
        // count rather than per-event live updates.
        const queue = this.offlineQueue;
        this.pendingEditsBar?.startPolling(() => queue.pending().length);
      } catch (e) {
        logger.warn(`OfflineQueue: open failed (${errorMessage(e)}); offline writes will throw`);
        this.offlineQueue = null;
      }
    }
    this.dataAdapter = new SftpDataAdapter(
      fsClient,
      adapterRemoteBase,
      this.readCache,
      this.dirCache,
      this.app.vault.getName(),
      mapper,
      this.resourceBridge,
      // Binary fallback: a precondition-failed binary write (or a text
      // write without an ancestor) surfaces the 2-choice modal —
      // overwrite the remote or cancel.
      (vaultPath) => new WriteConflictModal(this.app, vaultPath).prompt(),
      this.ancestorTracker,
      // Text 3-way: when an ancestor exists for the conflicting text
      // path, route here so the modal can show all three panes
      // (ancestor / mine / theirs) and let the user pick or hand-merge.
      (vaultPath, panes) => new ThreeWayMergeModal(this.app, { path: vaultPath, ...panes }).prompt(),
      this.offlineQueue,
      shadowBasePath,
    );
    this.patcher = new AdapterPatcher(targetAdapter, this.dataAdapter);
    try {
      this.patcher.patch(PATCHED_METHODS);
      logger.info(`Adapter patched via ${transportLabel}: [${PATCHED_METHODS.join(', ')}]`);
    } catch (e) {
      logger.error(`Adapter patch failed: ${errorMessage(e)}`);
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
      void this.fsChangeListener.subscribe({
        rpcConnection: this.rpcConnection,
        dataAdapter: this.dataAdapter,
        pathMapper: mapper,
      });
    }

    // The legacy `reconcileVaultRoot()` walk used to fire here to
    // re-build File Explorer from the just-patched adapter. The
    // shadow-vault flow makes that walk obsolete: callers
    // (`runAutoConnect`) follow up with `populateVaultFromRemote`
    // which uses VaultModelBuilder, the only mechanism that
    // actually works on this Obsidian build's reconcileFile.
    return true;
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
  /**
   * Walk the patched adapter and run `VaultModelBuilder` so File
   * Explorer renders the remote tree. Public so both the debug
   * command and the Phase 4 auto-connect flow share one path.
   *
   * Stat is intentionally skipped per file — every entry lands with
   * zero ctime/mtime/size. Subsequent file accesses fault in real
   * stat values via the patched adapter as needed; a Phase 6
   * follow-up can switch to a daemon-side batch-stat if it shows
   * up in profiles.
   *
   * Returns a short summary string suitable for a Notice; logs the
   * full counts + first 5 errors via `logger.info`/`logger.warn`.
   */
  async populateVaultFromRemote(label: string = 'remote'): Promise<string> {
    const start = Date.now();

    // Phase E1-α.2: prefer the daemon's `fs.walk` (one RPC, real
    // mtime+size per entry) when the active session is RPC AND the
    // daemon advertises the capability. Otherwise BulkWalker
    // transparently runs the legacy BFS via the patched adapter.
    const walker = new BulkWalker({
      adapter: this.app.vault.adapter,
      rpcConnection: this.rpcConnection ?? undefined,
    });
    const walk = await walker.walk('');
    logger.info(
      `populateVaultFromRemote(${label}): ${walk.source}, ${walk.entries.length} entries ` +
      `in ${walk.walkMs}ms` +
      (walk.fastPathError ? ` (fast-path fallback: ${walk.fastPathError})` : ''),
    );

    const builder = new VaultModelBuilder(this.app.vault, { TFile, TFolder });
    const result = await builder.build(walk.entries);
    const totalMs = Date.now() - start;

    const summary =
      `${result.filesAdded}f + ${result.foldersAdded}d built, ` +
      `${result.skipped} skipped, ${result.errors.length} errors (${totalMs}ms)`;
    if (result.errors.length > 0) {
      logger.warn(
        `populateVaultFromRemote(${label}): first 5 errors: ` +
        JSON.stringify(result.errors.slice(0, 5), null, 2),
      );
    }
    return summary;
  }

  /**
   * Settings UI Connect button handler (Phase 3) and the underlying
   * implementation of the shadow-vault flow.
   *
   * Bootstraps the shadow vault for `profile` (creates the dir,
   * installs the plugin per-file, writes data.json with the
   * auto-connect marker, registers the path in obsidian.json) and
   * opens it in a new Obsidian window via the
   * `obsidian://open?path=…` URL scheme.
   *
   * Does NOT require an SSH connection — the shadow vault setup is
   * a local-disk operation; the connect happens later, inside the
   * shadow window (Phase 4).
   */
  async openShadowVaultFor(profile: SshProfile): Promise<void> {
    // Source dir: where this running plugin lives, so the shadow
    // vault's plugin install symlinks the same bundle.
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice('Remote SSH: vault is not file-system-backed; cannot locate plugin source');
      return;
    }
    const sourcePluginDir = path.join(adapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id);

    // Shadow vaults live under ~/.obsidian-remote/vaults/ on every
    // OS. os.homedir() resolves at runtime — no hardcoded user.
    const baseDir = path.join(os.homedir(), '.obsidian-remote', 'vaults');

    const registry = new ObsidianRegistry(ObsidianRegistry.defaultConfigPath());
    const bootstrap = new ShadowVaultBootstrap(baseDir, sourcePluginDir, registry);
    const spawner = new WindowSpawner();
    const manager = new ShadowVaultManager(bootstrap, spawner);

    try {
      const result = await manager.openShadowFor(profile, this.settings.profiles);
      const how = result.pluginInstallMethod;
      const reg = result.registryCreated ? 'newly registered' : 'reused';
      new Notice(`Remote SSH: opened ${profile.name} in new window (${how}, ${reg})`);
      logger.info(
        `openShadowVaultFor: profile=${profile.name}, vault=${result.layout.vaultDir}, ` +
        `registry id=${result.registryId} (${reg}), plugin=${how}`,
      );
    } catch (e) {
      const msg = errorMessage(e);
      logger.error(`openShadowVaultFor: ${msg}`);
      new Notice(`Remote SSH: shadow vault failed — ${msg}`);
    }
  }

  /**
   * Manual command-palette entry point for adapter patching. Used
   * during development to inspect pre-patch behaviour or to re-patch
   * after a manual restore.
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
    this.fsChangeListener.unsubscribe(this.rpcConnection);
    const wasPatched = this.patcher?.isPatched() ?? false;
    if (wasPatched) {
      try {
        this.patcher!.restore();
        logger.info('Adapter restored');
      } catch (e) {
        logger.error(`Adapter restore failed: ${errorMessage(e)}`);
      }
    }
    this.patcher = null;
    this.dataAdapter = null;
    this.readCache = null;
    this.dirCache = null;
    this.ancestorTracker?.clear();
    this.ancestorTracker = null;
    // Bridge tears down asynchronously; we don't await here because
    // restoreAdapter must remain sync for the connection-close hook.
    void this.stopResourceBridge();
    // Walk the vault root through the now-restored FileSystemAdapter
    // so File Explorer goes back to showing local files (the model
    // would otherwise stay frozen on whatever the patched remote view
    // The legacy reconcileVaultRoot walk used to fire here to put
    // File Explorer back to the local view after un-patching, but
    // shadow vaults are torn down by closing their window — there's
    // no in-place "switch back" UX to support anymore.
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

  /**
   * Show the pending-edits listing modal. Discarding clears the
   * queue (destructive — there's no undo). The listing is a snapshot
   * taken at modal-open time; if the queue mutates while the modal
   * is open the user just sees the next snapshot on their next
   * click.
   */
  private async showPendingEditsModal(): Promise<void> {
    if (!this.offlineQueue) return;
    const entries = this.offlineQueue.pending();
    if (entries.length === 0) return;
    const decision = await new PendingEditsModal(this.app, entries).prompt();
    if (decision.decision === 'discard-all') {
      const dropped = entries.length;
      try {
        await this.offlineQueue.clear();
        new Notice(`Remote SSH: discarded ${dropped} pending edit${dropped === 1 ? '' : 's'}`);
      } catch (e) {
        logger.warn(`PendingEditsModal: queue.clear() failed: ${errorMessage(e)}`);
        new Notice('Remote SSH: failed to clear the offline queue (see console.log)');
      }
    }
  }

  /**
   * Drive the offline write queue against the live adapter. Called
   * on every connect (initial and post-reconnect). Idempotent: if
   * the queue is empty the run is a no-op; if entries error mid-
   * drain the rest stay queued for the next reconnect.
   */
  private async replayOfflineQueue(label: 'after-connect' | 'after-reconnect'): Promise<void> {
    if (!this.offlineQueue || !this.dataAdapter) return;
    const pendingBefore = this.offlineQueue.pending().length;
    if (pendingBefore === 0) return;
    logger.info(`replayOfflineQueue(${label}): ${pendingBefore} pending entries`);
    try {
      const replayer = new QueueReplayer(this.offlineQueue, this.dataAdapter);
      const report = await replayer.run();
      const stillPending = this.offlineQueue.pending().length;
      const summary =
        `replayOfflineQueue(${label}) done: drained=${report.drained}, ` +
        `conflicts=${report.conflicts}, errors=${report.errors.length}, ` +
        `remaining=${stillPending}`;
      logger.info(summary);
      if (report.drained > 0) {
        new Notice(
          `Remote SSH: replayed ${report.drained} offline edit` +
          `${report.drained === 1 ? '' : 's'}` +
          (stillPending > 0 ? ` (${stillPending} pending)` : ''),
        );
      }
      if (report.errors.length > 0) {
        new Notice(
          `Remote SSH: ${report.errors.length} offline edit` +
          `${report.errors.length === 1 ? '' : 's'} failed to replay; will retry on next connect`,
        );
      }
    } catch (e) {
      logger.warn(`replayOfflineQueue(${label}) crashed: ${errorMessage(e)}`);
    }
  }

  /**
   * Open the persistent offline-write queue under
   * `<vault>/.obsidian/plugins/<id>/queue/`. The dir lives next to
   * the plugin's other on-disk state (data.json, console.log, the
   * thumbnails cache the daemon writes elsewhere) so a vault move
   * carries the pending writes with it.
   */
  private async openOfflineQueue(): Promise<OfflineQueue> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('vault is not FileSystemAdapter-backed');
    }
    const dir = path.join(adapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id, 'queue');
    return await OfflineQueue.open(dir);
  }

  /**
   * Build the bridge's thumbnail fetcher when the active session can
   * support it. Returns `null` for SFTP transports or for daemons
   * that don't advertise `fs.thumbnail` — the bridge then transparently
   * falls back to the full-binary path on `<img>` requests.
   */
  private makeThumbnailFetcherIfSupported(): null | ((vaultPath: string, maxDim: number) => Promise<{ bytes: Uint8Array; format: 'jpeg' | 'png' }>) {
    const conn = this.rpcConnection;
    if (!conn) return null;
    if (!conn.info.capabilities.includes('fs.thumbnail')) return null;
    return async (vaultPath, maxDim) => {
      const result = await conn.rpc.call('fs.thumbnail', { path: vaultPath, maxDim });
      const buf = Buffer.from(result.contentBase64, 'base64');
      return {
        bytes:  new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        format: result.format,
      };
    };
  }

  /**
   * Build the bridge's range fetcher when the active session can
   * support it (#134). Returns `null` for SFTP transports or for
   * daemons that don't advertise `fs.readBinaryRange` — the bridge
   * then transparently falls back to the full-binary path on every
   * `Range:` request, which still works but allocates the whole file
   * into memory just to slice.
   */
  private makeBinaryRangeFetcherIfSupported(): null | ((vaultPath: string, offset: number, length: number, expectedMtime?: number) => Promise<{ bytes: Uint8Array; mtime: number; totalSize: number }>) {
    const conn = this.rpcConnection;
    if (!conn) return null;
    if (!conn.info.capabilities.includes('fs.readBinaryRange')) return null;
    return async (vaultPath, offset, length, expectedMtime) => {
      // Daemon's ReadBinaryRangeParams treats `expectedMtime` as
      // optional — only include it when the bridge actually has a
      // cached generation to pin against. The daemon rejects with
      // PreconditionFailed (-32020) when the remote mtime no longer
      // matches; ResourceBridge catches that and re-issues with
      // `expectedMtime: undefined`. #171.
      const result = await conn.rpc.call('fs.readBinaryRange', {
        path: vaultPath,
        offset,
        length,
        ...(expectedMtime !== undefined ? { expectedMtime } : {}),
      });
      const buf = Buffer.from(result.contentBase64, 'base64');
      return {
        bytes:     new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        mtime:     result.mtime,
        totalSize: result.size,
      };
    };
  }

  /** Stop the resource bridge if running. Idempotent. */
  private async stopResourceBridge(): Promise<void> {
    const bridge = this.resourceBridge;
    if (!bridge) return;
    this.resourceBridge = null;
    try {
      await bridge.stop();
    } catch (e) {
      logger.warn(`ResourceBridge: stop failed: ${errorMessage(e)}`);
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
      logger.error(`debugListRoot failed: ${errorMessage(e)}`);
      new Notice(`debugListRoot failed: ${errorMessage(e)}`);
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
      new Notice('Remote SSH: connect first (the tunnel rides on SFTP)');
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
      const msg = errorMessage(e);
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
      this.app.vault.configDir, 'plugins', this.manifest.id,
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

  /**
   * Command-palette / status-bar entry point that mirrors the
   * Settings UI's Connect button: pick a profile, then open it as a
   * shadow vault in a new Obsidian window. The original window is
   * never patched in-place anymore.
   */
  private promptConnect() {
    const { profiles } = this.settings;
    if (profiles.length === 0) {
      new Notice('Remote SSH: no profiles configured. Open settings to add one.');
      return;
    }
    new ConnectModal(
      this.app,
      profiles,
      this.authResolver,
      profile => this.openShadowVaultFor(profile),
    ).open();
  }

  private onStatusBarClick() {
    if (this.state === SyncState.IDLE || this.state === SyncState.ERROR) {
      this.promptConnect();
    } else if (this.state === SyncState.CONNECTED) {
      void this.disconnect();
    }
  }
}

