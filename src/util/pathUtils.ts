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
