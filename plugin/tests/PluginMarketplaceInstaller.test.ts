import { describe, it, expect, vi } from 'vitest';
import {
  PluginMarketplaceInstaller,
  type FetchTextFn,
  type InstallerDeps,
  type PluginsApi,
  type PluginManifest,
} from '../src/shadow/PluginMarketplaceInstaller';

const MASTER_URL =
  'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json';

/** Build a fetch stub keyed by URL. Throws ENOENT-style for unknown URLs. */
function fetchFromMap(map: Record<string, string>): FetchTextFn {
  return async (url: string) => {
    if (!(url in map)) throw new Error(`fetch stub: no entry for ${url}`);
    return map[url];
  };
}

/** Build a `PluginsApi` stub backed by a mutable manifests map + recordable side effects. */
function makePluginsApi(presentIds: string[] = []) {
  const manifests: Record<string, { id: string }> = {};
  for (const id of presentIds) manifests[id] = { id };
  const installed: Array<{ repo: string; version: string; manifest: PluginManifest }> = [];
  const enabled: string[] = [];
  const api: PluginsApi = {
    manifests,
    async installPlugin(repo, version, manifest) {
      installed.push({ repo, version, manifest });
      manifests[manifest.id] = { id: manifest.id };
    },
    async enablePluginAndSave(id) {
      enabled.push(id);
    },
  };
  return { api, manifests, installed, enabled };
}

function manifestUrlFor(repo: string): string {
  return `https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`;
}

function masterJson(...entries: Array<{ id: string; repo: string }>) {
  return JSON.stringify(entries);
}
function manifestJson(id: string, version: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ id, version, ...extra });
}

