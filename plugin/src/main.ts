import { Plugin, Notice, FileSystemAdapter, TFile, TFolder } from 'obsidian';
import type { PluginSettings, SshProfile } from './types';
import { SyncState } from './types';
import { DEFAULT_SETTINGS, DEFAULT_WALK_IGNORE_DIRS } from './constants';
import { SftpClient } from './ssh/SftpClient';
import { AuthResolver } from './ssh/AuthResolver';
import { HostKeyStore } from './ssh/HostKeyStore';
import { SecretStore } from './ssh/SecretStore';
import { KbdInteractiveModal } from './ui/KbdInteractiveModal';
import { HostKeyMismatchModal } from './ui/HostKeyMismatchModal';
import { PendingEditsBar } from './ui/PendingEditsBar';
import { RpcRemoteFsClient } from './adapter/RpcRemoteFsClient';
import { AdapterManager } from './adapter/AdapterManager';
import { establishRpcConnection } from './transport/RpcConnection';
import { ServerDeployer } from './transport/ServerDeployer';
import type { ReconnectState } from './transport/ReconnectManager';
import * as fs from 'fs';
import { StatusBar } from './ui/StatusBar';
import { ConnectModal } from './ui/ConnectModal';
import { RemoteTerminalView, VIEW_TYPE_REMOTE_TERMINAL } from './ui/RemoteTerminalView';
import { SettingsTab } from './settings/SettingsTab';
import { logger } from './util/logger';
import { classifyToNotice } from './transport/errorTaxonomy';
import { VaultModelBuilder } from './vault/VaultModelBuilder';
import { FsChangeListener } from './vault/FsChangeListener';
import { BulkWalker } from './vault/BulkWalker';
import { RenameLeafFollower } from './vault/RenameLeafFollower';
import { ObsidianRegistry } from './shadow/ObsidianRegistry';
import { ShadowVaultBootstrap } from './shadow/ShadowVaultBootstrap';
import { SharedConfigWatcher } from './shadow/SharedConfigWatcher';
import { ShadowVaultManager } from './shadow/ShadowVaultManager';
import { WindowSpawner } from './shadow/WindowSpawner';
import { ShadowStartupCoordinator } from './shadow/ShadowStartupCoordinator';
import * as os from 'os';
import { ObservabilityInstaller } from './util/ObservabilityInstaller';
import { normalizeRemotePath } from './util/pathUtils';
import * as path from 'path';
import { errorMessage } from "./util/errorMessage";
import { ConnectionManager } from "./ConnectionManager";
import { TransferTracker } from "./util/TransferTracker";
import { LargeTransferBar } from "./ui/LargeTransferBar";
import { OnboardingModal } from "./ui/OnboardingModal";
import { telemetry, telemetryLogPath } from "./util/Telemetry";

