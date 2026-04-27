import { describe, it, expect } from 'vitest';
import { normalizeRemotePath } from '../src/util/pathUtils';

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
