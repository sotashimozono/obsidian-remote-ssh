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
  reconnectMaxRetries: 5,
  clientId: '',
  userName: '',
  // Phase 4 marker for shadow vaults; null on a normal vault. Only
  // `ShadowVaultBootstrap` writes a non-null value.
  autoConnectProfileId: null,
  // #149 terminal pane defaults — readable on a typical screen, holds
  // ~30 screens of scrollback at 24 rows. The View also has fallbacks
  // (`?? 12`, `?? 1000`) so removing these from data.json by hand is
  // safe; these constants are the canonical "user hasn't customised" values.
  terminalFontSize: 12,
  terminalScrollback: 1000,
};

export const MAX_RETRY = 4;
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30000;

export const TMP_SUFFIX = '.rsh_tmp';

/**
 * Fallback filename used by the F17 onboarding wizard when the user
 * triggers ed25519 key generation without supplying a path. Lives
 * next to the user's existing keys under `$HOME/.ssh/`.
 */
export const ONBOARDING_FALLBACK_KEY_FILENAME = 'id_ed25519_obsidian_remote';
