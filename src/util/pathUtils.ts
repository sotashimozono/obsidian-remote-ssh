import * as path from 'path';

export function posixJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}

export function relativeTo(base: string, full: string): string {
  if (!full.startsWith(base)) return full;
  return full.slice(base.endsWith('/') ? base.length : base.length + 1);
}

export function ensureTrailingSlash(p: string): string {
  return p.endsWith('/') ? p : p + '/';
}

export function toLocalPath(localBase: string, relativePath: string): string {
  return path.join(localBase, relativePath);
}

export function toRemotePath(remoteBase: string, relativePath: string): string {
  return posixJoin(remoteBase, relativePath);
}

export function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return path.join(home, p.slice(2));
  }
  return p;
}

/**
 * Normalize a remote path before sending it to SFTP.
 * - SFTP servers (OpenSSH) do not expand `~`; the SFTP working directory at
 *   session start is already the user's home, so `~/foo/bar` is rewritten as
 *   the home-relative `foo/bar`.
 * - A bare `~` is rewritten as `.` (current dir = home).
 * - Trailing slashes are trimmed (except for the root `/`) so that joining
 *   the base with vault-relative subpaths produces a single separator.
 */
export function normalizeRemotePath(p: string): string {
  let r = p.trim();
  if (r.startsWith('~/')) r = r.slice(2);
  else if (r === '~') r = '.';
  while (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  return r;
}