describe('PluginMarketplaceInstaller.installMissing', () => {
  it('returns empty + skips everything when all wanted ids are already installed', async () => {
    const { api, installed, enabled } = makePluginsApi(['dataview', 'templater-obsidian']);
    const deps: InstallerDeps = {
      fetchText: fetchFromMap({}),  // never called
      pluginApi: api,
    };
    const result = await new PluginMarketplaceInstaller(deps).installMissing(['dataview', 'templater-obsidian']);
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual(['dataview', 'templater-obsidian']);
    expect(result.failed).toEqual([]);
    expect(installed).toHaveLength(0);
    expect(enabled).toHaveLength(0);
  });

  it('installs missing plugins by fetching master list + per-plugin manifest, then enables', async () => {
    const { api, installed, enabled, manifests } = makePluginsApi([]);
    const deps: InstallerDeps = {
      fetchText: fetchFromMap({
        [MASTER_URL]: masterJson(
          { id: 'dataview', repo: 'blacksmithgu/obsidian-dataview' },
          { id: 'templater-obsidian', repo: 'SilentVoid13/Templater' },
        ),
        [manifestUrlFor('blacksmithgu/obsidian-dataview')]: manifestJson('dataview', '0.5.68'),
        [manifestUrlFor('SilentVoid13/Templater')]: manifestJson('templater-obsidian', '2.6.1'),
      }),
      pluginApi: api,
    };

    const result = await new PluginMarketplaceInstaller(deps).installMissing(['dataview', 'templater-obsidian']);

    expect(result.installed).toEqual(['dataview', 'templater-obsidian']);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);

    expect(installed).toEqual([
      { repo: 'blacksmithgu/obsidian-dataview', version: '0.5.68', manifest: { id: 'dataview', version: '0.5.68' } },
      { repo: 'SilentVoid13/Templater',         version: '2.6.1',  manifest: { id: 'templater-obsidian', version: '2.6.1' } },
    ]);
    expect(enabled).toEqual(['dataview', 'templater-obsidian']);
    expect(manifests['dataview']).toBeDefined();
    expect(manifests['templater-obsidian']).toBeDefined();
  });

  it('mixes skipped + installed when some wanted ids are present and others aren\'t', async () => {
    const { api, installed, enabled } = makePluginsApi(['dataview']);
    const deps: InstallerDeps = {
      fetchText: fetchFromMap({
        [MASTER_URL]: masterJson({ id: 'templater-obsidian', repo: 'SilentVoid13/Templater' }),
        [manifestUrlFor('SilentVoid13/Templater')]: manifestJson('templater-obsidian', '2.6.1'),
      }),
      pluginApi: api,
    };
    const result = await new PluginMarketplaceInstaller(deps).installMissing(['dataview', 'templater-obsidian']);
    expect(result.skipped).toEqual(['dataview']);
    expect(result.installed).toEqual(['templater-obsidian']);
    expect(installed).toHaveLength(1);
    expect(enabled).toEqual(['templater-obsidian']);
  });

  it('reports failure when an id is not in the master list, but continues with others', async () => {
    const { api, installed, enabled } = makePluginsApi([]);
    const deps: InstallerDeps = {
      fetchText: fetchFromMap({
        [MASTER_URL]: masterJson({ id: 'dataview', repo: 'blacksmithgu/obsidian-dataview' }),
        [manifestUrlFor('blacksmithgu/obsidian-dataview')]: manifestJson('dataview', '0.5.68'),
      }),
      pluginApi: api,
    };
    const result = await new PluginMarketplaceInstaller(deps).installMissing(['dataview', 'private-plugin']);
    expect(result.installed).toEqual(['dataview']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe('private-plugin');
    expect(result.failed[0].reason).toMatch(/not in.*master list/);
    expect(installed).toHaveLength(1);
    expect(enabled).toEqual(['dataview']);
  });

  it('reports per-plugin failures when a manifest fetch errors, without aborting the batch', async () => {
    const { api, enabled } = makePluginsApi([]);
    const deps: InstallerDeps = {
      fetchText: fetchFromMap({
        [MASTER_URL]: masterJson(
          { id: 'good', repo: 'owner/good' },
          { id: 'bad', repo: 'owner/bad' },
        ),
        [manifestUrlFor('owner/good')]: manifestJson('good', '1.0.0'),
        // owner/bad's manifest URL intentionally not stubbed → throws
      }),
      pluginApi: api,
    };
    const result = await new PluginMarketplaceInstaller(deps).installMissing(['good', 'bad']);
    expect(result.installed).toEqual(['good']);
    expect(result.failed).toEqual([{ id: 'bad', reason: expect.stringMatching(/no entry for/) }]);
    expect(enabled).toEqual(['good']);
  });

  it('rejects a manifest whose id does not match the master-list id', async () => {
    const { api, enabled } = makePluginsApi([]);
    const deps: InstallerDeps = {
      fetchText: fetchFromMap({
        [MASTER_URL]: masterJson({ id: 'expected-id', repo: 'owner/repo' }),
        // Manifest reports a different id — could be a hijacked repo.
        [manifestUrlFor('owner/repo')]: manifestJson('different-id', '1.0.0'),
      }),
      pluginApi: api,
    };
    const result = await new PluginMarketplaceInstaller(deps).installMissing(['expected-id']);
    expect(result.installed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toMatch(/manifest id mismatch/);
    expect(enabled).toEqual([]);
  });

  it('treats master list fetch failure as fatal: every missing id ends up failed, no installs attempted', async () => {
    const { api, installed, enabled } = makePluginsApi([]);
    const deps: InstallerDeps = {
      // No MASTER_URL entry → fetch throws
      fetchText: fetchFromMap({}),
      pluginApi: api,
    };
    const result = await new PluginMarketplaceInstaller(deps).installMissing(['dataview', 'templater']);
    expect(result.installed).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0].reason).toMatch(/master list fetch failed/);
    expect(result.failed[1].reason).toMatch(/master list fetch failed/);
    expect(installed).toHaveLength(0);
    expect(enabled).toHaveLength(0);
  });

  it('rejects malformed master list (not a JSON array)', async () => {
    const { api } = makePluginsApi([]);
    const deps: InstallerDeps = {
      fetchText: fetchFromMap({ [MASTER_URL]: '{"this":"is not an array"}' }),
      pluginApi: api,
    };
    const result = await new PluginMarketplaceInstaller(deps).installMissing(['dataview']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toMatch(/master list/);
  });

  it('rejects a manifest missing required fields', async () => {
    const { api } = makePluginsApi([]);
    const deps: InstallerDeps = {
      fetchText: fetchFromMap({
        [MASTER_URL]: masterJson({ id: 'p', repo: 'owner/p' }),
        // Manifest has id but no version.
        [manifestUrlFor('owner/p')]: '{"id":"p"}',
      }),
      pluginApi: api,
    };
    const result = await new PluginMarketplaceInstaller(deps).installMissing(['p']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toMatch(/missing required id \/ version/);
  });

  it('honours the masterListUrl + manifestUrlFor overrides (test fixture wiring)', async () => {
    const { api, installed } = makePluginsApi([]);
    const customMaster = 'http://localhost:9999/master.json';
    const customManifest = (repo: string) => `http://localhost:9999/manifests/${repo}.json`;
    const deps: InstallerDeps = {
      fetchText: fetchFromMap({
        [customMaster]: masterJson({ id: 'p', repo: 'o/p' }),
        [customManifest('o/p')]: manifestJson('p', '0.0.1'),
      }),
      pluginApi: api,
      masterListUrl: customMaster,
      manifestUrlFor: customManifest,
    };
    const result = await new PluginMarketplaceInstaller(deps).installMissing(['p']);
    expect(result.installed).toEqual(['p']);
    expect(installed).toHaveLength(1);
  });
});
