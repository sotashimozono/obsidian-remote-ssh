export type AuthMethod = 'password' | 'privateKey' | 'agent';

/**
 * Wire choice between the legacy direct-SFTP path and the α path
 * (`obsidian-remote-server` daemon over a JSON-RPC tunnel). Default
 * `'sftp'` matches what every existing profile already does; users
 * opt in to `'rpc'` per profile when they want auto-deploy of the
 * daemon at connect time.
 */
export type RemoteTransport = 'sftp' | 'rpc';

export enum SyncState {
  IDLE         = 'idle',
  CONNECTING   = 'connecting',
  CONNECTED    = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR        = 'error',
}

export interface JumpHostConfig {
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath?: string;
  passwordRef?: string;
}

export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  passwordRef?: string;
  privateKeyPath?: string;
  passphraseRef?: string;
  agentSocket?: string;
  remotePath: string;
  connectTimeoutMs: number;
  keepaliveIntervalMs: number;
  keepaliveCountMax: number;
  hostKeyFingerprint?: string;
  jumpHost?: JumpHostConfig;

  /**
   * Picks between the legacy direct-SFTP transport and the α path
   * where the plugin auto-deploys `obsidian-remote-server` on
   * connect and routes filesystem operations through it. Default
   * `'sftp'` for backwards compatibility with existing profiles.
   */
  transport?: RemoteTransport;
  /**
   * α-path daemon socket on the remote host. Default
   * `.obsidian-remote/server.sock` (home-relative).
   */
  rpcSocketPath?: string;
  /**
   * α-path token file written by the daemon at startup. Default
   * `.obsidian-remote/token`.
   */
  rpcTokenPath?: string;
}

export interface PluginSettings {
  profiles: SshProfile[];
  activeProfileId: string | null;
  enableDebugLog: boolean;
  maxLogLines: number;
}

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  timestamp: number;
  message: string;
}

export interface RemoteStat {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  /** Modification time in unix milliseconds. */
  mtime: number;
  size: number;
  mode: number;
}

export interface RemoteEntry {
  /** Basename only (no slashes). */
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  /** Modification time in unix milliseconds. */
  mtime: number;
  size: number;
}
