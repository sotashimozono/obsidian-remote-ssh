import type { PluginSettings, SshProfile } from './types';

export const PLUGIN_ID = 'remote-ssh';

/**
 * Directory basenames pruned from the remote tree walk by default.
 * VCS, dependency, build, cache and editor-metadata dirs that are
 * never Obsidian content but dominate a real work directory (a
 * git/node_modules-heavy `~/work` can be hundreds of thousands of
 * files of pure noise). Pruning them server-side keeps a large
 * shared remote root usable. `.obsidian` is deliberately NOT here —
 * it is the vault config and must be walked.
 */
export const DEFAULT_WALK_IGNORE_DIRS: readonly string[] = [
  '.git', 'node_modules', '.svn', '.hg',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  'target', 'dist', 'build', '.next', '.nuxt', '.cache', '.gradle',
  '.idea', 'vendor', '.terraform',
  // Language / toolchain caches — often enormous (a populated `.julia`
  // or `.cargo` is 100k+ files of pure noise). Dot-dirs are hidden from
  // the File Explorer anyway (BulkWalker filters them); listing them
  // here ALSO prunes them server-side so the daemon never descends into
  // or transfers them — the perf half of "hide `.julia` by default".
  '.julia', '.cargo', '.rustup', '.npm', '.conda', '.gem',
];

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
  walkIgnoreDirs: [...DEFAULT_WALK_IGNORE_DIRS],
};

export const DEFAULT_SETTINGS: PluginSettings = {
  profiles: [],
  activeProfileId: null,
  enableDebugLog: false,
  maxLogLines: 500,
  reconnectMaxRetries: 5,
  clientId: '',
  userName: '',
  // Deepen the remote tree one folder level at a time on File-Explorer expand,
  // rather than eager-walking the whole (potentially huge, deep) tree at
  // connect. Default on; safe to turn off for small vaults.
  lazyFolderLoad: true,
  // #429 — push writes a plugin (or a subprocess it spawned) makes
  // under `adapter.basePath` up to the remote. On by default: the
  // alternative is the reported bug, where those bytes are silently
  // stranded on the local disk. 32 MB caps a single push.
  localWriteBack: true,
  localWriteBackMaxMB: 32,
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
