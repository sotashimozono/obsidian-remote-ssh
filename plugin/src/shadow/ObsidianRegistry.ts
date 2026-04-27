import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

/**
 * One entry in `obsidian.json`'s `vaults` map.
 */
export interface VaultRegistryEntry {
  path: string;
  ts: number;
  open?: boolean;
}

/**
 * Shape of `obsidian.json`. Unknown keys are preserved verbatim on
 * write — Obsidian stores ad-hoc settings (adblock lists, cli flag,
 * ...) at the top level and we must not silently drop them.
 */
export interface ObsidianConfig {
  vaults: Record<string, VaultRegistryEntry>;
  [key: string]: unknown;
}

/**
 * Reads/writes Obsidian's per-user `obsidian.json` — the file the
 * desktop app keeps the list of known vaults in. We need to register
 * the shadow vault path here so Obsidian's `obsidian://open?path=…`
 * URL handler treats the path as a known vault and opens it directly
 * instead of showing a vault picker.
 *
 * Per-OS default location:
 *
 * | OS      | Path                                                       |
 * |---------|------------------------------------------------------------|
 * | Windows | `%APPDATA%\obsidian\obsidian.json`                         |
 * | macOS   | `~/Library/Application Support/obsidian/obsidian.json`     |
 * | Linux   | `$XDG_CONFIG_HOME/obsidian/obsidian.json` (default `~/.config`) |
 *
 * Schema (only the parts we touch):
 *
 *   {
 *     "vaults": {
 *       "<hex16>": { "path": "...", "ts": <millis>, "open"?: true }
 *     },
 *     ...other keys we leave alone...
 *   }
 *
 * The class never reads or modifies fields outside `vaults`, and
 * never deletes vault entries — strictly additive registration.
 */
export class ObsidianRegistry {
  constructor(private readonly configPath: string) {}

  /**
   * Default per-OS path to Obsidian's `obsidian.json`. Computed from
   * env vars / `os.homedir()` at runtime — never hardcoded to a
   * specific user's directory.
   */
  static defaultConfigPath(): string {
    if (process.platform === 'win32') {
      const appdata = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appdata, 'obsidian', 'obsidian.json');
    }
    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
    }
    const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
    return path.join(xdgConfig, 'obsidian', 'obsidian.json');
  }

  read(): ObsidianConfig {
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ObsidianConfig> & Record<string, unknown>;
    if (!parsed.vaults || typeof parsed.vaults !== 'object') {
      parsed.vaults = {};
    }
    return parsed as ObsidianConfig;
  }

  /**
   * Register a vault path so Obsidian's URL handler accepts it.
   *
   * Behaviour:
   * - If the path is already registered (by exact match after
   *   normalisation), returns that existing id with `created: false`
   *   and leaves `obsidian.json` untouched.
   * - Otherwise generates a fresh hex16 id, adds the entry with
   *   `ts = Date.now()`, and atomically rewrites `obsidian.json`.
   *
   * Returns the id Obsidian will use to refer to the vault.
   */
  register(vaultPath: string): { id: string; created: boolean } {
    const cfg = this.read();
    const target = canonicalisePath(vaultPath);
    for (const [id, entry] of Object.entries(cfg.vaults)) {
      if (canonicalisePath(entry.path) === target) {
        return { id, created: false };
      }
    }
    const id = generateVaultId();
    cfg.vaults[id] = { path: vaultPath, ts: Date.now() };
    this.writeAtomic(cfg);
    return { id, created: true };
  }

  /**
   * Atomic write: serialise to a sibling temp file, then rename.
   * Limits the window during which Obsidian could read a half-written
   * `obsidian.json`. Not a full-blown lock — Obsidian could still
   * race with us — but in practice Obsidian writes its config at
   * vault-open / vault-close, both rare events.
   */
  private writeAtomic(cfg: ObsidianConfig): void {
    const tmp = `${this.configPath}.tmp-remote-ssh-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(cfg) + '\n', 'utf-8');
    fs.renameSync(tmp, this.configPath);
  }
}

function generateVaultId(): string {
  // 16 hex chars matches Obsidian's own format (e.g.
  // "12ad228ee37d03b1") so the shadow entries are visually
  // indistinguishable from Obsidian-created ones.
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Canonical form of a filesystem path for the "is this the same
 * vault?" comparison: absolute, trailing separator stripped, and
 * lowercased on Windows (the filesystem is case-insensitive there
 * and Obsidian may store either case in obsidian.json).
 */
function canonicalisePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
