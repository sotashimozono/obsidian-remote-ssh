import { SftpClient } from './ssh/SftpClient';
import type { SshProfile } from './types';
import type { RemoteFsClient } from './adapter/RemoteFsClient';
import { RpcRemoteFsClient } from './adapter/RpcRemoteFsClient';
import { SftpRemoteFsClient } from './adapter/SftpRemoteFsClient';
import { ReconnectManager } from './transport/ReconnectManager';
import type { ReconnectState } from './transport/ReconnectManager';
import { DEFAULT_BACKOFF } from './transport/Backoff';
import { ServerDeployer, resolveRemotePath } from './transport/ServerDeployer';
import { tryReuseExistingDaemon } from './transport/DaemonProbe';
import { establishRpcConnection } from './transport/RpcConnection';
import { normalizeRemotePath } from './util/pathUtils';
import { logger } from './util/logger';
import { errorMessage } from './util/errorMessage';
import { sanitizeClientId, defaultClientId, defaultUserName } from './path/PathMapper';

export type RpcConnectionHandle = Awaited<ReturnType<typeof establishRpcConnection>>;

export interface ConnectionDeps {
  locateDaemonBinary: () => string | null;
}

/**
 * Hooks the reconnect attempt calls after re-establishing the transport
 * so the plugin can rebind the adapter and fs-change listener.
 */
export interface ReconnectAdapterHooks {
  swapClient(newClient: RemoteFsClient): void;
  prepareListenerForReconnect(): void;
  resumeListenerAfterReconnect(rpcConn: RpcConnectionHandle): Promise<void>;
}

/**
 * Owns the SSH / RPC transport lifecycle: connect, deploy daemon,
 * handshake, disconnect, and the reconnect loop.
 *
 * Adapter patching, vault population, and Obsidian UI remain in the
 * plugin class — ConnectionManager talks back to them via callbacks.
 */
export class ConnectionManager {
  activeProfile: SshProfile | null = null;
  activeRemoteBasePath: string | null = null;
  rpcConnection: RpcConnectionHandle | null = null;
  daemonDeployer: ServerDeployer | null = null;
  reconnectManager: ReconnectManager | null = null;

  constructor(
    readonly client: SftpClient,
    private readonly deps: ConnectionDeps,
  ) {}

  // ─── connect / disconnect ─────────────────────────────────────────

  /** Connect SSH and run a smoke-test `list`. Throws on failure. */
  async connectSsh(profile: SshProfile): Promise<void> {
    const effectivePath = normalizeRemotePath(profile.remotePath);
    if (effectivePath !== profile.remotePath) {
      logger.info(`remotePath normalized: "${profile.remotePath}" → "${effectivePath}"`);
    }
    await this.client.connect(profile);
    const entries = await this.client.list(effectivePath);
    logger.info(`Smoke test: list ${effectivePath} returned ${entries.length} entries`);
    this.activeRemoteBasePath = effectivePath;
    this.activeProfile = profile;
  }

