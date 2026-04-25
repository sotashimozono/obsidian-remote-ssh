import * as os from 'os';

/**
 * Vault-relative paths that hold *client-private* state and must not be
 * shared across machines. They get redirected from `.obsidian/<file>`
 * to `.obsidian/user/<client-id>/<file>` on the remote so two clients
 * can sit on the same vault without trampling each other's UI state.
 *
 * The list errs on the side of "private" because nothing here costs
 * the user anything to keep per-machine, and the alternatives
 * (corrupted layout files, conflicting graph views) are loud failures.
 *
 * Patterns are matched as either an exact vault-relative path or a
 * directory prefix (so `.obsidian/cache` covers everything inside).
 */
export const DEFAULT_PRIVATE_PATTERNS: readonly string[] = [
  '.obsidian/workspace.json',
  '.obsidian/workspace-mobile.json',
  '.obsidian/cache',
  '.obsidian/cache.zlib',
  '.obsidian/types.json',
  '.obsidian/file-recovery.json',
  '.obsidian/graph.json',
  '.obsidian/canvas.json',
];

/**
 * The single directory under `.obsidian/` that we own for per-client
 * subtrees. Listing `.obsidian/` strips this so other clients' state
 * never appears in the vault's UI.
 */
const PRIVATE_ROOT = '.obsidian/user';

/**
 * Sanitize a hostname into something safe to use as a directory name.
 * Keeps ASCII alphanumerics, dots, hyphens, underscores. Replaces
 * everything else with `-`. Empty input yields `'unknown'`.
 */
export function sanitizeClientId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

/**
 * Returns a stable client id derived from the OS hostname. Designed
 * for the single-machine common case; multi-instance setups should
 * pass an explicit override to the PathMapper constructor.
 */
export function defaultClientId(): string {
  try {
    return sanitizeClientId(os.hostname());
  } catch {
    return 'unknown';
  }
}

/**
 * PathMapper translates between the vault-relative paths Obsidian uses
 * and the actual paths we store on the remote. The mapping is the
 * identity for ordinary vault content; only `.obsidian/*` files
 * matched by `DEFAULT_PRIVATE_PATTERNS` (or a caller-supplied
 * extension) are redirected into a per-client subtree.
 *
 * The class is stateless apart from its configuration, so a single
 * instance can serve every adapter call without locking.
 */
export class PathMapper {
  private readonly privateRoot: string;
  private readonly privatePatterns: readonly string[];

  constructor(
    public readonly clientId: string,
    privatePatterns: readonly string[] = DEFAULT_PRIVATE_PATTERNS,
  ) {
    this.privateRoot = `${PRIVATE_ROOT}/${clientId}`;
    this.privatePatterns = privatePatterns;
  }

  // ─── classification ──────────────────────────────────────────────────────

  /** True when the vault-relative path should live in this client's private subtree. */
  isPrivate(vaultPath: string): boolean {
    const normalized = stripLeadingSlash(vaultPath);
    return this.privatePatterns.some(p => normalized === p || normalized.startsWith(p + '/'));
  }

  /**
   * True when the path is the parent of one or more private patterns
   * but not itself private. Listing such a path needs to be merged
   * with this client's private subtree so the patterns appear under
   * their nominal names.
   *
   * In practice the only such path today is `.obsidian/` itself.
   */
  isCrossingPoint(vaultPath: string): boolean {
    const normalized = stripLeadingSlash(vaultPath);
    if (this.isPrivate(normalized)) return false;
    return this.privatePatterns.some(p => parentDirOf(p) === normalized);
  }

  // ─── translation ─────────────────────────────────────────────────────────

  /**
   * Convert a vault-relative path to the path that should be sent to
   * the remote. Identity for non-private paths; redirects private
   * paths into the per-client subtree.
   *
   * Custom patterns are expected to live under `.obsidian/` so the
   * redirect lands inside the per-client subtree cleanly; a pattern
   * outside that prefix is accepted but its full original path is
   * appended verbatim (so `.foo` becomes `.obsidian/user/<id>/.foo`).
   */
  toRemote(vaultPath: string): string {
    const normalized = stripLeadingSlash(vaultPath);
    if (!this.isPrivate(normalized)) return vaultPath;
    const rest = normalized.startsWith('.obsidian/')
      ? normalized.slice('.obsidian/'.length)
      : normalized;
    return `${this.privateRoot}/${rest}`;
  }

  /**
   * Inverse: take a path that came back from the remote (e.g. an
   * entry name during a list merge) and convert it back to the path
   * Obsidian thinks it's reading. Foreign clients' subtrees are
   * preserved unchanged so callers can decide whether to filter them.
   */
  toVault(remotePath: string): string {
    const prefix = `${this.privateRoot}/`;
    if (remotePath.startsWith(prefix)) {
      return `.obsidian/${remotePath.slice(prefix.length)}`;
    }
    return remotePath;
  }

  // ─── listing helpers ─────────────────────────────────────────────────────

  /**
   * Plan a `list(vaultPath)` execution.
   *
   * The returned `primary` is always queried. When `mergeFromUser` is
   * true the caller should also list `userSubtree` and concatenate;
   * `hideUserDirName`, when set, names a directory entry that should
   * be dropped from the primary listing (the "user" sibling under
   * `.obsidian/`).
   */
  resolveListing(vaultPath: string): {
    primary: string;
    mergeFromUser: boolean;
    userSubtree?: string;
    hideUserDirName?: string;
  } {
    const normalized = stripLeadingSlash(vaultPath);
    if (this.isPrivate(normalized)) {
      // The whole subtree lives in user/<id>/...
      return { primary: this.toRemote(vaultPath), mergeFromUser: false };
    }
    if (this.isCrossingPoint(normalized)) {
      return {
        primary: vaultPath,
        mergeFromUser: true,
        userSubtree: this.privateRoot,
        // Hide the `user` directory entry from the primary listing so
        // other clients' subtrees never surface.
        hideUserDirName: 'user',
      };
    }
    return { primary: vaultPath, mergeFromUser: false };
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function stripLeadingSlash(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}

function parentDirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
