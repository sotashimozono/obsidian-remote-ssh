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
  /**
   * Maximum number of reconnect attempts after an unexpected SSH
   * drop. Default 5 (Backoff's DEFAULT_BACKOFF.maxRetries). Set to 0
   * to disable auto-reconnect entirely.
   */
  reconnectMaxRetries: number;
  /**
   * Override for `defaultClientId()` used by PathMapper. Determines
   * the per-client subtree on the remote (`.obsidian/user/<id>/...`).
   * Empty string falls back to a sanitized OS hostname. Changing this
   * after first use leaves the previous subtree on the remote with
   * no automatic migration; the user can manually move files.
   */
  clientId: string;
  /**
   * Display name for this device. Cosmetic in v1 — used to label
   * notices and (eventually) multi-client presence info written
   * alongside this client's private subtree on the remote. Empty
   * string falls back to the OS username.
   */
  userName: string;
  /**
   * When true (default), `connectProfile` automatically patches
   * `app.vault.adapter` after a successful handshake so the user
   * lands on the remote vault without running a separate command —
   * the VSCode Remote-SSH equivalent of "open folder on host". Set
   * to false during plugin development when you want to inspect the
   * pre-patch state or use the Debug commands manually.
   */
  autoPatchAdapter: boolean;
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
