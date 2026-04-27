import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../util/logger';
import type { SshProfile } from '../types';
import type { ObsidianRegistry } from './ObsidianRegistry';

/**
 * Where the shadow vault for a given profile lives on disk.
 */
export interface ShadowVaultLayout {
  /** Absolute path to the shadow vault root (what Obsidian opens). */
  vaultDir: string;
  /** Absolute path to `<vaultDir>/.obsidian/`. */
  configDir: string;
  /** Absolute path to `<vaultDir>/.obsidian/plugins/remote-ssh/`. */
  pluginDir: string;
  /** Absolute path to the plugin's data.json under `pluginDir`. */
  pluginDataFile: string;
}

export interface BootstrapResult {
  layout: ShadowVaultLayout;
  /** Vault id Obsidian assigned in obsidian.json. */
  registryId: string;
  /** True if the vault entry was newly added (false = was already registered). */
  registryCreated: boolean;
  /** How the plugin source landed in the shadow vault. */
  pluginInstallMethod: 'symlink' | 'copy';
}

/**
 * Materialises the on-disk shadow vault for a profile so a separate
 * Obsidian window can open it as if it were any other local vault.
 *
 * Layout:
 *
 *   <baseDir>/<sanitised-profile-id>/
 *   ├── .obsidian/
 *   │   ├── community-plugins.json    ← ["remote-ssh"]
 *   │   └── plugins/
 *   │       └── remote-ssh/           ← symlink (or copy on Windows
 *   │           ├── main.js              without symlink perms) of the
 *   │           ├── manifest.json        running plugin's source dir
 *   │           ├── styles.css
 *   │           └── data.json         ← profile data + autoConnectProfileId
 *   └── (no other files — Obsidian fills the rest on first open)
 *
 * Idempotent: re-running for the same profile refreshes the plugin
 * install (so dev iterations land immediately) and rewrites data.json
 * but never touches files Obsidian itself created (workspace.json,
 * app.json, etc.).
 */
export class ShadowVaultBootstrap {
  constructor(
    /** Directory under which all shadow vaults live (e.g. `~/.obsidian-remote/vaults/`). */
    private readonly baseDir: string,
    /** Absolute path to THIS running plugin's directory (source for symlink/copy). */
    private readonly sourcePluginDir: string,
    private readonly registry: ObsidianRegistry,
  ) {}

  async bootstrap(profile: SshProfile, allProfiles: ReadonlyArray<SshProfile>): Promise<BootstrapResult> {
    const layout = this.layoutFor(profile.id);

    fs.mkdirSync(layout.vaultDir, { recursive: true });
    fs.mkdirSync(layout.configDir, { recursive: true });

    // Tell Obsidian to enable our plugin in the shadow vault.
    const communityPluginsPath = path.join(layout.configDir, 'community-plugins.json');
    fs.writeFileSync(communityPluginsPath, JSON.stringify(['remote-ssh']) + '\n', 'utf-8');

    // Install plugin source (symlink preferred so dev iterations
    // appear immediately; copy as a Windows fallback).
    const pluginInstallMethod = this.installPlugin(layout.pluginDir);

    // data.json: full profile config + the auto-connect marker the
    // shadow window's plugin onload will read in Phase 4.
    const data = {
      profiles: allProfiles,
      activeProfileId: profile.id,
      autoConnectProfileId: profile.id,
    };
    fs.writeFileSync(layout.pluginDataFile, JSON.stringify(data, null, 2) + '\n', 'utf-8');

    const { id: registryId, created } = this.registry.register(layout.vaultDir);

    logger.info(
      `ShadowVaultBootstrap: ${created ? 'registered' : 'reused'} shadow vault for ${profile.name} ` +
      `at ${layout.vaultDir} (registry id=${registryId}, plugin=${pluginInstallMethod})`,
    );

    return { layout, registryId, registryCreated: created, pluginInstallMethod };
  }

  /**
   * Compute paths for a given profile id without doing any I/O.
   * Useful for callers that need the layout up-front (e.g. the
   * spawner needs `vaultDir` for the open URL).
   */
  layoutFor(profileId: string): ShadowVaultLayout {
    const vaultDir = path.join(this.baseDir, sanitiseProfileId(profileId));
    const configDir = path.join(vaultDir, '.obsidian');
    const pluginDir = path.join(configDir, 'plugins', 'remote-ssh');
    const pluginDataFile = path.join(pluginDir, 'data.json');
    return { vaultDir, configDir, pluginDir, pluginDataFile };
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private installPlugin(pluginDir: string): 'symlink' | 'copy' {
    fs.mkdirSync(path.dirname(pluginDir), { recursive: true });

    // Remove any prior install at this path so symlink/copy starts clean.
    try {
      const stat = fs.lstatSync(pluginDir);
      if (stat.isSymbolicLink() || stat.isDirectory() || stat.isFile()) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      }
    } catch {
      // Doesn't exist, nothing to clean up.
    }

    // Try symlink first. On Windows, 'junction' works without admin
    // privileges for directories under the user's control.
    try {
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(this.sourcePluginDir, pluginDir, symlinkType);
      return 'symlink';
    } catch (e) {
      logger.warn(
        `ShadowVaultBootstrap: symlink failed (${(e as Error).message}); falling back to recursive copy`,
      );
    }

    // dereference: true so a symlinked source still copies real files,
    // not nested symlinks the shadow vault wouldn't resolve correctly.
    fs.cpSync(this.sourcePluginDir, pluginDir, { recursive: true, dereference: true });
    return 'copy';
  }
}

/**
 * Profile ids should already be uuids, but we sanitise defensively:
 * a malicious or unusual id should never escape `baseDir` via `..`
 * or surprise the filesystem with separators.
 */
function sanitiseProfileId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Empty / dot-only ids would resolve to baseDir itself or its
  // parent; force them into something benign.
  if (!cleaned || cleaned === '.' || cleaned === '..') return '_invalid';
  return cleaned;
}
