import { logger } from '../util/logger';
import { errorMessage } from "../util/errorMessage";

/**
 * One row from Obsidian's community-plugins master list at
 * https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json
 *
 * Authoritative mapping from plugin id → GitHub `owner/repo`.
 */
export interface MasterListEntry {
  id: string;
  repo: string;
  name?: string;
  author?: string;
  description?: string;
}

/**
 * Per-plugin manifest fetched from `<repo>/HEAD/manifest.json`. Required
 * fields are `id` and `version`; the rest is plugin-specific metadata
 * Obsidian's `installPlugin` validates internally.
 */
export interface PluginManifest {
  id: string;
  version: string;
  name?: string;
  author?: string;
  minAppVersion?: string;
  description?: string;
  [k: string]: unknown;
}

/**
 * The thin slice of `app.plugins` we need. The full surface lives on
 * Obsidian's internals (no public typings); we narrow it here so the
 * installer is testable without standing up Obsidian.
 *
 * - `manifests` is the cache of LOCALLY-installed plugins (key = id).
 *   We use it to determine which wanted ids are still missing.
 * - `installPlugin(repo, version, manifest)` downloads the plugin's
 *   release files into `<vault>/.obsidian/plugins/<id>/` and refreshes
 *   the manifests cache.
 * - `enablePluginAndSave(id)` enables an installed plugin and persists
 *   the change to `.obsidian/community-plugins.json`.
 */
export interface PluginsApi {
  manifests: Record<string, { id: string }>;
  installPlugin(repo: string, version: string, manifest: PluginManifest): Promise<void>;
  enablePluginAndSave(id: string): Promise<void>;
}

/**
 * Pluggable URL fetcher. Production passes Obsidian's `requestUrl`
 * (which sidesteps CORS); tests pass a stub map.
 */
export interface FetchTextFn {
  (url: string): Promise<string>;
}

export interface InstallerDeps {
  fetchText: FetchTextFn;
  pluginApi: PluginsApi;
  /**
   * Override the master-list URL. Defaults to Obsidian's official
   * community-plugins.json. Tests pass a localhost or stub URL.
   */
  masterListUrl?: string;
  /**
   * Build the per-plugin manifest URL from a repo. Defaults to the
   * `HEAD/manifest.json` convention Obsidian itself uses. Tests can
   * override to point at fixtures.
   *
   * Declared as a property (arrow-function type) rather than a method so
   * extracting it bare in the constructor doesn't trip `unbound-method`.
   */
  manifestUrlFor?: (repo: string) => string;
}

export interface InstallReport {
  /** ids successfully installed + enabled in this run. */
  installed: string[];
  /** ids that were already installed (no work needed). */
  skipped: string[];
  /** ids whose install failed; `reason` is logged + included for debugging. */
  failed: Array<{ id: string; reason: string }>;
}

const DEFAULT_MASTER_LIST_URL =
  'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json';

const DEFAULT_MANIFEST_URL = (repo: string): string =>
  `https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`;

/**
 * Install missing community plugins by id, using Obsidian's own
 * `app.plugins.installPlugin` machinery.
 *
 * Usage in the shadow-vault flow: the bootstrap writes the source
 * vault's plugin id list to the shadow's `community-plugins.json`
 * but does NOT copy plugin binaries. On shadow window startup, this
 * installer notices the gap (`community-plugins.json` references ids
 * with no matching `<plugin-dir>`) and fills it in by:
 *
 *   1. Fetching Obsidian's community-plugins master list once
 *      (gives us `id → owner/repo`).
 *   2. For each missing id, fetching the repo's manifest.json
 *      (gives us version + manifest object).
 *   3. Calling `app.plugins.installPlugin(repo, version, manifest)` —
 *      which downloads main.js / styles.css / manifest.json into
 *      `<shadow-vault>/.obsidian/plugins/<id>/`.
 *   4. Calling `app.plugins.enablePluginAndSave(id)` to flip it on.
 *
 * Failures (id missing from master list, repo manifest 404, network
 * blip mid-install) are reported per-id without aborting the rest.
 */
export class PluginMarketplaceInstaller {
  private readonly masterListUrl: string;
  private readonly manifestUrlFor: (repo: string) => string;

  constructor(private readonly deps: InstallerDeps) {
    this.masterListUrl = deps.masterListUrl ?? DEFAULT_MASTER_LIST_URL;
    this.manifestUrlFor = deps.manifestUrlFor ?? DEFAULT_MANIFEST_URL;
  }

  async installMissing(wantedIds: ReadonlyArray<string>): Promise<InstallReport> {
    const present = new Set(Object.keys(this.deps.pluginApi.manifests));
    const missing: string[] = [];
    const skipped: string[] = [];
    for (const id of wantedIds) {
      if (present.has(id)) skipped.push(id);
      else                 missing.push(id);
    }

    if (missing.length === 0) {
      return { installed: [], skipped, failed: [] };
    }

    // Master list fetch failure is fatal for the whole batch — without
    // it we can't map any id to its repo. Surface as failures so the
    // caller can show a single Notice and fall back gracefully.
    let masterMap: Map<string, MasterListEntry>;
    try {
      const list = await this.fetchMasterList();
      masterMap = new Map(list.map(e => [e.id, e]));
    } catch (e) {
      const reason = `master list fetch failed: ${errorMessage(e)}`;
      logger.warn(`PluginMarketplaceInstaller: ${reason}`);
      return {
        installed: [],
        skipped,
        failed: missing.map(id => ({ id, reason })),
      };
    }

    const installed: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];

    for (const id of missing) {
      const entry = masterMap.get(id);
      if (!entry) {
        failed.push({ id, reason: 'not in Obsidian community-plugins master list' });
        continue;
      }
      try {
        const manifest = await this.fetchPluginManifest(entry.repo);
        if (manifest.id !== id) {
          // Defensive: the master list says repo R is plugin X, but
          // the repo's manifest says it's plugin Y. Don't install
          // under the wrong id.
          failed.push({
            id,
            reason: `manifest id mismatch: master expected "${id}" but ${entry.repo}/manifest.json reported "${manifest.id}"`,
          });
          continue;
        }
        await this.deps.pluginApi.installPlugin(entry.repo, manifest.version, manifest);
        await this.deps.pluginApi.enablePluginAndSave(id);
        installed.push(id);
      } catch (e) {
        failed.push({ id, reason: errorMessage(e) });
      }
    }

    return { installed, skipped, failed };
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private async fetchMasterList(): Promise<MasterListEntry[]> {
    const body = await this.deps.fetchText(this.masterListUrl);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error(`master list JSON parse: ${errorMessage(e)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error('master list is not a JSON array');
    }
    return parsed.filter(
      (p): p is MasterListEntry =>
        !!p && typeof (p as MasterListEntry).id === 'string'
            && typeof (p as MasterListEntry).repo === 'string',
    );
  }

  private async fetchPluginManifest(repo: string): Promise<PluginManifest> {
    const url = this.manifestUrlFor(repo);
    const body = await this.deps.fetchText(url);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error(`manifest JSON parse for ${repo}: ${errorMessage(e)}`);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`manifest for ${repo} is not an object`);
    }
    const m = parsed as Record<string, unknown>;
    if (typeof m.id !== 'string' || typeof m.version !== 'string') {
      throw new Error(`manifest for ${repo} missing required id / version`);
    }
    return m as unknown as PluginManifest;
  }
}