export default class RemoteSshPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;

  private secretStore  = new SecretStore();
  private authResolver = new AuthResolver(this.secretStore);
  private hostKeyStore = new HostKeyStore();
  private conn!: ConnectionManager;
  private adapterMgr!: AdapterManager;
  private statusBar!: StatusBar;
  private state: SyncState = SyncState.IDLE;
  /**
   * Re-entrancy guard for `openShadowVaultFor`. A spawned shadow
   * window can take several seconds to surface, during which Obsidian
   * keeps the source window focused; without this, every impatient
   * Connect re-click re-bootstraps + re-fires `obsidian://open`,
   * producing the WindowSpawner churn observed in the field.
   *
   * Asymmetric by design: held ~15s only after a *successful* spawn
   * (debounce the double/triple-click while the new window surfaces);
   * cleared *synchronously* on a failed spawn so a genuine retry is
   * instant and the user is never stranded behind a stale
   * "still opening" toast.
   */
  private shadowSpawnInFlight = false;
  /**
   * Status-bar indicator for queued offline edits (E2-β.4). Hidden
   * when the queue is empty; click opens `PendingEditsModal`.
   */
  private pendingEditsBar!: PendingEditsBar;
  /**
   * Tracks in-flight large (>1 MB) file transfers so the StatusBar
   * can show the user something is happening (#127). Pure in-memory.
   */
  private transferTracker: TransferTracker = new TransferTracker();
  /** Status-bar indicator wired to the transferTracker. */
  private largeTransferBar: LargeTransferBar | null = null;
  /** Owns the daemon fs.watch subscription + notification dispatch. */
  private fsChangeListener!: FsChangeListener;
  /**
   * #342 push half: watches the shadow vault's local config dir and
   * pushes shared-config edits to the remote. Lives only for the
   * duration of a connected session (started after the connect pull,
   * stopped on disconnect/unload).
   */
  private sharedConfigWatcher: SharedConfigWatcher | null = null;
  private observability: ObservabilityInstaller | null = null;
  /**
   * #149 — re-entrant guard for `openRemoteTerminal()`. The
   * `addCommand` checkCallback doesn't debounce, so rapid command-
   * palette activations would otherwise both pass the
   * `getLeavesOfType(...).length === 0` check (because the first
   * call's `await leaf.setViewState` is still pending) and create
   * two terminal leaves with two RemoteShell channels.
   */
  private openingTerminal = false;

  async onload() {
    await this.loadSettings();

    logger.setDebug(this.settings.enableDebugLog);
    logger.setMaxLines(this.settings.maxLogLines);
    const adapter = this.app.vault.adapter;
    const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
    this.observability = new ObservabilityInstaller(this.manifest, basePath, this.app.vault.configDir);
    this.observability.install();

    // F22 — opt-in anonymous telemetry. Counters live next to other
    // plugin state under the vault's configDir. Wires no-op when
    // basePath is null (mobile / unusual builds) or the toggle is off.
    if (this.settings.telemetryEnabled && basePath) {
      void telemetry.setEnabled(
        true,
        telemetryLogPath(basePath, this.app.vault.configDir, this.manifest.id),
      );
    }

    this.fsChangeListener = new FsChangeListener(this.app);

    const client = new SftpClient(
      this.authResolver,
      this.hostKeyStore,
      (prompts) => new KbdInteractiveModal(this.app, prompts).prompt(),
      (info) => new HostKeyMismatchModal(this.app, info).prompt(),
    );
    client.onClose(({ unexpected }) => {
      if (unexpected) {
        new Notice('Remote SSH: connection lost — reconnecting…');
        void this.startReconnect();
      }
    });
    this.conn = new ConnectionManager(client, {
      locateDaemonBinary: () => this.locateDaemonBinary(),
    });
    this.conn.activeRemoteBasePath = null;

    this.addSettingTab(new SettingsTab(this.app, this));

    this.statusBar = new StatusBar(this, () => this.onStatusBarClick());
    this.statusBar.update(this.state);

    // Pending-edits indicator: shown only when the offline queue has
    // entries. Click opens the read-only listing + "discard all"
    // button. The bar starts hidden; replayOfflineQueue (inside
    // AdapterManager) and the queue-aware adapter writes call into
    // this bar's refresh helper.
    this.pendingEditsBar = new PendingEditsBar(this, () => void this.adapterMgr.showPendingEditsModal());

    // Large transfer indicator (#127) — shown only when >1 MB
    // file transfers are in flight. Subscribes to transferTracker.
    this.largeTransferBar = new LargeTransferBar(this, this.transferTracker);

    this.adapterMgr = new AdapterManager(
      this.app,
      this.manifest,
      this.conn,
      this.fsChangeListener,
      this.pendingEditsBar,
      () => this.settings,
      this.transferTracker,
    );

    // #341 follow-up: a writer rename reflects into the model fine,
    // but Obsidian's own post-adapter `Vault.rename` reconcile crashes
    // on this build and orphans the open tab. Own the editor-follow:
    // if the file was open and Obsidian dropped it, re-open it. Gated
    // by `isPatched` so an unconnected local vault is untouched.
    const renameFollower = new RenameLeafFollower(
      {
        isPathOpen: (p) =>
          this.app.workspace
            .getLeavesOfType('markdown')
            .some(
              (l) =>
                (l.view as unknown as { file?: { path?: string } } | undefined)
                  ?.file?.path === p,
            ),
        reopen: (p) => {
          const af = this.app.vault.getAbstractFileByPath(p);
          if (af instanceof TFile) {
            void this.app.workspace.getLeaf('tab').openFile(af);
          }
        },
      },
      () => this.adapterMgr.isPatched(),
      (cb) => { window.setTimeout(cb, 0); },
    );
    this.registerEvent(
      this.app.vault.on('rename', (file) => renameFollower.handleRename(file)),
    );

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
        const active = this.conn.reconnectManager?.isActive() ?? false;
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

    this.addCommand({
      id: 'show-onboarding',
      name: 'Set up first remote vault',
      callback: () => this.showOnboarding(),
    });

    // #149 — terminal pane. View registered unconditionally so a
    // shadow vault that's still warming up can re-open a leaf saved
    // in workspace.json before the connection completes; the View
    // itself handles the disconnected state.
    this.registerView(VIEW_TYPE_REMOTE_TERMINAL, leaf => new RemoteTerminalView(leaf, {
      getClient: () => this.conn.client.isAlive() ? this.conn.client : null,
      settings: this.settings,
    }));

    this.addCommand({
      id: 'open-terminal',
      name: 'Open remote terminal',
      checkCallback: (checking) => {
        const ready = this.conn.client.isAlive();
        if (checking) return ready;
        if (ready) void this.openRemoteTerminal();
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
      if (this.settings.autoConnectProfileId) {
        void this.runShadowStartup();
        return;
      }
      // F17 — first-launch onboarding. Opens the wizard when the user
      // has no profiles yet AND hasn't dismissed onboarding before.
      // Skipped on shadow vaults (auto-connect path above).
      if (this.settings.profiles.length === 0 && !this.settings.onboardingCompleted) {
        this.showOnboarding();
      }
    });
  }

  private showOnboarding() {
    new OnboardingModal(
      this.app,
      this.getProfileFormDeps(),
      async ({ profile, dismissOnboarding }) => {
        // Single coalesced saveSettings — push profile + flip the
        // dismiss flag in one disk write rather than two (M2 from
        // PR #222 review).
        let dirty = false;
        if (profile) {
          this.settings.profiles.push(profile);
          dirty = true;
        }
        if (dismissOnboarding && !this.settings.onboardingCompleted) {
          this.settings.onboardingCompleted = true;
          dirty = true;
        }
        if (dirty) await this.saveSettings();
      },
    ).open();
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
    this.adapterMgr.restore();
    void this.disconnect().catch(() => { /* ignore */ });
    this.statusBar?.remove();
    this.pendingEditsBar?.remove();
    this.largeTransferBar?.remove();
    this.observability?.uninstall();
    // F22 — flush any in-memory counters before the process tears down.
    void telemetry.setEnabled(false);
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

  /** Expose auth deps for the ProfileForm's Browse button. */
  getProfileFormDeps() {
    return { authResolver: this.authResolver, hostKeyStore: this.hostKeyStore };
  }

  /** Daemon status for the settings panel. */
  getDaemonStatus(): { status: 'running' | 'down' | 'none'; version?: string; capabilities?: number } {
    if (!this.conn.rpcConnection) return { status: 'none' };
    try {
      const info = this.conn.rpcConnection.info;
      return { status: 'running', version: info.version, capabilities: info.capabilities.length };
    } catch {
      return { status: 'down' };
    }
  }

  /** Read the last N lines of the daemon log from the remote. */
  async readDaemonLog(lines = 50): Promise<string> {
    if (!this.conn.isAlive()) throw new Error('Not connected');
    const r = await this.conn.client.exec(`tail -n ${lines} ~/.obsidian-remote/server.log 2>/dev/null || echo '(no log file)'`);
    return r.stdout;
  }

  /** Restart the daemon: stop existing + redeploy. */
  async restartDaemon(): Promise<void> {
    const profile = this.conn.activeProfile;
    const basePath = this.conn.activeRemoteBasePath;
    if (!profile || !basePath) throw new Error('No active profile');
    if (this.conn.daemonDeployer && this.conn.isAlive()) {
      try { await this.conn.daemonDeployer.stop(); } catch { /* best effort */ }
    }
    if (this.conn.rpcConnection) {
      try { this.conn.rpcConnection.close(); } catch { /* already dead */ }
      this.conn.rpcConnection = null;
    }
    this.conn.daemonDeployer = null;
    await this.conn.startRpcSession(profile, basePath);
    // Rebind adapter to the fresh RPC client
    this.adapterMgr.dataAdapter?.swapClient(this.conn.buildFsClient());
  }

  async saveSettings() {
    await this.saveData({
      ...this.settings,
      hostKeyStore: this.hostKeyStore.serialize(),
      secrets: this.secretStore.serialize(),
    });
  }

  async connectProfile(profile: SshProfile) {
    if (this.conn.isAlive()) {
      new Notice('Remote SSH: already connected. Disconnect first.');
      return;
    }
    this.setState(SyncState.CONNECTING);
    try {
      await this.conn.connectSsh(profile);
    } catch (e) {
      this.setState(SyncState.ERROR);
      const { notice, classified } = classifyToNotice(e);
      logger.error(`Connect failed: ${classified.title}`, {
        category: classified.category, code: classified.code,
        original: classified.original.message, profileId: profile.id,
      });
      new Notice(notice);
      try { await this.conn.client.disconnect(); } catch { /* ignore */ }
      return;
    }

    const transport = profile.transport ?? 'sftp';
    let rpcSummary = '';
    if (transport === 'rpc') {
      try {
        await this.conn.startRpcSession(profile, this.conn.activeRemoteBasePath!);
        const caps = this.conn.rpcConnection?.info.capabilities.length ?? 0;
        const ver  = this.conn.rpcConnection?.info.version ?? '?';
        rpcSummary = ` — daemon ${ver}, ${caps} capabilities`;
      } catch (e) {
        this.setState(SyncState.ERROR);
        const { notice, classified } = classifyToNotice(e);
        logger.error(`RPC startup failed: ${classified.title}`, {
          category: classified.category, code: classified.code,
          original: classified.original.message, profileId: profile.id,
        });
        new Notice(notice);
        try { await this.conn.client.disconnect(); } catch { /* ignore */ }
        return;
      }
    }

    this.setState(SyncState.CONNECTED);
    this.settings.activeProfileId = profile.id;
    await this.saveSettings();

    const patched = await this.adapterMgr.patch();
    if (!patched) {
      new Notice('Remote SSH: adapter patch failed — disconnecting');
      await this.disconnect().catch(() => { /* already errored */ });
      return;
    }

    const userLabel = ConnectionManager.formatUserLabel(this.settings);
    new Notice(
      `Remote SSH: Connected to ${profile.name} as ${userLabel} via ${transport.toUpperCase()}${rpcSummary}`,
    );
    void this.adapterMgr.replayOfflineQueue('after-connect');
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

    if (this.conn.client.isAlive()) {
      logger.info(`runAutoConnect(${tag}): client already alive — disconnecting first`);
      try { await this.disconnect(); } catch { /* swallow; we're about to reconnect */ }
    }

    logger.info(`runAutoConnect(${tag}): connecting to profile ${profile.name}`);
    await this.connectProfile(profile);

    if (this.state !== SyncState.CONNECTED) {
      // A shadow-window auto-connect failed. `connectProfile` ALREADY
      // emitted a classified, cause-specific Notice (auth / host /
      // remote-path / patch) into THIS same shadow window on every
      // failure path — a second generic toast here just stacks on top
      // of it and pushes the specific cause off-screen. Keep the log
      // line (the diagnostic trail the e2e oracle asserts on); do not
      // double-Notice.
      logger.warn(
        `runAutoConnect(${tag}): connect did not reach CONNECTED state ` +
        `(connectProfile surfaced the cause); skipping populate`,
      );
      return;
    }

    // Pull the shared Obsidian config (app.json / appearance.json /
    // core-plugins.json / hotkeys.json) from the remote onto the
    // local shadow disk *before* the populate, so the next time this
    // window restarts Obsidian reads fresh settings instead of the
    // stale local copy (#342). Best-effort: a failure here must not
    // block rendering the vault.
    const da = this.adapterMgr.dataAdapter;
    const hostAdapter = this.app.vault.adapter;
    if (da && hostAdapter instanceof FileSystemAdapter) {
      const localConfigDir = path.join(
        hostAdapter.getBasePath(), this.app.vault.configDir,
      );
      const remoteConfigDir = this.app.vault.configDir;
      try {
        const cfg = await ShadowVaultBootstrap.pullSharedObsidianConfig(
          da, remoteConfigDir, localConfigDir,
        );
        if (cfg.errored.length > 0) {
          // The connection is up but some shared-config files the
          // remote *had* couldn't be pulled (transient SSH error /
          // corrupt file). Without a signal the user would just see
          // settings silently not update — the #342 symptom. Absent
          // files are not errored, so a fresh vault stays quiet.
          new Notice(
            `Remote SSH: ${cfg.errored.length} shared-config file` +
            `${cfg.errored.length === 1 ? '' : 's'} (${cfg.errored.join(', ')}) ` +
            'could not be synced — settings may be stale until the next connect',
          );
        }
      } catch (e) {
        logger.warn(
          `runAutoConnect(${tag}): shared-config pull failed: ${errorMessage(e)}`,
        );
      }

      // #342 push half: pull only brought remote→local. Without this,
      // a settings change made HERE never reaches the remote, so the
      // next session's pull finds nothing and the change evaporates.
      // Watch the local config dir and push divergent shared files.
      this.sharedConfigWatcher?.stop();
      const watcher = new SharedConfigWatcher({
        watch: (onChange) => {
          const w = fs.watch(
            localConfigDir, { persistent: false },
            (_evt, filename) => onChange(filename ? String(filename) : null),
          );
          return { close: () => w.close() };
        },
        readLocal: (b) => {
          try { return fs.readFileSync(path.join(localConfigDir, b), 'utf-8'); }
          catch { return null; }
        },
        flush: async () => {
          const r = await ShadowVaultBootstrap.pushSharedObsidianConfig(
            da, remoteConfigDir, localConfigDir,
          );
          if (r.errored.length > 0) {
            new Notice(
              `Remote SSH: ${r.errored.length} shared-config file` +
              `${r.errored.length === 1 ? '' : 's'} (${r.errored.join(', ')}) ` +
              'could not be pushed — settings change not yet saved remotely',
            );
          }
        },
        debounceMs: 1500,
        setTimer: (cb, ms) => window.setTimeout(cb, ms),
        clearTimer: (h) => window.clearTimeout(h as number),
      });
      // Seed the just-pulled bytes as the synced baseline so the
      // pull's own writes (and Obsidian re-saving an identical file
      // on open) don't immediately echo back to the remote.
      for (const base of ShadowVaultBootstrap.SHARED_OBSIDIAN_CONFIG_FILES) {
        try {
          watcher.markSynced(
            base, fs.readFileSync(path.join(localConfigDir, base), 'utf-8'),
          );
        } catch { /* absent locally — nothing to baseline */ }
      }
      watcher.start();
      this.sharedConfigWatcher = watcher;
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

  private cancelReconnect(): void {
    if (!this.conn.reconnectManager?.isActive()) return;
    this.conn.cancelReconnect();
    this.adapterMgr.restore();
    this.setState(SyncState.ERROR);
    new Notice('Remote SSH: reconnect cancelled');
  }

  private async startReconnect(): Promise<void> {
    if (!this.conn.activeProfile) {
      logger.warn('startReconnect: no active profile to reconnect with');
      this.setState(SyncState.ERROR);
      return;
    }
    const maxRetries = this.settings.reconnectMaxRetries ?? DEFAULT_SETTINGS.reconnectMaxRetries;
    if (maxRetries <= 0) {
      logger.info('startReconnect: auto-reconnect disabled (reconnectMaxRetries <= 0)');
      this.adapterMgr.restore();
      this.setState(SyncState.ERROR);
      return;
    }
    this.setState(SyncState.RECONNECTING);
    await this.conn.startReconnect({
      maxRetries,
      setAdapterReconnecting: (on) => this.adapterMgr.dataAdapter?.setReconnecting(on),
      onState: (s) => this.onReconnectStateChange(s),
      hooks: {
        swapClient: (c) => this.adapterMgr.dataAdapter?.swapClient(c),
        prepareListenerForReconnect: () => this.fsChangeListener.prepareForReconnect(),
        resumeListenerAfterReconnect: async (rpc) => {
          const da = this.adapterMgr.dataAdapter;
          if (da) {
            await this.fsChangeListener.resumeAfterReconnect({
              rpcConnection: rpc,
              dataAdapter: da,
            });
          }
        },
      },
    });
  }

  /**
   * Project the manager's state onto the StatusBar + Notice surface
   * and, on terminal states, clean up.
   */
  private onReconnectStateChange(s: ReconnectState): void {
    // F22 — opt-in telemetry. No-op when disabled.
    telemetry.recordReconnect(s.kind);
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
      this.adapterMgr.dataAdapter?.setReconnecting(false);
      this.setState(SyncState.CONNECTED);
      new Notice('Remote SSH: reconnected');
      this.conn.reconnectManager = null;
      // Drain any writes that landed during the disconnect. Fire-and-
      // forget: the user's already-back state is independent of the
      // replay outcome, and individual op failures stay in the queue
      // for the next reconnect.
      void this.adapterMgr.replayOfflineQueue('after-reconnect');
    } else if (s.kind === 'failed') {
      // Give up: tear the patched adapter down so Obsidian falls
      // back to local file:// reads instead of blocking forever on a
      // dead transport. restore() clears dataAdapter so the
      // setReconnecting flag goes with it.
      this.sharedConfigWatcher?.stop();
      this.sharedConfigWatcher = null;
      this.adapterMgr.restore();
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
      this.conn.reconnectManager = null;
    } else if (s.kind === 'cancelled') {
      this.adapterMgr.dataAdapter?.setReconnecting(false);
      this.conn.reconnectManager = null;
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
      || this.conn.isAlive()
      || this.settings.activeProfileId !== null;
    this.conn.cancelReconnect();
    // #149 — close the terminal pane(s) before tearing the SSH
    // session down so the shell channel close fires while the ssh2
    // Client is still around (cleaner teardown logs).
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_REMOTE_TERMINAL);
    // Stop the #342 config watcher before the transport goes — its
    // flush pushes through the (about-to-be-restored) adapter.
    this.sharedConfigWatcher?.stop();
    this.sharedConfigWatcher = null;
    this.adapterMgr.restore();
    await this.conn.disconnectTransport();
    this.setState(SyncState.IDLE);
    if (this.settings.activeProfileId !== null) {
      this.settings.activeProfileId = null;
      await this.saveSettings();
    }
    if (wasActive) new Notice('Remote SSH: disconnected');
  }

  /**
   * Open or reveal the remote terminal pane in the right sidebar.
   * Re-using an existing leaf keeps the shell channel alive across
   * focus changes; opening a fresh leaf each time would reset
   * scrollback and lose any in-flight commands.
   *
   * Uses `setActiveLeaf` rather than `revealLeaf` because the latter
   * requires Obsidian v1.7.2 and our manifest declares
   * `minAppVersion: 1.4.0` — `setActiveLeaf` has the same observable
   * effect (focus + render) and has been stable since pre-1.0.
   */
  async openRemoteTerminal(): Promise<void> {
    if (this.openingTerminal) return;
    this.openingTerminal = true;
    try {
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_REMOTE_TERMINAL);
      if (existing.length > 0) {
        this.app.workspace.setActiveLeaf(existing[0], { focus: true });
        return;
      }
      const leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice('Remote SSH: no available workspace leaf to open the terminal in');
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE_REMOTE_TERMINAL, active: true });
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    } finally {
      this.openingTerminal = false;
    }
  }

  /**
   * POC for the shadow-vault architecture (see
   * docs/en/architecture/shadow-vault.md, Phase 1): walk the patched
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
   * unless `this.conn.client?.isAlive()`.
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
      rpcConnection: this.conn.rpcConnection ?? undefined,
      // Older profiles have no walkIgnoreDirs → fall back to the
      // sensible defaults so existing users immediately benefit. An
      // explicit empty array (user cleared it) means "ignore nothing"
      // and is respected (?? only fills null/undefined).
      ignoreDirs: this.conn.activeProfile?.walkIgnoreDirs
        ?? [...DEFAULT_WALK_IGNORE_DIRS],
    });
    const walk = await walker.walk('');
    logger.info(
      `populateVaultFromRemote(${label}): ${walk.source}, ${walk.entries.length} entries ` +
      `in ${walk.walkMs}ms (pages=${walk.pages})` +
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

    // Don't let a failed/clipped populate look like a working-but-empty
    // vault (the silent "remote files won't open" symptom). Surface it.
    if (walk.entries.length === 0) {
      new Notice(
        'Remote SSH: 0 files found on the remote. Check the profile’s ' +
        'remotePath actually points at the vault (see console.log).',
        10_000,
      );
    } else if (walk.truncated) {
      new Notice(
        `Remote SSH: remote tree is very large — loaded ${walk.entries.length} ` +
        'entries but it is still incomplete. Point the profile’s remotePath ' +
        'at the vault folder, not a large parent directory (see console.log).',
        15_000,
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

    // The spawned window can take several seconds to surface while
    // Obsidian keeps THIS (source) window focused. Without this guard
    // an impatient re-click re-bootstraps + re-fires obsidian://open,
    // and the user just sees more churn — never the new window.
    if (this.shadowSpawnInFlight) {
      new Notice('Remote SSH: the remote vault is still opening — give it a moment');
      return;
    }
    this.shadowSpawnInFlight = true;

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
      // Spawn SUCCEEDED. The new window can take several seconds to
      // surface while Obsidian keeps THIS one focused — hold the guard
      // ~15s so an impatient double/triple-click can't fire a second
      // spawn into that gap. `activeWindow.setTimeout` (not bare
      // setTimeout) for Obsidian popout-window compatibility.
      window.setTimeout(() => { this.shadowSpawnInFlight = false; }, 15_000);
    } catch (e) {
      // Spawn FAILED — nothing is opening. Clear the guard NOW so the
      // user can retry immediately; a 15s lockout here would strand
      // them on a failed connect behind a misleading "still opening"
      // (the original `finally` armed the timer on this path too).
      this.shadowSpawnInFlight = false;
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
    if (this.state !== SyncState.CONNECTED || !this.conn.activeRemoteBasePath) {
      new Notice('Remote SSH: connect first');
      return;
    }
    if (this.adapterMgr.isPatched()) {
      new Notice('Remote SSH: adapter already patched');
      return;
    }
    const transportLabel = this.conn.rpcConnection ? 'RPC' : 'SFTP';
    const ok = await this.adapterMgr.patch();
    if (ok) {
      new Notice(`Remote SSH: adapter patched via ${transportLabel}`);
    } else {
      new Notice('Remote SSH: adapter patch failed (see console.log)');
    }
  }

  private debugRestoreAdapter(): void {
    if (!this.adapterMgr.isPatched()) {
      new Notice('Remote SSH: adapter is not patched');
      return;
    }
    this.adapterMgr.restore();
    new Notice('Remote SSH: adapter restored');
  }

  private async debugListRoot(): Promise<void> {
    try {
      const out = await this.app.vault.adapter.list('');
      const via = this.adapterMgr.isPatched() ? 'PATCHED (SFTP)' : 'ORIGINAL (local)';
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
    if (this.state !== SyncState.CONNECTED || !this.conn.client.isAlive()) {
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
      const deployer = new ServerDeployer(this.conn.client);
      const deploy = await deployer.deploy({
        localBinaryPath,
        remoteBinaryPath,
        remoteVaultRoot,
        remoteSocketPath,
        remoteTokenPath,
      });
      logger.info(`debugTestRpcTunnel: daemon up; token len=${deploy.token.length}`);

      const stream = await this.conn.client.openUnixStream(deploy.remoteSocketPath);
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

