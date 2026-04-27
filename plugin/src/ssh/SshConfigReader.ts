import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * One resolved Host entry from `~/.ssh/config`. Returned by
 * `readSshConfig` after applying `Host *` defaults and resolving
 * any `ProxyJump` reference back to its own Host block.
 */
export interface SshConfigEntry {
  alias: string;
  hostname: string;
  user: string;
  port: number;
  identityFile?: string;
  proxyJump?: ProxyJumpEntry;
}

/**
 * The first hop of a `ProxyJump` directive, with the referenced
 * Host alias already inlined when one was found. We only surface
 * the first hop because the SSH layer this plugin uses
 * (ssh2.openssh_forwardOutStreamLocal) opens at most one bastion
 * per session.
 */
export interface ProxyJumpEntry {
  host: string;
  port: number;
  user: string;
  identityFile?: string;
}

interface RawHostBlock {
  /** Specific (non-wildcard) aliases declared on the `Host` line. */
  aliases: string[];
  /** True when this block is the literal `Host *` default block. */
  isDefaults: boolean;
  fields: RawFields;
}

interface RawFields {
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
}

/**
 * Read and resolve the user's `~/.ssh/config` (or a custom path).
 * Returns one entry per concrete Host alias. Wildcards other than
 * the literal `*` are skipped — we don't try to evaluate
 * `Host *.example.com` patterns. Missing or unreadable file → `[]`.
 */
export function readSshConfig(configPath?: string): SshConfigEntry[] {
  const filePath = configPath ?? path.join(os.homedir(), '.ssh', 'config');
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const blocks = parseBlocks(content);
  const defaults = mergeDefaults(blocks);

  const entries: SshConfigEntry[] = [];
  for (const block of blocks) {
    if (block.isDefaults) continue;
    for (const alias of block.aliases) {
      entries.push(buildEntry(alias, block.fields, defaults));
    }
  }

  // Resolve ProxyJump references in a second pass so a forward
  // reference (the bastion declared after the host that uses it)
  // still resolves correctly.
  const aliasMap = new Map(entries.map(e => [e.alias, e]));
  for (const e of entries) {
    if (e.proxyJump) {
      e.proxyJump = resolveProxyJump(e.proxyJump, aliasMap, e.user);
    }
  }

  return entries;
}

// ─── parsing ───────────────────────────────────────────────────────────

function parseBlocks(content: string): RawHostBlock[] {
  const blocks: RawHostBlock[] = [];
  let current: RawHostBlock | null = null;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const ws = line.search(/\s/);
    if (ws === -1) continue;
    const key = line.slice(0, ws).toLowerCase();
    const value = line.slice(ws + 1).trim();

    if (key === 'host') {
      const patterns = value.split(/\s+/).filter(Boolean);
      const aliases = patterns.filter(p => !p.includes('*') && !p.includes('?'));
      const isDefaults = patterns.length === 1 && patterns[0] === '*';
      current = { aliases, isDefaults, fields: {} };
      blocks.push(current);
      continue;
    }

    if (!current) continue;

    switch (key) {
      case 'hostname':     current.fields.hostname = value; break;
      case 'user':         current.fields.user = value; break;
      case 'port':         current.fields.port = parseInt(value, 10) || 22; break;
      case 'identityfile': current.fields.identityFile = expandTilde(value); break;
      case 'proxyjump':    current.fields.proxyJump = value; break;
    }
  }

  return blocks;
}

/**
 * Walk the parsed blocks and compose a single defaults bag from
 * every `Host *` block (later blocks shadow earlier ones, mirroring
 * OpenSSH's "first match wins" semantics applied in declaration
 * order).
 */
function mergeDefaults(blocks: RawHostBlock[]): RawFields {
  const defaults: RawFields = {};
  for (const b of blocks) {
    if (!b.isDefaults) continue;
    if (b.fields.hostname     !== undefined) defaults.hostname     = b.fields.hostname;
    if (b.fields.user         !== undefined) defaults.user         = b.fields.user;
    if (b.fields.port         !== undefined) defaults.port         = b.fields.port;
    if (b.fields.identityFile !== undefined) defaults.identityFile = b.fields.identityFile;
    if (b.fields.proxyJump    !== undefined) defaults.proxyJump    = b.fields.proxyJump;
  }
  return defaults;
}

function buildEntry(
  alias: string,
  fields: RawFields,
  defaults: RawFields,
): SshConfigEntry {
  const hostname     = fields.hostname     ?? defaults.hostname     ?? alias;
  const user         = fields.user         ?? defaults.user         ?? defaultUserName();
  const port         = fields.port         ?? defaults.port         ?? 22;
  const identityFile = fields.identityFile ?? defaults.identityFile;
  const rawJump      = fields.proxyJump    ?? defaults.proxyJump;

  return {
    alias,
    hostname,
    user,
    port,
    identityFile,
    // Note: user/identityFile on proxyJump are left blank-or-explicit
    // here on purpose. The resolution pass in readSshConfig fills them
    // from the referenced alias when available, falling back to the
    // parent host's user when no alias matched.
    proxyJump: rawJump !== undefined ? parseProxyJumpRaw(rawJump) : undefined,
  };
}

// ─── ProxyJump ─────────────────────────────────────────────────────────

/**
 * Parse a `ProxyJump` directive value. The grammar is
 * `[user@]host[:port]` per hop, comma-separated; we keep only the
 * first hop. The result's `user` may be empty — that gap is filled
 * by `resolveProxyJump` (which knows whether to use the referenced
 * alias's user or the parent host's user).
 */
function parseProxyJumpRaw(raw: string): ProxyJumpEntry {
  const first = raw.split(',')[0].trim();
  let rest = first;
  let user = '';

  const at = first.indexOf('@');
  if (at >= 0) {
    user = first.slice(0, at);
    rest = first.slice(at + 1);
  }

  let host = rest;
  let port = 22;
  const colon = rest.indexOf(':');
  if (colon >= 0) {
    host = rest.slice(0, colon);
    port = parseInt(rest.slice(colon + 1), 10) || 22;
  }

  return { host, port, user, identityFile: undefined };
}

/**
 * Fill in missing fields on the parsed ProxyJump entry. If the
 * proxy host matches a declared Host alias, the alias's resolved
 * fields take precedence (mirrors OpenSSH's "ProxyJump references
 * the bastion's Host block" behaviour). When the proxy host is a
 * literal hostname not matching any alias, an empty user falls back
 * to the parent host's user.
 *
 * An explicit `port` or `user` in the ProxyJump line itself always
 * wins over both the referenced alias and the parent fallback.
 */
function resolveProxyJump(
  pj: ProxyJumpEntry,
  aliasMap: Map<string, SshConfigEntry>,
  parentUser: string,
): ProxyJumpEntry {
  const referenced = aliasMap.get(pj.host);
  if (!referenced) {
    return { ...pj, user: pj.user || parentUser };
  }
  return {
    host: referenced.hostname,
    port: pj.port !== 22 ? pj.port : referenced.port,
    user: pj.user || referenced.user,
    identityFile: referenced.identityFile,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────

function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaultUserName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}
