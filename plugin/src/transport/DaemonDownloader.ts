import * as path from 'path';
import { createHash } from 'crypto';

/**
 * Runtime acquisition of the Go daemon binary.
 *
 * The Obsidian community store ships only `main.js` / `manifest.json` /
 * `styles.css`, so the daemon binary can't ride along in the plugin
 * package. Instead we fetch the right per-arch binary from the plugin's
 * GitHub release on first RPC connect, verify it against the release's
 * `daemon-manifest.json` (sha256), and cache it under the plugin folder's
 * `server-bin/`. Subsequent connects hit the local cache.
 *
 * Unsupported remote arches (or download/verify failure) let the caller
 * downgrade to the SFTP transport rather than hard-failing.
 */

export type DaemonOs = 'linux' | 'darwin';
export type DaemonArch = 'amd64' | 'arm64';

export interface DaemonTarget {
  os: DaemonOs;
  arch: DaemonArch;
}

export interface DaemonDownloaderDeps {
  /** Fetch a release asset as bytes (Obsidian `requestUrl` arraybuffer). */
  fetchBinary: (url: string) => Promise<Uint8Array>;
  /** Fetch a release asset as text (the manifest JSON). */
  fetchText: (url: string) => Promise<string>;
  /** Absolute path to the plugin's `server-bin/` cache dir. */
  cacheDir: string;
  /** Persist downloaded bytes to disk and mark executable (chmod +x). */
  writeExecutable: (absPath: string, bytes: Uint8Array) => Promise<void>;
  /** True if a cached file already exists. */
  cacheHit: (absPath: string) => boolean;
  /** `owner/repo` for the release URL. */
  repo: string;
  /** Release tag to fetch from (= plugin version, e.g. `1.1.3`). */
  version: string;
}

const BINARY_PREFIX = 'obsidian-remote-server';
const MANIFEST_NAME = 'daemon-manifest.json';

export function binaryFilename(t: DaemonTarget): string {
  return `${BINARY_PREFIX}-${t.os}-${t.arch}`;
}

/**
 * Map `uname -s` / `uname -m` output to our release arch tuple. Returns
 * null for anything we don't ship a binary for (Windows server, FreeBSD,
 * 32-bit, …) so the caller downgrades to SFTP.
 */
export function parseUname(unameS: string, unameM: string): DaemonTarget | null {
  const s = unameS.trim().toLowerCase();
  const m = unameM.trim().toLowerCase();
  let os: DaemonOs;
  if (s === 'linux') os = 'linux';
  else if (s === 'darwin') os = 'darwin';
  else return null;
  let arch: DaemonArch;
  if (m === 'x86_64' || m === 'amd64') arch = 'amd64';
  else if (m === 'aarch64' || m === 'arm64') arch = 'arm64';
  else return null;
  return { os, arch };
}

/**
 * Detect the remote host's os/arch via `uname`. Queried as two separate
 * commands (`uname -s`, `uname -m`) because not every remote shell accepts
 * the combined `uname -s -m` form consistently.
 */
export async function detectRemoteTarget(
  exec: (cmd: string) => Promise<string>,
): Promise<DaemonTarget | null> {
  const s = await exec('uname -s');
  const m = await exec('uname -m');
  return parseUname(s, m);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Thrown when a downloaded binary fails sha256 verification. */
export class DaemonVerificationError extends Error {}

/**
 * Ensure a local daemon binary for the remote's arch, downloading and
 * verifying from the GitHub release if it isn't already cached. Returns the
 * absolute local path.
 *
 * Throws {@link DaemonVerificationError} on a sha256 mismatch or a missing
 * manifest entry — we never hand back an unverified binary for deployment.
 */
export async function ensureDaemonBinary(
  deps: DaemonDownloaderDeps,
  target: DaemonTarget,
): Promise<string> {
  const filename = binaryFilename(target);
  const dest = path.join(deps.cacheDir, filename);
  if (deps.cacheHit(dest)) return dest;

  const base = `https://github.com/${deps.repo}/releases/download/${deps.version}`;

  const manifestRaw = await deps.fetchText(`${base}/${MANIFEST_NAME}`);
  let manifest: Record<string, string>;
  try {
    manifest = JSON.parse(manifestRaw) as Record<string, string>;
  } catch (e) {
    throw new DaemonVerificationError(
      `${MANIFEST_NAME} is not valid JSON (release ${deps.version}): ${(e as Error).message}`,
    );
  }
  const expected = manifest[filename];
  if (!expected) {
    throw new DaemonVerificationError(
      `${MANIFEST_NAME} has no entry for ${filename} (release ${deps.version})`,
    );
  }

  const bytes = await deps.fetchBinary(`${base}/${filename}`);
  const got = sha256Hex(bytes);
  if (got !== expected.toLowerCase()) {
    throw new DaemonVerificationError(
      `daemon binary sha256 mismatch for ${filename}: expected ${expected}, got ${got}`,
    );
  }

  await deps.writeExecutable(dest, bytes);
  return dest;
}
