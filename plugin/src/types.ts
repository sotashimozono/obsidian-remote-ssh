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
