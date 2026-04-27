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

  it('inherits the source vault\'s data.json on first bootstrap so accumulated host keys / secrets carry over', async () => {
    // Stage a source data.json that simulates what a real running
    // plugin would write — host keys collected from past TOFU
    // prompts, secrets, etc. The first-ever bootstrap should seed
    // these into the shadow so the auto-connect doesn't re-prompt.
    fs.writeFileSync(path.join(scratch.sourceDir, 'data.json'), JSON.stringify({
      hostKeyStore: { 'host:22': 'fingerprint-trusted-by-source' },
      secrets: { somekey: 'somevalue' },
      enableDebugLog: true,
    }), 'utf-8');

    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const shadowData = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
    expect(shadowData.hostKeyStore).toEqual({ 'host:22': 'fingerprint-trusted-by-source' });
    expect(shadowData.secrets).toEqual({ somekey: 'somevalue' });
    expect(shadowData.enableDebugLog).toBe(true);
    // Bootstrap-managed fields override source values.
    expect(shadowData.activeProfileId).toBe('p1');
    expect(shadowData.autoConnectProfileId).toBe('p1');
  });

  it('preserves shadow-side accumulated state on re-bootstrap (does not reset hostKeyStore back to source\'s)', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const first = await r.bootstrap(profile, [profile]);

    // Simulate what the shadow's running plugin would do after a
    // first connect: write new host keys / settings to its own data.json.
    const accumulated = JSON.parse(fs.readFileSync(first.layout.pluginDataFile, 'utf-8'));
    accumulated.hostKeyStore = { 'remote:22': 'fingerprint-collected-in-shadow' };
    accumulated.secrets = { tofuKey: 'tofuValue' };
    fs.writeFileSync(first.layout.pluginDataFile, JSON.stringify(accumulated, null, 2), 'utf-8');

    // Re-bootstrap (e.g. user clicks Connect again from Settings).
    await r.bootstrap(profile, [profile]);

    const after = JSON.parse(fs.readFileSync(first.layout.pluginDataFile, 'utf-8'));
    expect(after.hostKeyStore).toEqual({ 'remote:22': 'fingerprint-collected-in-shadow' });
    expect(after.secrets).toEqual({ tofuKey: 'tofuValue' });
    // Bootstrap-managed fields still get refreshed.
    expect(after.profiles).toEqual([profile]);
    expect(after.autoConnectProfileId).toBe('p1');
  });

  it('regression: source plugin\'s data.json is NEVER touched by install, even on re-bootstrap', async () => {
    // Stage a sentinel data.json in the SOURCE plugin dir — this
    // mirrors the dev-vault setup where the developer's hostKeyStore /
    // secrets / etc live alongside main.js. The earlier whole-dir
    // symlink approach silently overwrote this file when the shadow
    // vault first wrote its own per-vault settings; per-file install
    // must keep it intact.
    const sourceDataJson = path.join(scratch.sourceDir, 'data.json');
    const sentinel = JSON.stringify({
      hostKeyStore: { 'host:22': 'fingerprint-must-survive' },
      profiles: [{ id: 'source-profile' }],
    });
    fs.writeFileSync(sourceDataJson, sentinel, 'utf-8');

    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    // Source untouched.
    expect(fs.readFileSync(sourceDataJson, 'utf-8')).toBe(sentinel);

    // Shadow has its own data.json. With the merge behaviour added in
    // Phase 4 it inherits the source's hostKeyStore on first
    // bootstrap, but bootstrap-managed fields override anything
    // source had.
    const shadowData = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
    expect(shadowData.activeProfileId).toBe('p1');
    expect(shadowData.hostKeyStore).toEqual({ 'host:22': 'fingerprint-must-survive' });

    // Re-bootstrap and re-check — once was a regression in PR #64,
    // both passes must keep the source data.json intact.
    await r.bootstrap(profile, [profile]);
    expect(fs.readFileSync(sourceDataJson, 'utf-8')).toBe(sentinel);
  });

  it('regression: a stale whole-dir symlink at pluginDir is unlinked, not followed (does not delete source)', async () => {
    // Simulate the pre-fix on-disk state: pluginDir is a symlink to
    // sourceDir. installPlugin must replace this with a real dir
    // without deleting any of the source files.
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const layout = r.layoutFor('p1');
    fs.mkdirSync(path.dirname(layout.pluginDir), { recursive: true });
    try {
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(scratch.sourceDir, layout.pluginDir, linkType);
    } catch (e) {
      // If we can't even create a symlink in the test env, the test
      // can't exercise the relevant cleanup path — bail rather than
      // false-pass. (We always at least install per-file in that case,
      // so the regression isn't reachable.)
      console.warn(`skipping: cannot create symlink in test env: ${(e as Error).message}`);
      return;
    }

    // Stage a unique file in the source so we can detect deletion.
    const sourceCanary = path.join(scratch.sourceDir, 'CANARY.txt');
    fs.writeFileSync(sourceCanary, 'do-not-delete', 'utf-8');

    const profile = makeProfile({ id: 'p1' });
    await r.bootstrap(profile, [profile]);

    // Source file still there.
    expect(fs.existsSync(sourceCanary)).toBe(true);
    expect(fs.readFileSync(sourceCanary, 'utf-8')).toBe('do-not-delete');
    // Plugin dir is now a real dir, not a symlink.
    const stat = fs.lstatSync(layout.pluginDir);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
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
