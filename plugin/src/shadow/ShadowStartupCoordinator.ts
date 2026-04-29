import { App, FileSystemAdapter, Notice, requestUrl } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type { PluginSettings, PendingPluginSuggestion } from '../types';
import { logger } from '../util/logger';
import { PendingPluginsModal } from '../ui/PendingPluginsModal';
import { PluginMarketplaceInstaller, type PluginsApi } from './PluginMarketplaceInstaller';

/**
 * Owns the plugin-install half of shadow-vault startup:
 *
 *   1. If `bootstrap()` left a snapshot of source's enabled community
 *      plugins on this shadow's `data.json`, prompt the user via
 *      `PendingPluginsModal` to opt in, install the chosen subset
 *      from Obsidian's marketplace, optionally seed each plugin's
 *      `data.json` from the source snapshot, then clear the snapshot.
 *
 *   2. Read this shadow vault's `community-plugins.json`, find ids
 *      whose binaries aren't yet installed, and download them from
 *      the marketplace. On first bootstrap this is a no-op (the list
 *      is just `["remote-ssh"]`); the path matters on re-bootstrap
 *      where the user has accumulated a real list and a binary went
 *      missing (vault moved disks, plugin dir purged, …).
 *
 * Extracted from main.ts (Phase Refactor / God-file split, PR 2/3).
 * The coordinator owns the lifecycle of `settings.pendingPluginSuggestions`
 * — when it clears the field it calls the supplied `saveSettings`
 * callback to persist. Everything else (auto-connect, RPC tunnel,
 * adapter patching) stays in main.ts.
 */
export class ShadowStartupCoordinator {
  /**
   * @param app           Obsidian App — needed for `vault.adapter` (FileSystemAdapter probe + getBasePath)
   *                      and for the `app.plugins` cast that drives the marketplace installer.
   * @param settings      mutable plugin settings — the coordinator clears `pendingPluginSuggestions` after a
   *                      definitive install/skip decision.
   * @param saveSettings  callback that persists the mutated settings — must be the plugin's own saveSettings
   *                      (which serializes hostKeyStore + secrets too); we don't reproduce that surface.
   */
  constructor(
    private readonly app: App,
    private readonly settings: PluginSettings,
    private readonly saveSettings: () => Promise<void>,
  ) {}

  /**
   * Run the two install passes in order. Designed to be called from
   * `onLayoutReady` *before* auto-connect, so the user has all their
   * marketplace plugins on disk by the time the SSH session opens.
   */
  async prepareForAutoConnect(): Promise<void> {
    await this.handlePendingPluginSuggestions();
    await this.installMissingShadowPlugins();
  }

  /**
   * If `bootstrap()` left a snapshot of source's enabled community
   * plugins on this shadow's `data.json`, surface a selection modal so
   * the user opts in to which ones get installed (and whether to seed
   * each installed plugin's `data.json` from the source snapshot). On
   * a definitive "install" / "skip" decision we clear the snapshot so
   * the modal doesn't return on the next reload. "Ask later" leaves it
   * in place.
   */
  private async handlePendingPluginSuggestions(): Promise<void> {
    const suggestions = this.settings.pendingPluginSuggestions;
    if (!suggestions || suggestions.length === 0) return;

    const decision = await new PendingPluginsModal(this.app, suggestions).prompt();
    if (decision.decision === 'later') {
      logger.info('handlePendingPluginSuggestions: user picked "ask later"');
      return;
    }

    if (decision.decision === 'skip') {
      logger.info('handlePendingPluginSuggestions: user picked skip — clearing snapshot');
      this.settings.pendingPluginSuggestions = undefined;
      await this.saveSettings();
      return;
    }

    // decision.decision === 'install'
    const selectedSet = new Set(decision.selected);
    const selected = suggestions.filter(s => selectedSet.has(s.id));
    logger.info(
      `handlePendingPluginSuggestions: install ${selected.length}/${suggestions.length} ` +
      `(copyConfig=${decision.copyConfig})`,
    );

    if (selected.length > 0) {
      const installer = this.makeMarketplaceInstaller();
      const report = await installer.installMissing(selected.map(s => s.id));
      const summary =
        `pendingPluginSuggestions install: installed=${report.installed.length} ` +
        `(${report.installed.join(', ')}), skipped=${report.skipped.length}, ` +
        `failed=${report.failed.length}`;
      logger.info(summary);
      if (report.installed.length > 0) {
        new Notice(
          `Remote SSH: installed ${report.installed.length} plugin` +
          `${report.installed.length === 1 ? '' : 's'} from marketplace`,
        );
      }
      if (report.failed.length > 0) {
        logger.warn(
          `pendingPluginSuggestions install failures: ${JSON.stringify(report.failed, null, 2)}`,
        );
        new Notice(
          `Remote SSH: ${report.failed.length} plugin install failure` +
          `${report.failed.length === 1 ? '' : 's'} — see console.log`,
        );
      }
      if (decision.copyConfig) {
        // Only seed configs for plugins we actually installed in this
        // run — if installPlugin failed, writing data.json to a
        // half-empty plugin dir would just confuse the next load.
        this.copyPluginConfigsForInstalled(selected, new Set(report.installed));
      }
    }

    this.settings.pendingPluginSuggestions = undefined;
    await this.saveSettings();
  }

