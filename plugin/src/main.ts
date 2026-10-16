import { Plugin, Notice, Modal, FileSystemAdapter, TFile, TFolder } from 'obsidian';
import type { PluginSettings, SshProfile } from './types';
import { SyncState } from './types';
import { DEFAULT_SETTINGS, DEFAULT_WALK_IGNORE_DIRS } from './constants';
import { SftpClient } from './ssh/SftpClient';
import { AuthResolver, resolveAgentSocket } from './ssh/AuthResolver';
import { diagnoseAgentAuth } from './ssh/AgentIdentities';
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
import { LazyFolderLoader } from './vault/LazyFolderLoader';
import { BackgroundIndexer, type IndexComplete, type IndexProgress } from './vault/BackgroundIndexer';
import { StartupReadGate } from './adapter/StartupReadGate';
import {
  collectModelEntries,
  deleteTreeSnapshot,
  readTreeSnapshot,
  treeSnapshotPath,
  writeTreeSnapshot,
} from './vault/TreeSnapshot';
import type { RemoteEntry } from './vault/VaultModelBuilder';
import { pathVisibility } from './vault/BulkWalker';
import { RenameLeafFollower } from './vault/RenameLeafFollower';
import { ObsidianRegistry } from './shadow/ObsidianRegistry';
import { ShadowVaultBootstrap } from './shadow/ShadowVaultBootstrap';
import { sanitiseStateKey } from './shadow/vaultNaming';
import type { BootstrapResult } from './shadow/ShadowVaultBootstrap';
import { pullSharedObsidianConfig } from './shadow/SharedObsidianConfigSync';
import type { SharedConfigReader } from './shadow/SharedObsidianConfigSync';
import {
  communityPluginsBasePath,
  pullCommunityPlugins,
  pullPluginBinaries,
  readEnabledPluginIds,
} from './shadow/CommunityPluginsSync';
import { SharedConfigWatcher } from './shadow/SharedConfigWatcher';
import { syncConfigAfterConnect } from './shadow/postConnectConfigSync';
import { ShadowVaultManager } from './shadow/ShadowVaultManager';
import { WindowSpawner } from './shadow/WindowSpawner';
import { ShadowStartupCoordinator } from './shadow/ShadowStartupCoordinator';
import * as os from 'os';
import { ObservabilityInstaller } from './util/ObservabilityInstaller';
import { normalizeRemotePath } from './util/pathUtils';
import { PathMapper } from './path/PathMapper';
import { preSpawnRemotePath } from './shadow/preSpawnPaths';
import { withTimeout } from './util/withTimeout';
import * as path from 'path';
import { errorMessage } from "./util/errorMessage";
import { ConnectionManager, DaemonUnavailableError } from "./ConnectionManager";
import { connectionLostNotice } from './transport/connectionLostNotice';
import { buildReconnectHooks } from './transport/reconnectHooks';
import { DaemonVerificationError } from './transport/DaemonDownloader';
import { ensureDaemonBinary as ensureRemoteDaemonBinary } from './transport/ensureDaemonBinary';
import { TransferTracker } from "./util/TransferTracker";
import { LargeTransferBar } from "./ui/LargeTransferBar";
import { OnboardingModal } from "./ui/OnboardingModal";
import { telemetry, telemetryLogPath } from "./util/Telemetry";

/**
 * Everything this plugin keeps OUTSIDE any vault, on every OS:
 * `~/.obsidian-remote/` — the shadow `vaults/` themselves, plus the
 * per-device, never-synced `state/` (the community-plugins base
 * snapshots; see `communityPluginsBasePath` in CommunityPluginsSync).
 * `os.homedir()` resolves at runtime — no hardcoded user.
 */
const shadowStateRoot = (): string => path.join(os.homedir(), '.obsidian-remote');

/** Where shadow vaults live: `~/.obsidian-remote/vaults/`. */
const shadowVaultsDir = (): string => path.join(shadowStateRoot(), 'vaults');

/**
 * Whether a background index reports itself: `if-added` (connect) only when
 * it filled a gap, `always` when it completes an interrupted index, `never`
 * for a reconnect's catch-up.
 */
type Announce = 'if-added' | 'always' | 'never';

