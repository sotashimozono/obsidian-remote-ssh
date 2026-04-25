import type { PluginSettings, SshProfile } from './types';

export const PLUGIN_ID = 'remote-ssh';

export const DEFAULT_PROFILE: Omit<SshProfile, 'id' | 'name'> = {
  host: '',
  port: 22,
  username: '',
  authMethod: 'privateKey',
  remotePath: '',
  connectTimeoutMs: 15000,
  keepaliveIntervalMs: 10000,
  keepaliveCountMax: 3,
  transport: 'sftp',
};

export const DEFAULT_SETTINGS: PluginSettings = {
  profiles: [],
  activeProfileId: null,
  enableDebugLog: false,
  maxLogLines: 500,
};

export const MAX_RETRY = 4;
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30000;

export const TMP_SUFFIX = '.rsh_tmp';