  /**
   * Read this shadow vault's community-plugins.json, find ids whose
   * binaries aren't yet installed, and download them from Obsidian's
   * community marketplace. On first bootstrap this is a no-op (the
   * list is just `["remote-ssh"]`); the path matters on re-bootstrap
   * where the user has accumulated a real list and a binary went
   * missing (vault moved disks, plugin dir purged, …).
   */
  private async installMissingShadowPlugins(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      logger.warn('installMissingShadowPlugins: vault is not FileSystemAdapter-backed; skipping');
      return;
    }
    const cpPath = path.join(adapter.getBasePath(), '.obsidian', 'community-plugins.json');
    if (!fs.existsSync(cpPath)) return;
    let wantedIds: string[];
    try {
      const parsed = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
      if (!Array.isArray(parsed)) return;
      wantedIds = parsed.filter((s): s is string => typeof s === 'string');
    } catch (e) {
      logger.warn(`installMissingShadowPlugins: failed to parse ${cpPath}: ${(e as Error).message}`);
      return;
    }

    const installer = this.makeMarketplaceInstaller();
    const report = await installer.installMissing(wantedIds);
    const summary =
      `installMissingShadowPlugins: installed=${report.installed.length} ` +
      `(${report.installed.join(', ')}), skipped=${report.skipped.length}, ` +
      `failed=${report.failed.length}`;
    logger.info(summary);
    if (report.installed.length > 0) {
      new Notice(
        `Remote SSH: re-installed ${report.installed.length} missing plugin` +
        `${report.installed.length === 1 ? '' : 's'} from marketplace`,
      );
    }
    if (report.failed.length > 0) {
      logger.warn(
        `installMissingShadowPlugins: failures: ${JSON.stringify(report.failed, null, 2)}`,
      );
    }
  }

  private makeMarketplaceInstaller(): PluginMarketplaceInstaller {
    return new PluginMarketplaceInstaller({
      // `requestUrl` is Obsidian's own cross-origin-friendly fetch.
      // Plain `fetch` to raw.githubusercontent.com is blocked by
      // Electron's renderer CORS in some Obsidian versions.
      fetchText: async (url) => {
        const resp = await requestUrl({ url });
        return resp.text;
      },
      // `app.plugins` is internal Obsidian state — not in the public
      // typings — but its `installPlugin` / `enablePluginAndSave`
      // surface has been stable across recent versions and is what
      // the community plugin browser modal calls.
      pluginApi: (this.app as unknown as { plugins: PluginsApi }).plugins,
    });
  }

  /**
   * Seed each successfully-installed plugin's `data.json` from the
   * snapshot we captured in source at bootstrap time. Per-plugin
   * failures are logged but don't abort — a missing seed just means
   * the user gets out-of-the-box defaults for that plugin.
   */
  private copyPluginConfigsForInstalled(
    suggestions: ReadonlyArray<PendingPluginSuggestion>,
    installedIds: Set<string>,
  ): void {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      logger.warn('copyPluginConfigsForInstalled: vault is not FileSystemAdapter-backed; skipping');
      return;
    }
    const pluginsRoot = path.join(adapter.getBasePath(), '.obsidian', 'plugins');
    let written = 0;
    for (const s of suggestions) {
      if (!installedIds.has(s.id)) continue;
      if (s.sourceData == null) continue;
      const dataPath = path.join(pluginsRoot, s.id, 'data.json');
      try {
        fs.mkdirSync(path.dirname(dataPath), { recursive: true });
        fs.writeFileSync(dataPath, JSON.stringify(s.sourceData, null, 2) + '\n', 'utf-8');
        written++;
      } catch (e) {
        logger.warn(`copyPluginConfigsForInstalled: failed for ${s.id}: ${(e as Error).message}`);
      }
    }
    logger.info(`copyPluginConfigsForInstalled: wrote ${written} data.json file(s)`);
  }
}
