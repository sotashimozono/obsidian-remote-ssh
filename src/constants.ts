import type { PluginSettings, SshProfile } from './types';

export const PLUGIN_ID = 'remote-ssh';

export const DEFAULT_PROFILE: Omit<SshProfile, 'id' | 'name'> = {
  host: '',
  port: 22,
  username: '',
  authMethod: 'privateKey',
  remotePath: '',
  localCachePath: '',
  connectTimeoutMs: 15000,
  keepaliveIntervalMs: 10000,
  keepaliveCountMax: 3,
  uploadOnSave: true,
  autoSync: false,
  pollIntervalSec: 30,
  followSymlinks: false,
  ignorePatterns: ['.git', '*.tmp', '.DS_Store', 'Thumbs.db'],
  conflictResolution: 'ask',
};

export const DEFAULT_SETTINGS: PluginSettings = {
  profiles: [],
  activeProfileId: null,
  licenseKey: '',
  enableDebugLog: false,
  maxLogLines: 500,
};

export const FREE_MAX_PROFILES = 1;
export const FREE_POLL_INTERVAL_SEC = 30;
export const PRO_POLL_INTERVAL_MIN_SEC = 10;

export const TRANSFER_CONCURRENCY = 3;
export const UPLOAD_PRIORITY = 10;
export const DOWNLOAD_PRIORITY = 1;
export const MAX_RETRY = 4;
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30000;

export const TMP_SUFFIX = '.rsh_tmp';
export const INDEX_FILE_SUFFIX = 'index.json';
