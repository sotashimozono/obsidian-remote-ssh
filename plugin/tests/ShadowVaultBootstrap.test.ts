import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ShadowVaultBootstrap } from '../src/shadow/ShadowVaultBootstrap';
import { ObsidianRegistry } from '../src/shadow/ObsidianRegistry';
import type { SshProfile } from '../src/types';

/** Minimal valid profile shape for the tests. */
function makeProfile(overrides: Partial<SshProfile> = {}): SshProfile {
  return {
    id: 'profile-test-id',
    name: 'Test',
    host: 'example.invalid',
    port: 22,
    username: 'alice',
    authMethod: 'privateKey',
    remotePath: '~/test-vault/',
    privateKeyPath: '/dev/null',
    connectTimeoutMs: 5000,
    keepaliveIntervalMs: 10000,
    keepaliveCountMax: 3,
    ...overrides,
  } as SshProfile;
}

/**
 * Each test gets its own scratch tree so they can't cross-pollute and
 * the developer's real `~/.obsidian-remote/` is never touched.
 */
function makeScratch(): { baseDir: string; sourceDir: string; configPath: string; cleanup(): void } {
  const root = path.join(os.tmpdir(), `shadow-vault-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const baseDir = path.join(root, 'vaults');
  const sourceDir = path.join(root, 'plugin-source');
  const configPath = path.join(root, 'obsidian.json');
  fs.mkdirSync(sourceDir, { recursive: true });
  // Stage a couple of plugin files so install actually has something
  // to copy / link.
  fs.writeFileSync(path.join(sourceDir, 'main.js'), '// fake bundled plugin\n');
  fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({ id: 'remote-ssh', version: '0.0.0' }));
  fs.writeFileSync(configPath, JSON.stringify({ vaults: {} }));
  return {
    baseDir, sourceDir, configPath,
    cleanup() {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

describe('ShadowVaultBootstrap.layoutFor', () => {
  it('returns a layout under baseDir/profileId for a clean id', () => {
    const scratch = makeScratch();
    try {
      const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
      const layout = r.layoutFor('abc-123');
      expect(layout.vaultDir).toBe(path.join(scratch.baseDir, 'abc-123'));
      expect(layout.configDir).toBe(path.join(scratch.baseDir, 'abc-123', '.obsidian'));
      expect(layout.pluginDir).toBe(path.join(scratch.baseDir, 'abc-123', '.obsidian', 'plugins', 'remote-ssh'));
      expect(layout.pluginDataFile).toBe(path.join(layout.pluginDir, 'data.json'));
    } finally { scratch.cleanup(); }
  });

  it('sanitises ids that contain path separators or traversal so vaultDir stays inside baseDir', () => {
    const scratch = makeScratch();
    try {
      const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
      // `../etc` would escape baseDir if not sanitised.
      const lo = r.layoutFor('../etc');
      expect(path.dirname(lo.vaultDir)).toBe(scratch.baseDir);
      expect(path.resolve(lo.vaultDir).startsWith(path.resolve(scratch.baseDir) + path.sep)).toBe(true);
      // Slashes inside an id should not introduce nested directories.
      const slash = r.layoutFor('a/b/c');
      expect(path.dirname(slash.vaultDir)).toBe(scratch.baseDir);
    } finally { scratch.cleanup(); }
  });
});

describe('ShadowVaultBootstrap.bootstrap', () => {
  let scratch: ReturnType<typeof makeScratch>;
  beforeEach(() => { scratch = makeScratch(); });
  afterEach(() => { scratch.cleanup(); });

  it('creates vaultDir, .obsidian/, plugin install, community-plugins.json, and data.json', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1', name: 'P One' });
    const result = await r.bootstrap(profile, [profile]);

    expect(fs.existsSync(result.layout.vaultDir)).toBe(true);
    expect(fs.existsSync(result.layout.configDir)).toBe(true);
    expect(fs.existsSync(result.layout.pluginDir)).toBe(true);
    expect(fs.existsSync(result.layout.pluginDataFile)).toBe(true);

    const cp = JSON.parse(fs.readFileSync(path.join(result.layout.configDir, 'community-plugins.json'), 'utf-8'));
    expect(cp).toEqual(['remote-ssh']);

    const data = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
    expect(data.profiles).toEqual([profile]);
    expect(data.activeProfileId).toBe('p1');
    expect(data.autoConnectProfileId).toBe('p1');

    // The plugin install method depends on platform / perms; just
    // assert the staged file is reachable through it.
    expect(fs.existsSync(path.join(result.layout.pluginDir, 'main.js'))).toBe(true);
    expect(['symlink', 'copy']).toContain(result.pluginInstallMethod);
  });

  it('registers the vault path in obsidian.json with a fresh id', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const cfg = JSON.parse(fs.readFileSync(scratch.configPath, 'utf-8'));
    expect(result.registryCreated).toBe(true);
    expect(cfg.vaults[result.registryId].path).toBe(result.layout.vaultDir);
    expect(cfg.vaults[result.registryId].ts).toBeGreaterThan(0);
  });

  it('is idempotent: a second bootstrap reuses the registry id and refreshes data.json', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1', name: 'First' });
    const first = await r.bootstrap(profile, [profile]);
    expect(first.registryCreated).toBe(true);

    const profileChanged = makeProfile({ id: 'p1', name: 'Renamed' });
    const second = await r.bootstrap(profileChanged, [profileChanged]);
    expect(second.registryCreated).toBe(false);
    expect(second.registryId).toBe(first.registryId);

    const data = JSON.parse(fs.readFileSync(second.layout.pluginDataFile, 'utf-8'));
    expect(data.profiles[0].name).toBe('Renamed');
  });

  it('writes ALL profiles into the shadow vault data.json, with activeProfileId pinned to the target one', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const p1 = makeProfile({ id: 'one', name: 'One' });
    const p2 = makeProfile({ id: 'two', name: 'Two' });
    const result = await r.bootstrap(p2, [p1, p2]);
    const data = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
    expect(data.profiles.map((p: SshProfile) => p.id)).toEqual(['one', 'two']);
    expect(data.activeProfileId).toBe('two');
    expect(data.autoConnectProfileId).toBe('two');
  });

  it('refreshes plugin install on bootstrap so plugin updates land immediately', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    await r.bootstrap(profile, [profile]);

    // Bump the source plugin to simulate a dev rebuild.
    fs.writeFileSync(path.join(scratch.sourceDir, 'main.js'), '// updated bundle\n');

    const result = await r.bootstrap(profile, [profile]);
    const installed = fs.readFileSync(path.join(result.layout.pluginDir, 'main.js'), 'utf-8');
    expect(installed).toContain('updated bundle');
  });
});
