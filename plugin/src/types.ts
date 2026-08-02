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
   * OpenSSH `ProxyCommand` line, e.g. `cloudflared access ssh
   * --hostname %h`. When set (and no `jumpHost`), the connection is
   * tunnelled through this subprocess's stdio instead of a direct TCP
   * socket — covers Cloudflare-tunnel / `cloudflared` / `nc`-style
   * reachability. `%h`/`%p`/`%r` are expanded at connect time. Desktop
   * only (`child_process`). See `ProxyCommandTunnel`.
   */
  proxyCommand?: string;

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
  /**
   * Directory names to skip when walking the remote tree into the
   * vault model. A match is by exact basename anywhere in the tree
   * (e.g. `node_modules`, `.git`) — the whole subtree is pruned, so
   * it is never transferred over SSH nor indexed by Obsidian. This is
   * what makes a large shared remote root (e.g. `~/work` with a
   * git/node_modules-heavy work dir) usable at all.
   *
   * When omitted (older profiles), the walk falls back to
   * `DEFAULT_WALK_IGNORE_DIRS`. New profiles are pre-filled with that
   * list via `DEFAULT_PROFILE`.
   */
  walkIgnoreDirs?: string[];
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
   * F17 — first-launch onboarding completion flag. False/undefined by
   * default so the OnboardingModal opens on first plugin load when no
   * profiles exist. The user can also re-open it from the command
   * palette; dismissing the modal flips this to true so it doesn't
   * re-open on every layout-ready.
   */
  onboardingCompleted?: boolean;
  /**
   * F22 — opt-in anonymous telemetry. Default false. When enabled,
   * the Telemetry singleton increments local-only counters keyed by
   * error category and reconnect-state-machine kind. Persisted as a
   * JSONL append-log under the plugin's directory; never transmitted
   * over the network. The user can view, reset, or copy-export the
   * counters from the settings tab.
   */
  telemetryEnabled?: boolean;
  /**
   * Whether the user consented to auto-downloading the daemon binary from
   * the GitHub release. Asked once on the first RPC connect when no binary
   * is staged locally (community-store installs); remembered thereafter.
   */
  daemonDownloadConsented?: boolean;
  /**
   * Plugin version the currently-cached daemon binary was validated for.
   * The connect fast-path reuses the cached binary without hitting GitHub
   * when this equals the running `manifest.version`; a mismatch (or absence)
   * forces a sha re-check against the release manifest, so a plugin upgrade
   * always refreshes a *changed* daemon and never re-downloads an unchanged
   * one. Written after each successful (re)provision.
   */
  daemonBinaryVersion?: string;
  /**
   * sha256 (hex) of the currently-cached daemon binary. The connect fast-path
   * re-hashes the cached file and reuses it only when this still matches — so
   * a binary corrupted/truncated after its verified download is detected
   * (network-free) and re-fetched instead of deployed. Paired with
   * `daemonBinaryVersion`; both are written together after a provision.
   */
  daemonBinarySha?: string;
  /**
   * Load the remote tree ONE folder level at a time (deepen on File-Explorer
   * expand) instead of walking + materialising the whole tree at connect.
   * Default true — essential for large, deep, dir-heavy vaults where the eager
   * build freezes the window. Set false to restore the full eager walk (fine
   * for small vaults; makes search/graph see the whole tree immediately).
   */
  lazyFolderLoad?: boolean;
  /**
   * #429 — carry writes made under the shadow vault's LOCAL root by
   * something other than the vault API (a plugin's raw `fs`, or a
   * subprocess it spawns, joining onto `adapter.basePath`) up to the
   * remote vault. Default true: without it those bytes sit on the local
   * disk forever — invisible to the vault model, to search, and to
   * every other device. Set false to restore the older behaviour where
   * such writes are inert.
   */
  localWriteBack?: boolean;
  /**
   * Largest single file the write-back will push, in MB. Default 32.
   * A bigger file is left where it is and reported once: the write-back
   * exists for notes a plugin produced, not for shipping arbitrary
   * payloads over the SSH session.
   */
  localWriteBackMaxMB?: number;
  /**
   * #149 — terminal pane preferences. All optional; the View applies
   * sensible defaults when missing. `terminalShell` overrides the
   * remote login shell (e.g. `/usr/bin/zsh -l`); blank/missing means
   * use the remote user's $SHELL. `terminalFontSize` is xterm.js's
   * `fontSize` option (px). `terminalScrollback` is the in-memory
   * line buffer size; only applies for the lifetime of the View
   * (not persisted across re-opens, per v1 scope).
   */
  terminalShell?: string;
  terminalFontSize?: number;
  terminalScrollback?: number;
  /**
   * Shadow-vault marker (Phase 4). When set, the plugin's
   * `onLayoutReady` callback finds the matching profile and
   * automatically connects to it, then runs `VaultModelBuilder` to
   * populate the (empty) shadow vault from the remote tree. This
   * field is written to the shadow vault's `data.json` by
   * `ShadowVaultBootstrap`; it should NOT be set on a regular
   * (non-shadow) vault. Persistent: surviving across plugin
   * reloads, so closing/reopening the shadow window picks up the
   * connection again.
   */
  autoConnectProfileId?: string | null;
  /**
   * Snapshot of which community plugins were enabled in the source
   * vault at the moment this shadow vault was bootstrapped, plus
   * each plugin's source-side `data.json` content. Set by
   * `ShadowVaultBootstrap` on first bootstrap only.
   *
   * Read by the shadow window's `onLayoutReady` to surface a
   * confirmation modal — the user picks which (if any) to install
   * from Obsidian's community marketplace, and optionally to seed
   * each installed plugin's `data.json` from the source snapshot
   * captured here.
   *
   * Cleared once the user makes a decision (install some / skip
   * all). Stays set if they pick "Ask later" so the modal returns
   * on the next shadow-window reload.
   */
  pendingPluginSuggestions?: PendingPluginSuggestion[];
}

export interface PendingPluginSuggestion {
  /** Community plugin id (e.g. `dataview`, `templater-obsidian`). */
  id: string;
  /**
   * Whatever was in the source vault's
   * `.obsidian/plugins/<id>/data.json` at bootstrap time. `null` if
   * the source had no data.json for this plugin (= default
   * settings). Inlined here so the shadow window can offer
   * "inherit local config" without re-reading the source disk
   * later.
   */
  sourceData: unknown;
}

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  timestamp: number;
  message: string;
  /**
   * Optional structured context attached to the line — passed to
   * `logger.info(msg, fields)` etc. and serialised into the JSONL
   * file sink as `{"fields": {...}}`. Phase D-β addition (F20).
   * Keys whose name suggests a credential are redacted before
   * the line is recorded; see `util/redact.ts`.
   */
  fields?: Record<string, unknown>;
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
