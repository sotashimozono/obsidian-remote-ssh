import { describe, it, expect } from 'vitest';
import {
  normalizeRemotePath,
  posixJoin,
  relativeTo,
  ensureTrailingSlash,
  toLocalPath,
  toRemotePath,
  expandHome,
} from '../src/util/pathUtils';
import * as nodePath from 'path';

describe('normalizeRemotePath', () => {
  it('strips a leading "~/" so the path becomes home-relative for SFTP', () => {
    expect(normalizeRemotePath('~/work/VaultDev/')).toBe('work/VaultDev');
    expect(normalizeRemotePath('~/.config')).toBe('.config');
  });

  it('rewrites a bare "~" as "."', () => {
    expect(normalizeRemotePath('~')).toBe('.');
  });

  it('leaves absolute paths untouched aside from trailing slashes', () => {
    expect(normalizeRemotePath('/home/alice/vault/')).toBe('/home/alice/vault');
    expect(normalizeRemotePath('/srv/vault')).toBe('/srv/vault');
  });

  it('trims trailing slashes but preserves the root "/"', () => {
    expect(normalizeRemotePath('foo/bar///')).toBe('foo/bar');
    expect(normalizeRemotePath('/')).toBe('/');
  });

  it('does not touch paths that contain "~" mid-string', () => {
    expect(normalizeRemotePath('/home/~weird/stuff')).toBe('/home/~weird/stuff');
  });

  it('trims surrounding whitespace from user input', () => {
    expect(normalizeRemotePath('  ~/work/VaultDev  ')).toBe('work/VaultDev');
  });
});

describe('posixJoin', () => {
  it('joins two parts with a single slash', () => {
    expect(posixJoin('foo', 'bar')).toBe('foo/bar');
  });

  it('collapses multiple slashes at join boundaries', () => {
    expect(posixJoin('foo/', '/bar')).toBe('foo//bar'.replace(/\/+/g, '/'));
    expect(posixJoin('a//b', 'c')).toBe('a/b/c');
  });

  it('joins three or more parts', () => {
    expect(posixJoin('a', 'b', 'c')).toBe('a/b/c');
  });

  it('handles a single part without modification', () => {
    expect(posixJoin('only')).toBe('only');
  });

  it('preserves absolute prefix when first part starts with /', () => {
    expect(posixJoin('/root', 'sub')).toBe('/root/sub');
  });
});

describe('relativeTo', () => {
  it('strips base prefix and the following separator', () => {
    expect(relativeTo('/vault', '/vault/notes/file.md')).toBe('notes/file.md');
  });

  it('strips base prefix when base already ends with slash', () => {
    expect(relativeTo('/vault/', '/vault/notes.md')).toBe('notes.md');
  });

  it('returns full when full does not start with base', () => {
    expect(relativeTo('/other', '/vault/file.md')).toBe('/vault/file.md');
  });

  it('returns empty string when full equals base (no trailing slash)', () => {
    expect(relativeTo('/vault', '/vault')).toBe('');
  });
});

describe('ensureTrailingSlash', () => {
  it('appends slash when missing', () => {
    expect(ensureTrailingSlash('/foo/bar')).toBe('/foo/bar/');
  });

  it('does not add a second slash when already present', () => {
    expect(ensureTrailingSlash('/foo/bar/')).toBe('/foo/bar/');
  });

  it('works on an empty string', () => {
    expect(ensureTrailingSlash('')).toBe('/');
  });
});

describe('toLocalPath', () => {
  it('joins base and relative using OS-native path.join', () => {
    const base = '/local/vault';
    const rel = 'notes/file.md';
    expect(toLocalPath(base, rel)).toBe(nodePath.join(base, rel));
  });
});

describe('toRemotePath', () => {
  it('joins base and relative with posixJoin', () => {
    expect(toRemotePath('work/vault', 'notes/file.md')).toBe('work/vault/notes/file.md');
  });

  it('collapses double slashes at boundary', () => {
    expect(toRemotePath('work/vault/', 'file.md')).toBe('work/vault/file.md');
  });
});

describe('expandHome', () => {
  it('expands "~/" prefix using HOME env var', () => {
    const origHome = process.env.HOME;
    process.env.HOME = '/home/alice';
    try {
      const result = expandHome('~/notes');
      expect(result).toBe(nodePath.join('/home/alice', 'notes'));
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
    }
  });

  it('expands "~/" using USERPROFILE when HOME is unset', () => {
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    process.env.USERPROFILE = 'C:\\Users\\alice';
    try {
      const result = expandHome('~/docs');
      expect(result).toBe(nodePath.join('C:\\Users\\alice', 'docs'));
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
    }
  });

  it('returns the path unchanged when it does not start with "~/"', () => {
    expect(expandHome('/absolute/path')).toBe('/absolute/path');
    expect(expandHome('relative/path')).toBe('relative/path');
    expect(expandHome('~weird')).toBe('~weird');
  });
});
