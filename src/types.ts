export type AuthMethod = 'password' | 'privateKey' | 'agent';

export type ConflictResolution = 'ask' | 'keepLocal' | 'keepRemote';

export type ConflictDecision = 'keepLocal' | 'keepRemote' | 'keepBoth';

export type Tier = 'free' | 'pro';

export enum SyncState {
  IDLE          = 'idle',
  CONNECTING    = 'connecting',
  INITIAL_PULL  = 'initial_pull',
  WATCHING      = 'watching',
  SYNCING       = 'syncing',
  CONFLICTED    = 'conflicted',
  DISCONNECTING = 'disconnecting',
  ERROR         = 'error',
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
  localCachePath: string;
  connectTimeoutMs: number;
  keepaliveIntervalMs: number;
  keepaliveCountMax: number;
  uploadOnSave: boolean;
  autoSync: boolean;
  pollIntervalSec: number;
  followSymlinks: boolean;
  ignorePatterns: string[];
  conflictResolution: ConflictResolution;
  hostKeyFingerprint?: string;
  jumpHost?: JumpHostConfig;
}

export interface PluginSettings {
  profiles: SshProfile[];
  activeProfileId: string | null;
  licenseKey: string;
  enableDebugLog: boolean;
  maxLogLines: number;
}

export interface FileEntry {
  relativePath: string;
  mtime: number;
  size: number;
  isDirectory: boolean;
}

export interface ChangeSet {
  toDownload: FileEntry[];
  toUpload: string[];
  toDeleteLocal: string[];
  conflicts: ConflictEntry[];
}

export interface ConflictEntry {
  relativePath: string;
  localMtime: number;
  remoteMtime: number;
  localSize: number;
  remoteSize: number;
}

export interface TransferJob {
  direction: 'upload' | 'download';
  relativePath: string;
  localAbsPath: string;
  remoteAbsPath: string;
  priority: number;
  retryCount: number;
}

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  timestamp: number;
  message: string;
}
