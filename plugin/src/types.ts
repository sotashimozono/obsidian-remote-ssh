export type AuthMethod = 'password' | 'privateKey' | 'agent';

export enum SyncState {
  IDLE       = 'idle',
  CONNECTING = 'connecting',
  CONNECTED  = 'connected',
  ERROR      = 'error',
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
   * α-path daemon socket on the remote host
   * (e.g. `~/.obsidian-remote/server.sock`). When unset, the plugin's
   * RPC debug command cannot run and the adapter stays on the direct
   * SFTP path. Auto-populated by the upcoming server auto-deploy
   * phase; for now the user fills it in by hand after starting
   * `obsidian-remote-server` on the remote.
   */
  rpcSocketPath?: string;
  /**
   * Path on the remote host holding the session token the daemon
   * writes at startup (default `~/.obsidian-remote/token`).
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
