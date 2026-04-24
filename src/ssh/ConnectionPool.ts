import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { SshProfile } from '../types';
import { SftpSession } from './SftpSession';
import { AuthResolver } from './AuthResolver';
import { HostKeyStore } from './HostKeyStore';
import { createJumpTunnel } from './JumpHostTunnel';
import type { LicenseGate } from '../license/LicenseGate';
import { logger } from '../util/logger';
import { withRetry } from '../util/retry';

export class ConnectionPool {
  private clients: Map<string, Client> = new Map();
  private sessions: Map<string, SftpSession> = new Map();

  constructor(
    private authResolver: AuthResolver,
    private hostKeyStore: HostKeyStore,
    private gate: LicenseGate,
  ) {}

  async getOrCreate(profile: SshProfile): Promise<SftpSession> {
    const existing = this.sessions.get(profile.id);
    if (existing && existing.isAlive) return existing;

    // Pro gate: jump host requires Pro license
    if (profile.jumpHost) {
      this.gate.requirePro('Jump host');
    }

    logger.info(`Connecting to ${profile.host}:${profile.port} as ${profile.username}`);
    const session = await withRetry(
      () => this.createSession(profile),
      `connect(${profile.name})`,
    );
    this.sessions.set(profile.id, session);
    return session;
  }

  private async createSession(profile: SshProfile): Promise<SftpSession> {
    const client = await this.connectClient(profile);
    const sftp = await this.openSftp(client);
    this.clients.set(profile.id, client);
    return new SftpSession(sftp, client);
  }

  private async connectClient(profile: SshProfile): Promise<Client> {
    // Pro gate: SSH agent requires Pro license
    if (profile.authMethod === 'agent') {
      this.gate.requirePro('SSH agent authentication');
    }

    const authConfig = this.authResolver.buildAuthConfig(profile);

    // Jump host tunnel (Pro): open the channel first, pass as `sock`
    let sock: import('stream').Duplex | undefined;
    if (profile.jumpHost) {
      logger.info(`Opening jump tunnel via ${profile.jumpHost.host}`);
      sock = await createJumpTunnel(
        profile.jumpHost,
        profile.host,
        profile.port,
        this.authResolver,
      );
    }

    return new Promise((resolve, reject) => {
      const client = new Client();

      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error(`Connection timed out after ${profile.connectTimeoutMs}ms`));
      }, profile.connectTimeoutMs);

      client.on('ready', () => {
        clearTimeout(timer);
        logger.info(`SSH connected to ${profile.host}`);
        resolve(client);
      });

      client.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });

      client.on('close', () => {
        this.sessions.delete(profile.id);
        this.clients.delete(profile.id);
        logger.warn(`SSH connection to ${profile.host} closed`);
      });

      const config: ConnectConfig = {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        keepaliveInterval: profile.keepaliveIntervalMs,
        keepaliveCountMax: profile.keepaliveCountMax,
        readyTimeout: profile.connectTimeoutMs,
        hostVerifier: (key: Buffer | string) => {
          const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key as string, 'base64');
          return this.hostKeyStore.verify(profile.host, profile.port, keyBuf);
        },
        ...(sock ? { sock } : {}),
        ...authConfig,
      };

      client.connect(config);
    });
  }

  private openSftp(client: Client): Promise<import('ssh2').SFTPWrapper> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => err ? reject(err) : resolve(sftp));
    });
  }

  destroy(profileId: string) {
    const client = this.clients.get(profileId);
    if (client) { client.end(); this.clients.delete(profileId); }
    this.sessions.delete(profileId);
  }

  destroyAll() {
    for (const id of this.clients.keys()) this.destroy(id);
  }
}
