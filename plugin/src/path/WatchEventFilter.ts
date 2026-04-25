import type { PathMapper } from './PathMapper';

/**
 * Decision returned by `interpretWatchEvent`. Either:
 *  - `null`     — the event should be silently dropped (atomic-write
 *                 artefact, foreign client's private subtree, etc.)
 *  - an object  — the event should be acted on, with `vaultPath`
 *                 already translated back into the form Obsidian
 *                 understands and `remotePath` retained so the
 *                 caller can ask the adapter to invalidate caches.
 */
export interface WatchEventAction {
  /** Path as Obsidian sees it (post `pathMapper.toVault` for our own subtree). */
  vaultPath: string;
  /** Path as the daemon reported it; cache keys are derived from this. */
  remotePath: string;
}

/**
 * Classifies one daemon-emitted `fs.changed` path against the active
 * PathMapper.
 *
 * The function is pure so the rules can be unit-tested without a
 * real RpcClient or vault: callers in `main.ts` just feed in the
 * raw `params.path` and the configured PathMapper.
 */
export function interpretWatchEvent(
  remotePath: string,
  pathMapper: PathMapper | null,
): WatchEventAction | null {
  // Atomic-write tmp files (created by ServerDeployer's atomicWriteFile
  // in tmp+rename) generate their own create/write events. They never
  // belong to vault content, just drop them.
  if (looksLikeAtomicWriteTmp(remotePath)) {
    return null;
  }

  if (!pathMapper) {
    return { vaultPath: remotePath, remotePath };
  }

  const userPrefix = `.obsidian/user/${pathMapper.clientId}/`;
  const anyUserPrefix = '.obsidian/user/';

  if (remotePath.startsWith(userPrefix)) {
    // Our own per-client subtree — translate back so Obsidian sees
    // the vault-canonical path (e.g. .obsidian/workspace.json).
    const vaultPath = pathMapper.toVault(remotePath);
    return { vaultPath, remotePath };
  }

  if (remotePath === '.obsidian/user' || remotePath.startsWith(anyUserPrefix)) {
    // Either the user/ directory itself or another client's subtree.
    // Both are private to other machines; we don't want their state
    // racing through Obsidian's event loop on this side.
    return null;
  }

  // Ordinary vault content: same path on both sides.
  return { vaultPath: remotePath, remotePath };
}

/**
 * Heuristic for the atomic-write tmp files atomicWriteFile drops next
 * to its target during a write. Names follow `.rsh-write-<rand>.tmp`.
 * We match conservatively: the pattern must appear as a basename
 * component, not somewhere mid-string.
 */
function looksLikeAtomicWriteTmp(path: string): boolean {
  const i = path.lastIndexOf('/');
  const name = i < 0 ? path : path.slice(i + 1);
  return name.startsWith('.rsh-write-') && name.endsWith('.tmp');
}
