import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../util/logger';
import type { SshProfile, PendingPluginSuggestion } from '../types';
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

    // First bootstrap (shadow data.json doesn't exist yet) — we'll
    // also collect a snapshot of source's enabled plugins to surface
    // through a confirmation modal in the shadow window. Detect now
    // before the `readBaseDataJson` call below side-effects state.
    const isFirstBootstrap = !fs.existsSync(layout.pluginDataFile);

    // `community-plugins.json` always starts as `["remote-ssh"]` only.
    // Inheriting source's full enabled list at bootstrap time was too
    // surprising — the shadow window would auto-install every plugin
    // from the marketplace right after Obsidian's "trust this vault"
    // prompt, which felt like the plugin was acting on its own. Now
    // the user opts in via a modal (see `pendingPluginSuggestions`
    // below) and the install only happens for what they tick.
    this.seedCommunityPlugins(layout.configDir);

    // Install our own plugin source (symlink preferred so dev
    // iterations appear immediately; copy as a Windows fallback).
    // Per-file install means data.json stays per-vault.
    const pluginInstallMethod = this.installPlugin(layout.pluginDir);

    // data.json strategy: MERGE rather than overwrite, so accumulated
    // state on the shadow side (hostKeyStore from past TOFU prompts,
    // secrets, etc.) survives a re-bootstrap. On first bootstrap we
    // seed from the source vault's data.json so the shadow inherits
    // the source's already-trusted host keys — without that, every
    // freshly-bootstrapped shadow vault would TOFU-prompt on the
    // very first auto-connect.
    //
    // Bootstrap-managed fields (profiles list, activeProfileId,
    // autoConnectProfileId) are always overwritten to reflect the
    // current Connect click. `pendingPluginSuggestions` is set only
    // on first bootstrap (and only if source has community plugins
    // worth suggesting) so re-bootstrap doesn't re-prompt a user
    // who's already made their decision.
    const baseData = this.readBaseDataJson(layout.pluginDataFile);
    const data: Record<string, unknown> = {
      ...baseData,
      profiles: allProfiles,
      activeProfileId: profile.id,
      autoConnectProfileId: profile.id,
    };
    if (isFirstBootstrap) {
      const pending = this.collectPendingPluginSuggestions();
      if (pending.length > 0) {
        data.pendingPluginSuggestions = pending;
      }
    }
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

  /**
   * Materialise `<configDir>/community-plugins.json`.
   *
   * - First bootstrap (file doesn't exist): write `["remote-ssh"]`
   *   only. Source's enabled plugin set is captured separately via
   *   `collectPendingPluginSuggestions` so the shadow window can
   *   prompt the user to opt in selectively.
   * - Re-bootstrap (file exists): leave the user's accumulated list
   *   alone. Only ensure `remote-ssh` is in it.
   */
  private seedCommunityPlugins(configDir: string): void {
    const shadowPath = path.join(configDir, 'community-plugins.json');

    if (fs.existsSync(shadowPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(shadowPath, 'utf-8'));
        if (Array.isArray(existing)) {
          const ids = existing.filter((s): s is string => typeof s === 'string');
          if (!ids.includes('remote-ssh')) {
            ids.push('remote-ssh');
            fs.writeFileSync(shadowPath, JSON.stringify(ids) + '\n', 'utf-8');
          }
          return;
        }
      } catch (e) {
        logger.warn(
          `ShadowVaultBootstrap: failed to parse shadow community-plugins.json ` +
          `(${(e as Error).message}); rewriting as [remote-ssh]`,
        );
      }
    }

    fs.writeFileSync(shadowPath, JSON.stringify(['remote-ssh']) + '\n', 'utf-8');
  }

  /**
   * Snapshot the source vault's enabled community plugins (other
   * than our own `remote-ssh`) plus each one's source-side
   * `data.json`. Stored in shadow `data.json` as
   * `pendingPluginSuggestions` so the shadow window can prompt the
   * user to install only what they want — no surprise auto-install
   * after Obsidian's "trust this vault" dialog.
   *
   * Returns an empty array if source has no community-plugins.json,
   * if it has only `remote-ssh`, or if it can't be parsed.
   */
  private collectPendingPluginSuggestions(): PendingPluginSuggestion[] {
    const sourceConfigDir = this.sourceConfigDir();
    const sourceListPath = path.join(sourceConfigDir, 'community-plugins.json');
    if (!fs.existsSync(sourceListPath)) return [];

    let sourceIds: string[];
    try {
      const parsed = JSON.parse(fs.readFileSync(sourceListPath, 'utf-8'));
      if (!Array.isArray(parsed)) return [];
      sourceIds = parsed.filter((s): s is string => typeof s === 'string' && s !== 'remote-ssh');
    } catch (e) {
      logger.warn(
        `ShadowVaultBootstrap: failed to parse source community-plugins.json ` +
        `(${(e as Error).message}); no suggestions will be offered`,
      );
      return [];
    }

    const sourcePluginsRoot = path.join(sourceConfigDir, 'plugins');
    return sourceIds.map(id => {
      let sourceData: unknown = null;
      const dataPath = path.join(sourcePluginsRoot, id, 'data.json');
      if (fs.existsSync(dataPath)) {
        try {
          sourceData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
        } catch (e) {
          logger.warn(
            `ShadowVaultBootstrap: failed to parse source data.json for ${id} ` +
            `(${(e as Error).message}); will offer install without config inheritance`,
          );
        }
      }
      return { id, sourceData };
    });
  }

  /**
   * `.obsidian/` of the source vault — derived from
   * `sourcePluginDir` which lives at `<source-vault>/.obsidian/plugins/remote-ssh`.
   */
  private sourceConfigDir(): string {
    // sourcePluginDir = <vault>/.obsidian/plugins/remote-ssh
    // → walk up two levels for .obsidian/.
    return path.dirname(path.dirname(this.sourcePluginDir));
  }

  /**
   * Decide what to use as the base for the shadow vault's
   * `data.json` before merging the bootstrap-managed fields:
   *
   * - If a shadow `data.json` already exists, parse and use it.
   *   Preserves anything the shadow has accumulated since last
   *   bootstrap (hostKeyStore, secrets, user preferences).
   * - Otherwise, fall back to the source vault's `data.json` so the
   *   first shadow connect can re-use the user's already-trusted
   *   host keys instead of TOFU-prompting.
   * - Otherwise, start fresh `{}`.
   *
   * Parse failures are logged and treated as "start fresh" — better
   * to lose accumulated state than write a corrupted JSON file
   * that would brick the plugin on next load.
   */
  private readBaseDataJson(shadowDataPath: string): Record<string, unknown> {
    const candidates = [shadowDataPath, path.join(this.sourcePluginDir, 'data.json')];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch (e) {
        logger.warn(
          `ShadowVaultBootstrap: failed to parse ${candidate} (${(e as Error).message}); ` +
          'continuing without it',
        );
      }
    }
    return {};
  }

  /**
   * Install the plugin per-file rather than as one big symlinked
   * directory.
   *
   * The earlier "symlink the whole plugin dir" approach was tighter
   * and one fewer step, but it sneakily broke the source vault: the
   * shadow vault's plugin would write its own per-vault `data.json`
   * THROUGH the symlink, clobbering the source vault's settings
   * (hostKeyStore, secrets, …) on the very first connect.
   *
   * Fix: pluginDir is a **real directory**. Code + assets
   * (`main.js`, `manifest.json`, `styles.css`, `server-bin/`) are
   * symlinked individually so dev-build iterations land immediately,
   * but `data.json` is **never touched** by install — the caller
   * writes the per-vault data.json into pluginDir as a real file,
   * leaving the source vault's data.json untouched.
   */
  private installPlugin(pluginDir: string): 'symlink' | 'copy' {
    // If pluginDir is a stale whole-dir symlink from an older build
    // (or a previous run of this same code on an older version),
    // unlink it — DO NOT rmSync, that would follow the link and
    // recursively delete the source plugin dir.
    try {
      const stat = fs.lstatSync(pluginDir);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(pluginDir);
      }
    } catch {
      // Doesn't exist yet, fine.
    }

    fs.mkdirSync(pluginDir, { recursive: true });

    const sharedFiles = ['main.js', 'manifest.json', 'styles.css'];
    const sharedDirs = ['server-bin'];

    let useSymlink = true;

    for (const f of sharedFiles) {
      const src = path.join(this.sourcePluginDir, f);
      const dst = path.join(pluginDir, f);
      if (!fs.existsSync(src)) continue;
      // Plain rmSync handles existing file or file-symlink — does NOT
      // follow into directories.
      try { fs.rmSync(dst, { force: true }); } catch { /* noop */ }
      if (useSymlink) {
        try { fs.symlinkSync(src, dst, 'file'); continue; }
        catch (e) {
          logger.warn(`ShadowVaultBootstrap: file symlink failed (${(e as Error).message}); falling back to copy`);
          useSymlink = false;
        }
      }
      fs.copyFileSync(src, dst);
    }

    for (const d of sharedDirs) {
      const src = path.join(this.sourcePluginDir, d);
      const dst = path.join(pluginDir, d);
      if (!fs.existsSync(src)) continue;
      // Use lstat + unlink for symlinks vs rmSync recursive for real
      // dirs so we never accidentally recurse through a link.
      try {
        const stat = fs.lstatSync(dst);
        if (stat.isSymbolicLink()) fs.unlinkSync(dst);
        else                       fs.rmSync(dst, { recursive: true, force: true });
      } catch { /* noop */ }
      if (useSymlink) {
        try {
          const linkType = process.platform === 'win32' ? 'junction' : 'dir';
          fs.symlinkSync(src, dst, linkType);
          continue;
        } catch (e) {
          logger.warn(`ShadowVaultBootstrap: dir symlink failed (${(e as Error).message}); falling back to copy`);
          useSymlink = false;
        }
      }
      // dereference so a symlinked source produces real files in the
      // shadow vault rather than nested links that wouldn't resolve.
      fs.cpSync(src, dst, { recursive: true, dereference: true });
    }

    return useSymlink ? 'symlink' : 'copy';
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
