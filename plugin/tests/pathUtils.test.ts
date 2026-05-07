import { describe, it, expect } from 'vitest';
import {
  ensureTrailingSlash,
  expandHome,
  normalizeRemotePath,
  posixJoin,
  relativeTo,
  toLocalPath,
  toRemotePath,
} from '../src/util/pathUtils';

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

describe('path utility helpers', () => {
  it('posixJoin joins with a single slash', () => {
    expect(posixJoin('a', 'b', 'c')).toBe('a/b/c');
    expect(posixJoin('/a/', '/b//', 'c')).toBe('/a/b/c');
  });

  it('relativeTo returns full path when base does not match', () => {
    expect(relativeTo('/base', '/other/file.md')).toBe('/other/file.md');
  });

  it('relativeTo strips base with or without trailing slash', () => {
    expect(relativeTo('/base', '/base/file.md')).toBe('file.md');
    expect(relativeTo('/base/', '/base/file.md')).toBe('file.md');
  });

  it('ensureTrailingSlash appends only once', () => {
    expect(ensureTrailingSlash('/tmp/work')).toBe('/tmp/work/');
    expect(ensureTrailingSlash('/tmp/work/')).toBe('/tmp/work/');
  });

  it('toLocalPath uses platform-aware path join', () => {
    const result = toLocalPath('/tmp/work', 'docs/a.md');
    expect(result).toContain('docs');
    expect(result.endsWith('docs/a.md') || result.endsWith('docs\\a.md')).toBe(true);
  });

  it('toRemotePath uses posix separator', () => {
    expect(toRemotePath('/srv/vault', 'docs/a.md')).toBe('/srv/vault/docs/a.md');
  });

  it('expandHome expands "~/" using HOME', () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = '/home/alice';
      process.env.USERPROFILE = '';
      expect(expandHome('~/vault')).toBe('/home/alice/vault');
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('expandHome leaves non-tilde paths unchanged', () => {
    expect(expandHome('/srv/vault')).toBe('/srv/vault');
  });
});
