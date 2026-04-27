import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ObsidianRegistry } from '../src/shadow/ObsidianRegistry';

/**
 * Tests run against a tmp file the test owns end-to-end so we never
 * touch the real `obsidian.json` on the developer's machine.
 */
function makeTmpConfigPath(): string {
  return path.join(os.tmpdir(), `obsidian-remote-ssh-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe('ObsidianRegistry.defaultConfigPath', () => {
  it('returns an OS-appropriate path that ends with obsidian/obsidian.json', () => {
    const p = ObsidianRegistry.defaultConfigPath();
    expect(p.endsWith(path.join('obsidian', 'obsidian.json'))).toBe(true);
  });

  it('resolves under the current $HOME, not a hardcoded user dir', () => {
    // Whatever the OS shape, the result must be anchored at the
    // running user's home — confirms we picked it up from
    // os.homedir() / env vars rather than baking a literal path in.
    const p = ObsidianRegistry.defaultConfigPath();
    expect(p).toContain(os.homedir());
  });
});

describe('ObsidianRegistry', () => {
  let configPath: string;

  beforeEach(() => {
    configPath = makeTmpConfigPath();
  });

  afterEach(() => {
    try { fs.unlinkSync(configPath); } catch { /* may not exist */ }
  });

  it('reads an existing config preserving unknown top-level keys', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      vaults: { abc: { path: '/some/vault', ts: 100 } },
      adblock: ['https://easylist.to/easylist/easylist.txt'],
      cli: true,
    }));
    const r = new ObsidianRegistry(configPath);
    const cfg = r.read();
    expect(cfg.vaults).toEqual({ abc: { path: '/some/vault', ts: 100 } });
    expect(cfg.adblock).toEqual(['https://easylist.to/easylist/easylist.txt']);
    expect(cfg.cli).toBe(true);
  });

  it('synthesises an empty vaults map if the file lacks one', () => {
    fs.writeFileSync(configPath, JSON.stringify({ adblock: [] }));
    const cfg = new ObsidianRegistry(configPath).read();
    expect(cfg.vaults).toEqual({});
    expect(cfg.adblock).toEqual([]);
  });

  it('register() adds a new vault with a 16-hex-char id and a current ts', () => {
    fs.writeFileSync(configPath, JSON.stringify({ vaults: {} }));
    const r = new ObsidianRegistry(configPath);
    const before = Date.now();
    const { id, created } = r.register('/path/to/shadow');
    const after = Date.now();

    expect(created).toBe(true);
    expect(id).toMatch(/^[0-9a-f]{16}$/);

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(cfg.vaults[id].path).toBe('/path/to/shadow');
    expect(cfg.vaults[id].ts).toBeGreaterThanOrEqual(before);
    expect(cfg.vaults[id].ts).toBeLessThanOrEqual(after);
  });

  it('register() is idempotent: same path returns the existing id and does not rewrite', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      vaults: { existing: { path: '/path/to/shadow', ts: 12345 } },
    }));
    const r = new ObsidianRegistry(configPath);
    const before = fs.statSync(configPath).mtimeMs;
    const { id, created } = r.register('/path/to/shadow');
    expect(id).toBe('existing');
    expect(created).toBe(false);
    const after = fs.statSync(configPath).mtimeMs;
    expect(after).toBe(before);  // file untouched
  });

  it('register() preserves all other vaults untouched when adding a new one', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      vaults: {
        v1: { path: '/vault/one', ts: 100, open: true },
        v2: { path: '/vault/two', ts: 200 },
      },
      adblock: ['x'],
    }));
    const r = new ObsidianRegistry(configPath);
    const { id } = r.register('/vault/three');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(cfg.vaults.v1).toEqual({ path: '/vault/one', ts: 100, open: true });
    expect(cfg.vaults.v2).toEqual({ path: '/vault/two', ts: 200 });
    expect(cfg.vaults[id].path).toBe('/vault/three');
    expect(cfg.adblock).toEqual(['x']);
  });

  it('register() canonicalises trailing slash so the same vault is recognised', () => {
    // Use OS-native separator so path.resolve treats both as the same.
    const base = path.resolve(os.tmpdir(), 'fake-vault-canonical');
    const withSlash = base + path.sep;
    fs.writeFileSync(configPath, JSON.stringify({
      vaults: { v: { path: base, ts: 100 } },
    }));
    const r = new ObsidianRegistry(configPath);
    const out = r.register(withSlash);
    expect(out.created).toBe(false);
    expect(out.id).toBe('v');
  });

  it('register() treats Windows paths case-insensitively', () => {
    if (process.platform !== 'win32') return;  // case-sensitive elsewhere
    fs.writeFileSync(configPath, JSON.stringify({
      vaults: { v: { path: 'C:\\Users\\Alice\\Vault', ts: 100 } },
    }));
    const r = new ObsidianRegistry(configPath);
    const out = r.register('c:\\users\\alice\\vault');
    expect(out.created).toBe(false);
    expect(out.id).toBe('v');
  });

  it('register() writes atomically — no .tmp-* file remains after success', () => {
    fs.writeFileSync(configPath, JSON.stringify({ vaults: {} }));
    const r = new ObsidianRegistry(configPath);
    r.register('/path/one');
    const dir = path.dirname(configPath);
    const tmps = fs.readdirSync(dir).filter(f => f.startsWith(path.basename(configPath) + '.tmp-'));
    expect(tmps).toEqual([]);
  });
});