  /**
   * Deploy the daemon binary, open a unix-socket Duplex, and run
   * the `auth` + `server.info` handshake. On success `rpcConnection`
   * and `daemonDeployer` are populated.
   */
  async startRpcSession(profile: SshProfile, effectivePath: string): Promise<void> {
    const localBinaryPath = this.deps.locateDaemonBinary();
    if (!localBinaryPath) {
      throw new Error(
        'daemon binary not staged. Run `npm run build:server` (or `build:full`) and reload the plugin.',
      );
    }

    const remoteBinaryPath = '.obsidian-remote/server';
    const remoteSocketPath = profile.rpcSocketPath?.trim() || '.obsidian-remote/server.sock';
    const remoteTokenPath  = profile.rpcTokenPath?.trim()  || '.obsidian-remote/token';

    const home = await this.client.getRemoteHome();
    const absSocketPath = resolveRemotePath(remoteSocketPath, home);
    const absTokenPath  = resolveRemotePath(remoteTokenPath,  home);
    const reused = await tryReuseExistingDaemon(this.client, absSocketPath, absTokenPath);
    if (reused) {
      this.rpcConnection = reused;
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

  /** Close RPC tunnel, stop daemon, disconnect SSH. */
  async disconnectTransport(): Promise<void> {
    if (this.rpcConnection) {
      try { this.rpcConnection.close(); }
      catch (e) { logger.warn(`rpcConnection.close: ${errorMessage(e)}`); }
      this.rpcConnection = null;
    }
    if (this.daemonDeployer && this.client.isAlive()) {
      try { await this.daemonDeployer.stop(); }
      catch (e) { logger.warn(`daemon stop: ${errorMessage(e)}`); }
    }
    this.daemonDeployer = null;

    if (this.client.isAlive()) {
      try { await this.client.disconnect(); }
      catch (e) { logger.warn(`disconnect: ${errorMessage(e)}`); }
    }
    this.activeProfile = null;
    this.activeRemoteBasePath = null;
  }

  // ─── reconnect ────────────────────────────────────────────────────

  /**
   * Drive the reconnect loop after an unexpected SSH drop.
   * Idempotent: a second call while a loop is active is a no-op.
   */
  async startReconnect(opts: {
    maxRetries: number;
    setAdapterReconnecting: (on: boolean) => void;
    onState: (s: ReconnectState) => void;
    hooks: ReconnectAdapterHooks;
  }): Promise<void> {
    if (this.reconnectManager?.isActive()) return;
    if (!this.activeProfile) {
      logger.warn('startReconnect: no active profile to reconnect with');
      return;
    }
    if (opts.maxRetries <= 0) {
      logger.info('startReconnect: auto-reconnect disabled (reconnectMaxRetries <= 0)');
      return;
    }
    opts.setAdapterReconnecting(true);
    const manager = new ReconnectManager({
      attempt: () => this.reconnectAttempt(opts.hooks),
      onState: opts.onState,
      backoff: { ...DEFAULT_BACKOFF, maxRetries: opts.maxRetries },
    });
    this.reconnectManager = manager;
    await manager.run();
  }

  /**
   * One reconnect pass: re-establish SSH, redeploy RPC if needed,
   * rebind the adapter client, and re-subscribe the fs listener.
   */
  private async reconnectAttempt(hooks: ReconnectAdapterHooks): Promise<void> {
    const profile = this.activeProfile;
    if (!profile) throw new Error('no active profile');

    if (!this.client.isAlive()) {
      await this.client.connect(profile);
    }

    const transport = profile.transport ?? 'sftp';
    if (this.rpcConnection) {
      try { this.rpcConnection.close(); } catch { /* already dead */ }
      this.rpcConnection = null;
    }
    if (transport === 'rpc') {
      const effectivePath = this.activeRemoteBasePath ?? normalizeRemotePath(profile.remotePath);
      await this.startRpcSession(profile, effectivePath);
    }

    hooks.swapClient(this.buildFsClient());

    hooks.prepareListenerForReconnect();
    if (this.rpcConnection) {
      await hooks.resumeListenerAfterReconnect(this.rpcConnection);
    }
  }

  cancelReconnect(): void {
    if (!this.reconnectManager?.isActive()) return;
    this.reconnectManager.cancel();
    this.reconnectManager = null;
  }

  // ─── helpers ──────────────────────────────────────────────────────

  /** Build an appropriate RemoteFsClient for the current transport. */
  buildFsClient(): RemoteFsClient {
    return this.rpcConnection
      ? new RpcRemoteFsClient(this.rpcConnection.rpc)
      : new SftpRemoteFsClient(this.client);
  }

  isAlive(): boolean {
    return this.client.isAlive();
  }

  static resolveClientId(settings: { clientId?: string }): string {
    const override = (settings.clientId ?? '').trim();
    if (override) return sanitizeClientId(override);
    return defaultClientId();
  }

  static formatUserLabel(settings: { clientId?: string; userName?: string }): string {
    const userName = settings.userName?.trim() || defaultUserName();
    const clientId = ConnectionManager.resolveClientId(settings);
    return `${userName}@${clientId}`;
  }
}
