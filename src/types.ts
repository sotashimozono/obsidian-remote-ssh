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