export default class RemoteSshPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;

  private secretStore  = new SecretStore();
  private authResolver = new AuthResolver(this.secretStore);
  private hostKeyStore = new HostKeyStore();
  private conn!: ConnectionManager;
  private adapterMgr!: AdapterManager;
  private statusBar!: StatusBar;
  private state: SyncState = SyncState.IDLE;
  /** A dropped session had a live fs.watch: events missed until a pass completes. */
  private missedEvents = false;
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
    // Before anything else that awaits: Obsidian runs metadataCache.initialize()
    // right after every plugin's onload resolves (see TreeSnapshot).
    await this.restoreTreeSnapshot();

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
    client.onClose(({ unexpected, reason }) => {
      if (unexpected) void this.startReconnect(reason);
    });
    this.conn = new ConnectionManager(client, {
      locateDaemonBinary: () => this.locateDaemonBinary(),
      ensureDaemonBinary: (c) => this.ensureDaemonBinary(c),
      // The daemon dying is a lost connection too, even though SSH may be
      // fine. Both go to the same place, and `startReconnect` announces —
      // on the RPC transport an SSH drop kills the tunnel with it, so both
      // paths fire for one failure and the user must still see one notice.
      onRpcClose: (reason) => { void this.startReconnect(reason); },
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

    this.registerCommands();

    // Inside `onLayoutReady` so Obsidian has finished initialising the vault
    // before anything touches plugins or the adapter. See `runShadowStartup`.
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
    // Last, once the callback that releases it is registered: a throw earlier
    // in onload must not leave note calls held.
    this.installStartupGate();
  }

  /**
   * The command palette surface, and the terminal view the last one opens.
   *
   * Lifted out of `onload` whole: it was 86 lines of the 202, and the only
   * stretch a reader has to scroll past to find the wiring. Order-independent
   * with respect to everything around it, which the rest of `onload` is not —
   * the construction above it is sequenced on purpose and the comments there
   * say why, so it stays where those constraints are visible.
   */
  private registerCommands(): void {
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
   * A shadow vault's notes exist only on the remote: hold note calls from
   * layout-ready (when plugins like Dataview start indexing) until the remote
   * adapter is in, instead of failing them against the empty shadow folder.
   * `runShadowStartup` always opens it.
   */
  private installStartupGate(): void {
    if (!this.settings.autoConnectProfileId) return;
    const gate = new StartupReadGate(this.app.vault.adapter as unknown as Record<string, unknown>, {
      configDir: this.app.vault.configDir,
      layoutReady: () => this.app.workspace.layoutReady,
    });
    gate.install();
    this.adapterMgr.setStartupGate(gate);
  }

  /**
   * Connect, then offer the plugin suggestions captured at bootstrap and
   * stage any binaries the list names but disk lacks. Separate from
   * `runAutoConnect` so Reconnect re-runs only the connect half.
   */
  private async runShadowStartup(): Promise<void> {
    const coordinator = new ShadowStartupCoordinator(
      this.app, this.settings, () => this.saveSettings(),
    );
    try {
      await this.runAutoConnect('layout-ready');
    } finally {
      // Patched or not, nothing may stay held: without a remote adapter, held
      // calls fall back to the native one, as they did before the gate.
      this.adapterMgr.openStartupGate();
      // After the connect, never before: installing can await a plugin's
      // onload, and one that reads a note there would wait on the gate.
      // Logged, not thrown: a failed connect's error is the one to surface.
      await coordinator.prepareForAutoConnect().catch((e: unknown) => {
        logger.warn(`runShadowStartup: plugin install failed: ${errorMessage(e)}`);
      });
    }
  }

  onunload() {
    this.adapterMgr.openStartupGate();
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
    // Through the manager, not around it: closing the wire from here left the
    // "we hung up" flag unset, so the restart announced itself as a lost
    // connection and started a reconnect that raced it.
    await this.conn.teardownRpcSession();
    await this.conn.startRpcSession(profile, basePath);
    // Rebind adapter to the fresh RPC client
    this.adapterMgr.dataAdapter?.rebind(this.conn.buildBinding());
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
      // ssh2 drops agent identities it cannot parse without a word (#536).
      // Certificates are handled now; a FIDO-only agent still fails as
      // "authentication failed" and nothing more. Ask the agent what it
      // holds and say so — best effort, silent when that is not the problem.
      let agentHint: string | null = null;
      if (classified.category === 'auth' && profile.authMethod === 'agent') {
        agentHint = await diagnoseAgentAuth(resolveAgentSocket(profile));
        if (agentHint) logger.warn(`Connect failed: ${agentHint}`);
      }
      new Notice(agentHint ? `${notice}\n\n${agentHint}` : notice);
      try { await this.conn.client.disconnect(); } catch { /* ignore */ }
      return;
    }

    let transport = profile.transport ?? 'sftp';
    let rpcSummary = '';
    if (transport === 'rpc') {
      try {
        await this.conn.startRpcSession(profile, this.conn.activeRemoteBasePath!);
        const caps = this.conn.rpcConnection?.info.capabilities.length ?? 0;
        const ver  = this.conn.rpcConnection?.info.version ?? '?';
        rpcSummary = ` — daemon ${ver}, ${caps} capabilities`;
      } catch (e) {
        // The daemon is an optimization layer, not a requirement. Most
        // failures to bring it up degrade to SFTP rather than failing the
        // whole connect — a hard failure skips populate and strands the user
        // on an EMPTY vault. SFTP shares the same live SSH channel, so
        // read/write/sync still work (minus daemon-only features: fast walk,
        // thumbnails, live watch, image/PDF rendering).
        //
        // EXCEPTION: a daemon binary that fails integrity verification
        // (checksum mismatch / bad manifest) fails LOUD and does NOT
        // downgrade — silently falling back could mask a tampered or corrupt
        // binary (supply-chain safety, #406).
        if (e instanceof DaemonVerificationError) {
          this.setState(SyncState.ERROR);
          const { notice, classified } = classifyToNotice(e);
          logger.error(`RPC startup failed (verification): ${classified.title}`, {
            category: classified.category, code: classified.code,
            original: classified.original.message, profileId: profile.id,
          });
          new Notice(notice);
          try { await this.conn.client.disconnect(); } catch { /* ignore */ }
          return;
        }
        if (e instanceof DaemonUnavailableError) {
          // Expected: unsupported remote arch, or the user declined download.
          logger.warn(`RPC unavailable, falling back to SFTP: ${e.message}`);
          new Notice('Remote SSH: daemon unavailable — connected via SFTP (reduced features).');
        } else {
          // Unexpected daemon-start failure (deploy / token-write timeout /
          // handshake mismatch). Log the classified cause for diagnosis, but
          // still degrade to SFTP instead of leaving the vault empty.
          const { classified } = classifyToNotice(e);
          logger.warn(`RPC startup failed, falling back to SFTP: ${classified.title}`, {
            category: classified.category, code: classified.code,
            original: classified.original.message, profileId: profile.id,
          });
          new Notice('Remote SSH: daemon failed to start — connected via SFTP (reduced features). See console.log.');
        }
        transport = 'sftp';
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
   * Connect to `settings.autoConnectProfileId` and populate the vault from
   * the remote tree. Runs at layout-ready and again from Reconnect; `tag`
   * distinguishes the two in the log.
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

    const da = this.adapterMgr.dataAdapter;
    const hostAdapter = this.app.vault.adapter;
    if (da && hostAdapter instanceof FileSystemAdapter) {
      const localConfigDir = path.join(hostAdapter.getBasePath(), this.app.vault.configDir);
      this.sharedConfigWatcher?.stop();
      this.sharedConfigWatcher = await syncConfigAfterConnect({
        adapter: da,
        remoteConfigDir: this.app.vault.configDir,
        localConfigDir,
        stateRoot: shadowStateRoot(),
        profileId: profile.id,
        installMissingPlugins: () =>
          new ShadowStartupCoordinator(this.app, this.settings, () => this.saveSettings())
            .installMissingShadowPlugins(),
        notify: (m) => { new Notice(m); },
        tag,
      });
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

  private async startReconnect(cause?: Error): Promise<void> {
    // Its walker rides the transport that just died, and its skip filter
    // predates edits queued during the outage.
    this.backgroundIndexer?.cancel();
    this.backgroundIndexer = null;
    if (!this.conn.activeProfile) {
      logger.warn('startReconnect: no active profile to reconnect with');
      this.setState(SyncState.ERROR);
      return;
    }
    // One failure, one notice. Both close paths lead here, and on the RPC
    // transport a dropped SSH connection takes the tunnel with it, so both
    // fire for the same event — announcing from the callers stacked two
    // toasts on the most ordinary disconnect there is.
    if (this.state === SyncState.RECONNECTING) {
      logger.info(`startReconnect: already reconnecting${cause ? ` (${cause.message})` : ''}`);
      return;
    }
    // Read before the reconnect resubscribes: did the dropped session watch?
    // Accumulated: a catch-up this drop cancelled still owes its walk.
    this.missedEvents ||= this.fsChangeListener.isSubscribed();
    const maxRetries = this.settings.reconnectMaxRetries ?? DEFAULT_SETTINGS.reconnectMaxRetries;
    if (maxRetries <= 0) {
      logger.info('startReconnect: auto-reconnect disabled (reconnectMaxRetries <= 0)');
      new Notice(connectionLostNotice(cause, false));
      this.adapterMgr.restore();
      this.setState(SyncState.ERROR);
      return;
    }
    new Notice(connectionLostNotice(cause, true));
    this.setState(SyncState.RECONNECTING);
    await this.conn.startReconnect({
      maxRetries,
      setAdapterReconnecting: (on) => this.adapterMgr.dataAdapter?.setReconnecting(on),
      onState: (s) => this.onReconnectStateChange(s),
      hooks: buildReconnectHooks({
        dataAdapter: () => this.adapterMgr.dataAdapter,
        fsChangeListener: this.fsChangeListener,
      }),
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
      this.catchUpAfterReconnect();
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
    // Drop lazy-load state — the walker it captured is now disconnected. A
    // stray File-Explorer click after this finds a null loader and no-ops.
    this.lazyLoader = null;
    // Same for the background full-index pass: its walker rides the transport
    // we're about to tear down, so stop it before the socket goes. `cancel()`
    // makes it bail at its next checkpoint (one folder / one depth level away),
    // and dropping the reference makes its late progress emits no-ops.
    this.backgroundIndexer?.cancel();
    this.backgroundIndexer = null;
    await this.conn.disconnectTransport();
    this.setState(SyncState.IDLE);
    if (this.settings.activeProfileId !== null) {
      this.settings.activeProfileId = null;
      await this.saveSettings();
    }
    if (wasActive) new Notice('Remote SSH: disconnected');
  }

  /**
   * Re-uses an existing leaf so the shell channel, scrollback and any
   * in-flight command survive a focus change.
   *
   * `setActiveLeaf`, not `revealLeaf`: the latter needs Obsidian 1.7.2 and
   * the manifest declares 1.5.0. Same observable effect.
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

  /** Lazy per-folder loader (deepen-on-expand); null until a lazy connect. */
  private lazyLoader: LazyFolderLoader | null = null;
  private lazyExpandHookInstalled = false;

  /** Background full-tree index; null until a lazy connect, dropped on disconnect. */
  private backgroundIndexer: BackgroundIndexer | null = null;
  /** A background index has completed in this session. */
  private vaultIndexed = false;

  /**
   * Files put into the model from the tree snapshot at startup, before any
   * connect. Null when no snapshot was restored this session.
   */
  private snapshotFiles: Set<string> | null = null;
  /** Whether the post-connect metadata catch-up for snapshot files has run. */
  private snapshotMetadataChecked = false;

  /** The profile whose tree snapshot applies to this vault, if any. */
  private snapshotProfile(): SshProfile | null {
    const id = this.settings.autoConnectProfileId;
    // The snapshot is only ever reconciled by the background index, which runs
    // in lazy mode; the eager walk has nothing to reconcile it with.
    if (!id || this.settings.lazyFolderLoad === false) return null;
    return this.settings.profiles.find((p) => p.id === id) ?? null;
  }

  private treeSnapshotFile(profileId: string): string {
    return treeSnapshotPath(shadowStateRoot(), sanitiseStateKey(profileId));
  }

  /** The vault's note tree as it stands, without the root and the config dir. */
  private modelEntries(): RemoteEntry[] {
    return collectModelEntries(this.app.vault.getAllLoadedFiles(), this.app.vault.configDir);
  }

  /**
   * Put last session's remote tree into the vault model during `onload`, so
   * Obsidian's metadataCache.initialize() keeps its cached index instead of
   * deleting every note it cannot see on the shadow disk (#513). Reconciled
   * against the real remote once the background index has walked it.
   */
  private async restoreTreeSnapshot(): Promise<void> {
    const profile = this.snapshotProfile();
    if (!profile) return;
    try {
      const stored = readTreeSnapshot(
        this.treeSnapshotFile(profile.id), profile.remotePath, this.app.vault.configDir,
      );
      if (!stored || stored.length === 0) return;
      const start = Date.now();
      // The snapshot was captured under LAST session's ignore / allowed-hidden
      // settings. Judge every entry by the CURRENT ones, or a folder the user
      // has since ignored comes back at every launch and only goes away once
      // the background index has walked the whole remote.
      const rules = {
        ignoreDirs: profile.walkIgnoreDirs ?? [...DEFAULT_WALK_IGNORE_DIRS],
        allowedHiddenDirs: profile.allowedHiddenDirs,
        configDir: this.app.vault.configDir,
      };
      const entries = stored.filter((e) => pathVisibility(e.path, e.isDirectory, rules));
      const dropped = stored.length - entries.length;
      if (entries.length === 0) return;
      // BEFORE the insert, not after. `buildChunked` mutates `vault.fileMap`
      // chunk by chunk, so a failure partway leaves entries in the model — and
      // everything that later repairs a restored entry is gated on this set:
      // the post-connect re-index of notes with no metadata, and the stat
      // zeroing that is the ONLY thing correcting a restored stat on an SFTP
      // session. Assigning it afterwards meant a partial restore left stale
      // entries that nothing would ever reconcile.
      this.snapshotFiles = new Set(entries.filter((e) => !e.isDirectory).map((e) => e.path));
      // Chunked, not `build()`: this runs inside `onload`, which Obsidian
      // awaits before it loads the vault, and a one-tick insert of tens of
      // thousands of entries — each firing `vault.trigger('create')` — freezes
      // the window for as long as it takes.
      const result = await new VaultModelBuilder(this.app.vault, { TFile, TFolder })
        .buildChunked(entries);
      logger.info(
        `TreeSnapshot: restored ${result.filesAdded}f + ${result.foldersAdded}d ` +
        `before metadataCache.initialize (${Date.now() - start}ms` +
        `${dropped > 0 ? `, ${dropped} entries dropped by current ignore/allow settings` : ''})`,
      );
    } catch (e) {
      // Never stop the plugin loading over a snapshot. What the vault holds
      // afterwards depends on where this threw: nothing yet (the file was
      // unreadable), or the entries some chunks managed to insert. Either is
      // safe — `snapshotFiles` is already set, so the post-connect catch-up
      // covers whatever landed, and the background index reconciles the rest.
      logger.warn(`TreeSnapshot: restore failed (${errorMessage(e)}); continuing without the rest`);
    }
  }

  /**
   * Fire `modify` for restored files that need a real read.
   *
   * Both groups come from one gap: between `onload`, where the snapshot lands
   * in the model, and the adapter patch after layout-ready, the only adapter
   * is Obsidian's native one — pointed at a shadow disk holding no notes.
   *
   *  - No metadata: `metadataCache.initialize()` already tried to read them
   *    through that adapter and failed.
   *  - Open in a tab: the workspace restore loads their content the same way
   *    and the editor shows nothing. These usually DO have metadata, so the
   *    first check skips them and the tab stays blank until reopened by hand.
   */
  private reindexSnapshotFilesWithoutMetadata(): void {
    if (!this.snapshotFiles || this.snapshotMetadataChecked) return;
    this.snapshotMetadataChecked = true;
    const builder = new VaultModelBuilder(this.app.vault, { TFile, TFolder });
    const open = new Set<string>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const file = (leaf.view as { file?: { path?: string } } | undefined)?.file;
      if (file?.path) open.add(file.path);
    });
    let queued = 0;
    let reopened = 0;
    for (const p of this.snapshotFiles) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile) || f.extension !== 'md') continue;
      const needsMetadata = !this.app.metadataCache.getFileCache(f);
      const isOpen = open.has(p);
      if (!needsMetadata && !isOpen) continue;
      if (!builder.modifyOne(p)) continue;
      if (needsMetadata) queued++;
      if (isOpen) reopened++;
    }
    logger.info(
      `TreeSnapshot: ${queued} of ${this.snapshotFiles.size} restored files queued for re-index, ` +
      `${reopened} open tab(s) refreshed`,
    );
  }

  /**
   * A background pass finished. After a daemon walk the model matches the
   * remote with real mtime/size, so it becomes next launch's snapshot. After
   * the SFTP fallback it can't: its stats are 0, and a snapshot restored at
   * startup would carry a daemon session's stats, which metadataCache would
   * trust as "unchanged". Zero those so every restored note is re-read, and
   * drop the snapshot.
   */
  private onIndexComplete(indexer: BackgroundIndexer, r: IndexComplete): void {
    if (this.backgroundIndexer !== indexer) return;
    const firstPass = !this.vaultIndexed;
    this.vaultIndexed = true;
    // Only a pass that reconciled the whole remote settles what was missed.
    if (r.complete) this.missedEvents = false;
    // Eager mode never reads a snapshot (see snapshotProfile).
    if (this.settings.lazyFolderLoad === false) return;
    const profile = this.conn.activeProfile;
    if (!profile) return;
    const file = this.treeSnapshotFile(profile.id);
    if (r.viaFastPath) {
      // Restored stats are reconciled now; a later fallback pass (a reconnect
      // that came back on SFTP) must not zero them.
      this.snapshotFiles = null;
      try {
        const entries = this.modelEntries();
        writeTreeSnapshot(file, profile.remotePath, entries);
        logger.info(`TreeSnapshot: saved ${entries.length} entries`);
      } catch (e) {
        logger.warn(`TreeSnapshot: save failed (${errorMessage(e)})`);
      }
      return;
    }
    // A later fallback pass (a reconnect that came back on SFTP) leaves the
    // snapshot an earlier pass of this session saved alone.
    if (!firstPass) return;
    if (this.snapshotFiles) {
      const builder = new VaultModelBuilder(this.app.vault, { TFile, TFolder });
      for (const p of this.snapshotFiles) builder.modifyOne(p, { ctime: 0, mtime: 0, size: 0 });
      this.snapshotFiles = null;
    }
    deleteTreeSnapshot(file);
  }

  /**
   * Reconcile the model with a fresh walk: fs.watch only reaches live
   * subscribers, so remote changes made while disconnected never arrived.
   * Not after the replay, which can sit on a conflict modal: the walk's skip
   * filter already leaves queued edits alone.
   */
  private catchUpAfterReconnect(): void {
    // The drop cancelled any index still running; restart it if this
    // session's lazy index never finished, and announce it when it does.
    const unfinished = this.settings.lazyFolderLoad !== false && !this.vaultIndexed;
    // Otherwise only a session with a live watch missed anything.
    if (!unfinished && !this.missedEvents) return;
    this.startBackgroundIndex({ announce: unfinished ? 'always' : 'never' });
  }

  /**
   * Complete the vault model behind the lazy root-level populate.
   *
   * Fire-and-forget: connect returns at once and the indexer trickles the rest
   * of the tree in, yielding to the renderer between units. Any previous pass
   * is cancelled first, so a stale one cannot write progress over the new one.
   */
  private startBackgroundIndex({ announce = 'if-added' }: { announce?: Announce } = {}): void {
    // A drop can land while populate is still running: the reconnect's
    // catch-up starts the pass instead, with a filter that sees the outage.
    if (this.state !== SyncState.CONNECTED) return;
    this.backgroundIndexer?.cancel();
    const indexer: BackgroundIndexer = new BackgroundIndexer({
      makeWalker: () => this.makeWalker(),
      makeBuilder: () => new VaultModelBuilder(this.app.vault, { TFile, TFolder }),
      // Folders the indexer has fully materialised don't need re-walking when the
      // user later expands them in File Explorer.
      markLoaded: (path) => this.lazyLoader?.markLoaded(path),
      onProgress: (p) => this.onIndexProgress(indexer, p, announce),
      // Reconcile, not just fill in: the model may hold snapshot entries the
      // remote has changed or dropped since last session.
      modelAtStart: () => this.modelEntries(),
      currentStat: (path) => {
        const f = this.app.vault.getAbstractFileByPath(path);
        return f instanceof TFile ? f.stat : null;
      },
      // Queued offline edits: the model is ahead of the remote there.
      ...this.adapterMgr.pendingOfflineFilter(),
      onComplete: (r) => this.onIndexComplete(indexer, r),
    });
    this.backgroundIndexer = indexer;
    void indexer.start();
  }

  /**
   * Say so while it runs: until the pass completes, search, graph and
   * backlinks really ARE incomplete, and a vault holding 12 of 30,000 files
   * should not look ready.
   *
   * Status-bar text while running, one Notice at the end, nothing at all when
   * cancelled — the user disconnected and needs no report.
   */
  private onIndexProgress(indexer: BackgroundIndexer, p: IndexProgress, announce: Announce): void {
    // A pass superseded by a reconnect, or one still unwinding after disconnect,
    // must not paint over the live session's status bar.
    if (this.backgroundIndexer !== indexer) return;
    if (this.state !== SyncState.CONNECTED) return;
    if (!p.done) {
      if (announce !== 'never') {
        this.statusBar?.update(SyncState.CONNECTED, `Remote SSH: Indexing… ${p.files} files`);
      }
      return;
    }
    this.statusBar?.update(SyncState.CONNECTED);
    if (p.cancelled || p.failed || announce === 'never') return;
    // Nothing added means the connect populate had already registered the whole
    // vault (a flat, root-only tree) — there was no gap, so there's nothing to
    // announce. Announcing "0 files indexed" would be noise on every connect.
    if (announce === 'if-added' && p.files + p.folders === 0) return;
    // The vault's totals: a restarted pass adds only what the dropped one missed.
    const entries = this.modelEntries();
    const files = entries.filter((e) => !e.isDirectory).length;
    new Notice(
      `Remote SSH: vault index complete — ${files} files, ${entries.length - files} folders. ` +
      'Search, graph and links now cover the whole vault.',
    );
  }

  /** A fresh BulkWalker bound to the current session's transport + ignore list. */
  private makeWalker(): BulkWalker {
    return new BulkWalker({
      adapter: this.app.vault.adapter,
      rpcConnection: this.conn.rpcConnection ?? undefined,
      // Older profiles have no walkIgnoreDirs → fall back to the sensible
      // defaults so existing users immediately benefit. An explicit empty
      // array (user cleared it) means "ignore nothing" and is respected.
      ignoreDirs: this.conn.activeProfile?.walkIgnoreDirs ?? [...DEFAULT_WALK_IGNORE_DIRS],
      allowedHiddenDirs: this.conn.activeProfile?.allowedHiddenDirs,
      configDir: this.app.vault.configDir,
    });
  }

  /**
   * One delegated, capture-phase click listener that deepens a folder the
   * first time it's expanded in File Explorer. Obsidian renders folder
   * children from the in-memory model, does NOT re-list on expand, and exposes
   * no public folder-expand event — hence the DOM hook on `.nav-folder-title`
   * (which carries the folder's `data-path`; verified in a real-Obsidian
   * spike). Idempotent per folder via LazyFolderLoader, so a click on an
   * already-loaded folder (or a collapse) is a cheap no-op. Installed once;
   * `registerDomEvent` tears it down on unload.
   */
  private installLazyExpandHook(): void {
    if (this.lazyExpandHookInstalled) return;
    this.lazyExpandHookInstalled = true;
    this.registerDomEvent(activeDocument, 'click', (evt) => {
      const title = (evt.target as HTMLElement | null)?.closest?.('.nav-folder-title');
      const path = title?.getAttribute('data-path');
      if (path == null) return;
      void this.lazyLoader?.loadFolder(path);
    }, { capture: true });
  }

  /**
   * Walk the patched adapter and build the model so File Explorer renders the
   * remote tree. Public so the debug command and auto-connect share one path.
   *
   * Per-file stat is skipped: every entry lands with zero ctime/mtime/size and
   * faults in real values on access.
   *
   * Returns a short summary for a Notice; full counts and the first five
   * errors go to the log.
   */
  async populateVaultFromRemote(label: string = 'remote'): Promise<string> {
    const start = Date.now();
    // A new session: what an earlier one indexed or missed is moot.
    this.vaultIndexed = false;
    this.missedEvents = false;
    this.reindexSnapshotFilesWithoutMetadata();

    // Phase E1-α.2: prefer the daemon's `fs.walk` (one RPC, real
    // mtime+size per entry) when the active session is RPC AND the
    // daemon advertises the capability. Otherwise BulkWalker
    // transparently runs the legacy BFS via the patched adapter.
    const walker = this.makeWalker();
    // Lazy mode (default): walk only the ROOT level and deepen each folder on
    // first expand, so a deep, dir-heavy vault doesn't pull + materialise tens
    // of thousands of entries at connect. `walkIgnoreDirs` is applied per level
    // either way. Set `lazyFolderLoad: false` to restore the full eager walk.
    const lazy = this.settings.lazyFolderLoad !== false;
    const walk = await walker.walk('', !lazy);
    logger.info(
      `populateVaultFromRemote(${label}): ${walk.source}, ${walk.entries.length} entries ` +
      `(${walk.hiddenCount} hidden) in ${walk.walkMs}ms (pages=${walk.pages})${lazy ? ' [lazy: root level]' : ''}` +
      (walk.fastPathError ? ` (fast-path fallback: ${walk.fastPathError})` : ''),
    );

    const builder = new VaultModelBuilder(this.app.vault, { TFile, TFolder });
    // Chunked so even one level (or a full eager walk) fills the File Explorer
    // progressively instead of freezing the window while every entry is
    // materialised + `create`-triggered in a single JS tick.
    const result = await builder.buildChunked(walk.entries);
    const totalMs = Date.now() - start;

    if (lazy) {
      // Obsidian renders folders from the in-memory model and does NOT re-list
      // on expand, so deepen-on-expand is driven by a File-Explorer click hook.
      this.lazyLoader = new LazyFolderLoader(
        () => this.makeWalker(),
        () => new VaultModelBuilder(this.app.vault, { TFile, TFolder }),
      );
      this.lazyLoader.markLoaded('');
      this.installLazyExpandHook();
      // The root level is on screen and connect is done — now index the REST of
      // the tree in the background. Without this, everything below depth 1 stays
      // out of `vault.fileMap` until the user happens to click the folder open,
      // and Obsidian resolves links/embeds/search only against `fileMap` — so a
      // link into an unexpanded subfolder silently fails to resolve. Deliberately
      // NOT awaited: connect must stay fast, and the indexer yields between units.
      // A reconnect that recovered mid-populate may already have started one.
      if (!this.backgroundIndexer?.isRunning) this.startBackgroundIndex();
    }
    // `lazyFolderLoad: false` needs no background pass — the walk above was
    // already the full recursive tree, so `fileMap` is complete on return.

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
        walk.hiddenCount > 0
          ? `Remote SSH: 0 visible files — all ${walk.hiddenCount} walked ` +
            'entries are hidden or excluded. Check the profile’s Allowed hidden ' +
            'directories and Ignore directories settings.'
          : 'Remote SSH: 0 files found on the remote. Check the profile’s ' +
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
   * Bootstrap the shadow vault for `profile` and open it in a new Obsidian
   * window via `obsidian://open`.
   *
   * No SSH needed: this is local-disk work, and the connect happens inside
   * the shadow window afterwards.
   */
  async openShadowVaultFor(profile: SshProfile): Promise<void> {
    // Connect clicked from INSIDE the shadow window for this same
    // profile (Settings row button / connect modal). This vault IS the
    // shadow — there is no second window to spawn, and re-running the
    // bootstrap from here would make installPlugin's rm+symlink cycle
    // target its own files (src == dst), turning main.js/manifest.json
    // into self-referential symlinks that brick the install on the
    // next start. Reconnect in place instead.
    if (this.settings.autoConnectProfileId === profile.id) {
      await this.runAutoConnect('reconnect');
      return;
    }

    // Source dir: where this running plugin lives, so the shadow
    // vault's plugin install symlinks the same bundle.
    const sourcePluginDir = this.pluginDir();
    if (!sourcePluginDir) {
      new Notice('Remote SSH: vault is not file-system-backed; cannot locate plugin source');
      return;
    }

    // The spawned window can take several seconds to surface while
    // Obsidian keeps THIS (source) window focused. Without this guard
    // an impatient re-click re-bootstraps + re-fires obsidian://open,
    // and the user just sees more churn — never the new window.
    if (this.shadowSpawnInFlight) {
      new Notice('Remote SSH: the remote vault is still opening — give it a moment');
      return;
    }
    this.shadowSpawnInFlight = true;

    // Shadow vaults live under ~/.obsidian-remote/vaults/ on every OS,
    // alongside ~/.obsidian-remote/state/ (never-synced per-device state).
    const registry = new ObsidianRegistry(ObsidianRegistry.defaultConfigPath());
    const bootstrap = new ShadowVaultBootstrap(
      shadowVaultsDir(), sourcePluginDir, registry, shadowStateRoot(),
    );
    const spawner = new WindowSpawner();
    const manager = new ShadowVaultManager(bootstrap, spawner);

    try {
      // #399: a password typed in ConnectModal lives only in memory until a
      // save, so flush it to the SOURCE data.json before the bootstrap reads
      // it — otherwise the shadow is seeded with empty secrets and its
      // auto-connect dies with "No password stored for profile", opening an
      // empty vault. Harmless and idempotent when nothing was typed.
      //
      // A save failure must not abort the spawn: the shadow may still connect
      // from previously-persisted secrets.
      try {
        await this.saveSettings();
      } catch (e) {
        logger.warn(`openShadowVaultFor: pre-spawn settings flush failed (${errorMessage(e)}); continuing to spawn`);
      }

      const result = await manager.openShadowFor(
        profile, this.settings.profiles,
        // #429b / Phase B-3: pull canonical .obsidian/ before the window
        // boots. Best-effort + time-boxed inside preSpawnPull; the manager
        // swallows any throw so a slow/failed pull never blocks the spawn.
        (r) => this.preSpawnPull(profile, r),
      );
      const how = result.pluginInstallMethod;
      const reg = result.registryCreated ? 'newly registered' : result.migrated ? 'migrated' : 'reused';
      logger.info(
        `openShadowVaultFor: profile=${profile.name}, vault=${result.layout.vaultDir}, ` +
        `registry id=${result.registryId} (${reg}), plugin=${how}`,
      );
      if (result.registryCreated || result.migrated) {
        // The vault's path in obsidian.json is new to the already-running
        // Obsidian (it only reads that file at startup), so the
        // obsidian://open we just fired is a no-op and no window appears.
        // This happens on a profile's first-ever open (registryCreated) and
        // the one-time legacy→friendly dir rename (migrated). Surface a
        // PERSISTENT notice (duration 0) telling the user to restart, rather
        // than the misleading "opened in new window" that never opened.
        const why = result.registryCreated
          ? `"${profile.name}" is a newly registered vault.`
          : `"${profile.name}" was renamed to a friendlier vault name.`;
        new Notice(
          `Remote SSH: ${why} Obsidian only loads vaults at startup, so it cannot ` +
          'open it this session — fully quit and reopen Obsidian, then click Connect ' +
          'again. (One-time.)',
          0,
        );
      } else {
        new Notice(`Remote SSH: opened ${profile.name} in new window (${how})`);
      }
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
   * Pull the remote `.obsidian/` into the fresh shadow dir before the window
   * opens, so it boots on the canonical remote config rather than a stale
   * local copy and never reloads settings mid-session (#429b).
   *
   * Best-effort and time-boxed. The `SftpClient` here is standalone and never
   * patches the SOURCE window's adapter, so the user's real vault is not
   * hijacked. The kbd-interactive and host-key callbacks REJECT rather than
   * prompt: a 2FA or unknown-host connect falls through to the shadow window,
   * which asks exactly once — no double prompt, no modal in the wrong window.
   *
   * Any error or timeout just logs and returns; the shadow window's own
   * connect catches up. Never throws.
   */
  private async preSpawnPull(profile: SshProfile, result: BootstrapResult): Promise<void> {
    const localConfigDir = result.layout.configDir;
    const remoteConfigDir = this.app.vault.configDir; // ".obsidian"
    const remoteBase = normalizeRemotePath(profile.remotePath);
    // The same redirect the shadow window's adapter will use, so the
    // per-device config files are pulled from THIS client's subtree and not
    // the dead shared path. Without it, pre-spawn clobbered the per-device
    // config on every spawn. Non-private paths map to themselves, so the
    // plugin list and binaries still round-trip shared.
    const mapper = new PathMapper(ConnectionManager.resolveClientId(this.settings), remoteConfigDir);
    const toRemote = (p: string): string => preSpawnRemotePath(mapper, remoteBase, p);

    const client = new SftpClient(
      this.authResolver,
      this.hostKeyStore,
      () => Promise.reject(new Error('pre-spawn: keyboard-interactive deferred to shadow window')),
      () => Promise.reject(new Error('pre-spawn: host-key prompt deferred to shadow window')),
    );
    const reader: SharedConfigReader = {
      exists: (p) => client.exists(toRemote(p)),
      read: (p) => client.readText(toRemote(p)),
    };
    // Bound the whole connect+pull so a slow link can't stall the window
    // open — beyond the budget we fall back to spawn-and-catch-up.
    const budgetMs = (profile.connectTimeoutMs || 15_000) + 8_000;
    // Run as a standalone promise: if the budget fires first, `finally`
    // disconnects the client and any read still in flight then throws
    // "not connected". That settles `pull` a SECOND time, after the race
    // already lost — an unhandledrejection in the renderer unless we keep
    // a handler on it. The real-error diagnostics still flow through the
    // `withTimeout` race into the catch below; this handler only mops up
    // the expected post-disconnect noise.
    const pull = (async () => {
      await client.connect(profile);
      await pullSharedObsidianConfig(reader, remoteConfigDir, localConfigDir);
      // The same base the shadow window will use, so a removal made elsewhere
      // is applied here too. The pull never writes the base, so it cannot
      // make the later push read this device's additions as remote removals,
      // and re-merging over one base is idempotent.
      await pullCommunityPlugins(
        reader, remoteConfigDir, localConfigDir,
        communityPluginsBasePath(shadowStateRoot(), profile.id),
      );
      const enabledIds = readEnabledPluginIds(localConfigDir);
      await pullPluginBinaries(reader, remoteConfigDir, localConfigDir, enabledIds);
    })();
    pull.catch(() => { /* post-timeout teardown error — handled via the race */ });
    try {
      await withTimeout(pull, budgetMs, 'pre-spawn pull');
      logger.info(`preSpawnPull: staged canonical .obsidian/ before spawn (${profile.name})`);
    } catch (e) {
      logger.warn(`preSpawnPull: skipped (${errorMessage(e)}); shadow window will sync after open`);
    } finally {
      try { await client.disconnect(); } catch { /* best effort */ }
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
   * Debug command: deploy the daemon over the live SFTP session, open a
   * unix-socket Duplex through the same SSH connection, authenticate, and
   * smoke-list the vault root. Every step logs, so the daemon and the plugin
   * can be followed together.
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
   * Absolute path to THIS running plugin's folder
   * (`<vault>/.obsidian/plugins/<id>`), or `null` when the vault isn't
   * file-system-backed. Single source for the call sites that need it
   * (shadow-vault plugin source, dev binary, daemon binary cache).
   */
  private pluginDir(): string | null {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    return path.join(adapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id);
  }

  /**
   * Resolve the staged Linux/amd64 daemon binary that lives next to
   * `main.js` in the plugin's vault folder — the dev-build path (`npm run
   * build:server` populates it). Returns the absolute path or `null` if
   * absent; `ensureDaemonBinary` then downloads the matching per-arch
   * binary at connect time.
   */
  private locateDaemonBinary(): string | null {
    const pluginDir = this.pluginDir();
    if (!pluginDir) return null;
    const serverBin = path.join(pluginDir, 'server-bin');
    // Only treat a staged binary as a genuine DEV build when dev-install
    // marked it (`.dev-daemon`). Without this, a *downloaded* binary at the
    // same filename would masquerade as a dev build and bypass the version /
    // sha refresh in ensureDaemonBinary — the exact reason a plugin upgrade
    // kept re-deploying a stale (dynamically-linked) daemon.
    if (!fs.existsSync(path.join(serverBin, '.dev-daemon'))) return null;
    const candidate = path.join(serverBin, 'obsidian-remote-server-linux-amd64');
    return fs.existsSync(candidate) ? candidate : null;
  }



  /**
   * Acquire a daemon binary for the remote's os/arch. The logic lives in
   * `transport/ensureDaemonBinary` so it can be tested without building a
   * plugin, and so its coverage is visible.
   */
  private ensureDaemonBinary(client: SftpClient): Promise<string | null> {
    return ensureRemoteDaemonBinary(client, {
      pluginDir: () => this.pluginDir(),
      pluginVersion: this.manifest.version,
      settings: this.settings,
      saveSettings: () => this.saveSettings(),
      confirmDownload: (v) => this.confirmDaemonDownload(v),
    });
  }

  /** One-time consent dialog for the daemon auto-download. */
  private confirmDaemonDownload(version: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText('Download remote daemon?');
      modal.contentEl.createEl('p', {
        text:
          `Remote SSH can download a small helper daemon (release ${version}) from ` +
          'this plugin’s GitHub release. It is uploaded to your SSH host and ' +
          'verified by sha256, and enables faster directory listing, live file ' +
          'watch, and image/PDF previews. Decline to stay on plain SFTP (these ' +
          'extras are then off).',
      });
      let decided = false;
      const buttons = modal.contentEl.createDiv({ cls: 'modal-button-container' });
      const ok = buttons.createEl('button', { text: 'Download', cls: 'mod-cta' });
      ok.addEventListener('click', () => { decided = true; resolve(true); modal.close(); });
      const no = buttons.createEl('button', { text: 'Use SFTP' });
      no.addEventListener('click', () => { decided = true; resolve(false); modal.close(); });
      modal.onClose = () => { if (!decided) resolve(false); };
      modal.open();
    });
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

