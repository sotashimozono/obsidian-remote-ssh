import { describe, it, expect } from 'vitest';
import { PathMapper, sanitizeClientId, DEFAULT_PRIVATE_PATTERNS } from '../src/path/PathMapper';

const ID = 'host-a';

describe('sanitizeClientId', () => {
  it('passes through ASCII alphanumerics + dot/hyphen/underscore', () => {
    expect(sanitizeClientId('GERMI')).toBe('GERMI');
    expect(sanitizeClientId('node-1.local_2')).toBe('node-1.local_2');
  });

  it('replaces unsafe characters with hyphen and trims them at the edges', () => {
    expect(sanitizeClientId('host with spaces')).toBe('host-with-spaces');
    expect(sanitizeClientId('!!evil!!')).toBe('evil');
  });

  it('falls back to "unknown" when the input is empty after sanitisation', () => {
    expect(sanitizeClientId('')).toBe('unknown');
    expect(sanitizeClientId('!!!')).toBe('unknown');
  });
});

describe('PathMapper.isPrivate', () => {
  const m = new PathMapper(ID);

  it('matches the canonical private files', () => {
    expect(m.isPrivate('.obsidian/workspace.json')).toBe(true);
    expect(m.isPrivate('.obsidian/cache.zlib')).toBe(true);
    expect(m.isPrivate('.obsidian/types.json')).toBe(true);
  });

  it('matches inside a private directory pattern', () => {
    expect(m.isPrivate('.obsidian/cache/index')).toBe(true);
    expect(m.isPrivate('.obsidian/cache/sub/x.bin')).toBe(true);
  });

  it('rejects sibling paths that share a prefix', () => {
    expect(m.isPrivate('.obsidian/cache.zlib2')).toBe(false);
    expect(m.isPrivate('.obsidian/workspace.json.bak')).toBe(false);
  });

  it('rejects regular vault content', () => {
    expect(m.isPrivate('Notes/foo.md')).toBe(false);
    expect(m.isPrivate('.obsidian/hotkeys.json')).toBe(false);
    expect(m.isPrivate('.obsidian/plugins/myplugin/data.json')).toBe(false);
  });

  it('tolerates a leading slash on the input', () => {
    expect(m.isPrivate('/.obsidian/workspace.json')).toBe(true);
  });
});

describe('PathMapper.isCrossingPoint', () => {
  it('flags `.obsidian/` because every private pattern lives directly under it', () => {
    const m = new PathMapper(ID);
    expect(m.isCrossingPoint('.obsidian')).toBe(true);
  });

  it('does not flag the private dirs themselves (those are private, not crossing)', () => {
    const m = new PathMapper(ID);
    expect(m.isCrossingPoint('.obsidian/cache')).toBe(false);
    expect(m.isCrossingPoint('.obsidian/workspace.json')).toBe(false);
  });

  it('does not flag unrelated parents', () => {
    const m = new PathMapper(ID);
    expect(m.isCrossingPoint('Notes')).toBe(false);
    expect(m.isCrossingPoint('')).toBe(false);
  });
});

describe('PathMapper.toRemote / toVault', () => {
  const m = new PathMapper(ID);

  it('redirects private files into the per-client subtree', () => {
    expect(m.toRemote('.obsidian/workspace.json'))
      .toBe('.obsidian/user/host-a/workspace.json');
    expect(m.toRemote('.obsidian/cache/foo.bin'))
      .toBe('.obsidian/user/host-a/cache/foo.bin');
  });

  it('passes non-private paths through unchanged', () => {
    expect(m.toRemote('Notes/foo.md')).toBe('Notes/foo.md');
    expect(m.toRemote('.obsidian/hotkeys.json')).toBe('.obsidian/hotkeys.json');
    expect(m.toRemote('.obsidian')).toBe('.obsidian');
  });

  it('toVault inverts a redirected path back to its vault-relative form', () => {
    expect(m.toVault('.obsidian/user/host-a/workspace.json'))
      .toBe('.obsidian/workspace.json');
    expect(m.toVault('.obsidian/user/host-a/cache/foo.bin'))
      .toBe('.obsidian/cache/foo.bin');
  });

  it('leaves another client\'s subtree alone (so the caller can filter it out)', () => {
    expect(m.toVault('.obsidian/user/host-b/workspace.json'))
      .toBe('.obsidian/user/host-b/workspace.json');
  });

  it('uses the configured client id for the redirect prefix', () => {
    const other = new PathMapper('SomeBox');
    expect(other.toRemote('.obsidian/workspace.json'))
      .toBe('.obsidian/user/SomeBox/workspace.json');
  });
});

describe('PathMapper.resolveListing', () => {
  const m = new PathMapper(ID);

  it('asks the caller to merge `.obsidian` with the user subtree, hiding the user/ dir', () => {
    const r = m.resolveListing('.obsidian');
    expect(r.primary).toBe('.obsidian');
    expect(r.mergeFromUser).toBe(true);
    expect(r.userSubtree).toBe('.obsidian/user/host-a');
    expect(r.hideUserDirName).toBe('user');
  });

  it('redirects a list of a private directory entirely', () => {
    const r = m.resolveListing('.obsidian/cache');
    expect(r.primary).toBe('.obsidian/user/host-a/cache');
    expect(r.mergeFromUser).toBe(false);
  });

  it('passes ordinary listings through', () => {
    const r = m.resolveListing('Notes');
    expect(r.primary).toBe('Notes');
    expect(r.mergeFromUser).toBe(false);
  });

  it('passes `.obsidian/plugins` through unmerged (not a crossing point under default patterns)', () => {
    const r = m.resolveListing('.obsidian/plugins');
    expect(r.primary).toBe('.obsidian/plugins');
    expect(r.mergeFromUser).toBe(false);
  });
});

describe('PathMapper with custom patterns', () => {
  it('respects caller-supplied private patterns instead of the defaults', () => {
    // Patterns must live under .obsidian/ so they redirect cleanly into the
    // per-client subtree; this test extends the list with a hypothetical
    // graph-experimental.json that ships with a future Obsidian version.
    const m = new PathMapper(ID, ['.obsidian/graph-experimental.json']);
    expect(m.isPrivate('.obsidian/graph-experimental.json')).toBe(true);
    expect(m.isPrivate('.obsidian/workspace.json')).toBe(false); // not in custom list
    expect(m.toRemote('.obsidian/graph-experimental.json'))
      .toBe('.obsidian/user/host-a/graph-experimental.json');
  });

  it('exports a stable default pattern list', () => {
    expect(DEFAULT_PRIVATE_PATTERNS).toContain('.obsidian/workspace.json');
    expect(DEFAULT_PRIVATE_PATTERNS).toContain('.obsidian/cache');
  });
});
