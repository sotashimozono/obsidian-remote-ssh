import * as http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes, timingSafeEqual } from 'crypto';
import { logger } from '../util/logger';

/**
 * Async fetcher for vault binary content. The bridge calls this with a
 * vault-relative path; the implementation goes through whatever adapter
 * + cache + transport stack the plugin is using.
 */
export type FetchBinaryFn = (vaultPath: string) => Promise<Uint8Array>;

export interface StartResult {
  port: number;
  /** Hex token embedded in every URL the bridge hands out. */
  token: string;
}

/**
 * Localhost HTTP server that serves binary vault assets to Obsidian's
 * webview so `<img>`, `<iframe>`, `<audio>`, etc. can render content
 * that lives on a remote host.
 *
 * The server binds to 127.0.0.1 on an OS-assigned random port. Every
 * URL embeds a token that's regenerated on each `start()` so a leaked
 * URL from a prior session can't replay against a new one.
 *
 * The server is intentionally minimal: GET requests only, no Range,
 * full body in memory (the underlying readBinary already loads the
 * whole file). Phase 6-B can add streaming + Range when large PDFs
 * become a real pain point.
 */
export class ResourceBridge {
  private server: http.Server | null = null;
  private token: string | null = null;
  private port: number | null = null;
  private fetchBinary: FetchBinaryFn | null = null;

  /**
   * Start the HTTP server and return the chosen port + token. Calling
   * `start` while already running is an error; `stop` first.
   */
  async start(fetchBinary: FetchBinaryFn): Promise<StartResult> {
    if (this.server) {
      throw new Error('ResourceBridge already started');
    }
    this.token = randomBytes(32).toString('hex');
    this.fetchBinary = fetchBinary;

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = server;

    return new Promise<StartResult>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server = null;
        this.token = null;
        this.fetchBinary = null;
        reject(err);
      };
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const addr = server.address() as AddressInfo;
        this.port = addr.port;
        logger.info(`ResourceBridge: listening on 127.0.0.1:${addr.port}`);
        resolve({ port: addr.port, token: this.token! });
      });
    });
  }

  /** Stop the HTTP server. Safe to call when not running. */
  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.token = null;
    this.port = null;
    this.fetchBinary = null;

    return new Promise<void>(resolve => {
      // Force-close any in-flight responses so we don't hang on a slow
      // remote read while the user is reloading the plugin.
      try {
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      } catch { /* older Node: best-effort */ }
      server.close(() => resolve());
    });
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * URL Obsidian's webview should hit to retrieve `vaultPath`. The
   * bridge must already be started; the path is the vault-canonical
   * form (post `PathMapper.toVault`) — translation back to the
   * per-client subtree is handled by the `fetchBinary` callback when
   * it goes through `SftpDataAdapter.readBinary`.
   */
  urlFor(vaultPath: string): string {
    if (!this.server || !this.token || this.port === null) {
      throw new Error('ResourceBridge not started');
    }
    const encoded = encodeURIComponent(vaultPath);
    return `http://127.0.0.1:${this.port}/r/${this.token}?p=${encoded}`;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Allow': 'GET, HEAD' }).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = /^\/r\/([0-9a-f]+)$/.exec(url.pathname);
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    const tokenInUrl = m[1];
    if (!this.token || !constantTimeEqualHex(tokenInUrl, this.token)) {
      res.writeHead(401).end();
      return;
    }
    const rawPath = url.searchParams.get('p');
    if (rawPath === null || rawPath === '') {
      res.writeHead(400).end('missing p');
      return;
    }
    if (!isSafeVaultPath(rawPath)) {
      res.writeHead(400).end('bad path');
      return;
    }

    const fetchBinary = this.fetchBinary;
    if (!fetchBinary) {
      res.writeHead(503).end();
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = await fetchBinary(rawPath);
    } catch (e) {
      logger.warn(`ResourceBridge: read failed for "${rawPath}": ${(e as Error).message}`);
      res.writeHead(404).end();
      return;
    }

    const contentType = guessMimeType(rawPath);
    const total = bytes.byteLength;

    // Range support. We always advertise byte ranges in 200 responses;
    // when the client asks for a range we respond with 206 and a
    // sliced body. Note: we still load the *full* bytes through
    // fetchBinary above — true partial reads would need
    // `fs.readBinaryRange` in the daemon protocol (Phase 6-B.2).
    // ReadCache means repeated range requests for the same file
    // don't re-read across the SSH link as long as it fits.
    const rangeHeader = req.headers.range;
    const parsed = rangeHeader ? parseRangeHeader(rangeHeader, total) : 'none';

    if (parsed === 'invalid') {
      res.writeHead(416, {
        'Content-Range': `bytes */${total}`,
        'Cache-Control': 'no-store',
      }).end();
      return;
    }

    if (parsed === 'none') {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': total,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      }
      return;
    }

    const { start, end } = parsed;
    const sliceLen = end - start + 1;
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': sliceLen,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      const slice = bytes.subarray(start, end + 1);
      res.end(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
    }
  }
}

/**
 * Parse an HTTP `Range:` header against a known total resource size.
 * Pure function so the rules can be unit-tested without spinning up
 * a server.
 *
 * Returns:
 *   - `'invalid'` for syntactically broken or out-of-range requests
 *     (caller should reply 416 with `Content-Range: bytes *\/total`)
 *   - `{start, end}` for a satisfiable single-range request (caller
 *     should reply 206 with `Content-Range: bytes start-end/total`)
 *
 * Multi-range (`bytes=0-50,100-150`) is intentionally rejected as
 * invalid — the webview only ever asks for one range at a time, and
 * supporting multipart/byteranges is a much bigger change.
 *
 * Forms understood (mirroring RFC 7233):
 *   - `bytes=N-M`      — explicit start and end (inclusive)
 *   - `bytes=N-`       — from N to the end of the resource
 *   - `bytes=-N`       — last N bytes (a "suffix" range)
 */
export function parseRangeHeader(
  headerValue: string,
  totalSize: number,
): { start: number; end: number } | 'invalid' {
  if (totalSize <= 0) return 'invalid';
  const m = /^bytes=(\d*)-(\d*)$/.exec(headerValue.trim());
  if (!m) return 'invalid';
  const startStr = m[1];
  const endStr = m[2];
  let start: number;
  let end: number;
  if (startStr === '' && endStr === '') return 'invalid';
  if (startStr === '') {
    // Suffix range: last N bytes.
    const n = parseInt(endStr, 10);
    if (!Number.isFinite(n) || n <= 0) return 'invalid';
    start = Math.max(0, totalSize - n);
    end = totalSize - 1;
  } else if (endStr === '') {
    start = parseInt(startStr, 10);
    end = totalSize - 1;
  } else {
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start < 0 || start >= totalSize) return 'invalid';
  if (end < start) return 'invalid';
  // Spec allows clamping a too-large end; do so.
  if (end >= totalSize) end = totalSize - 1;
  return { start, end };
}

/**
 * Constant-time hex comparison. timingSafeEqual itself requires equal
 * lengths and Buffer inputs; we guard the length first since a length
 * mismatch on tokens of different sizes would throw.
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Reject anything that could escape the vault root. Vault-relative
 * paths shouldn't begin with `/` and shouldn't contain `..` segments;
 * NULs are filesystem traps regardless of platform.
 */
function isSafeVaultPath(p: string): boolean {
  if (p.includes('\0')) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  for (const part of p.split(/[\\/]+/)) {
    if (part === '..') return false;
  }
  return true;
}

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',

  pdf: 'application/pdf',

  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  opus: 'audio/opus',

  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',

  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md:  'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm:  'text/html; charset=utf-8',
  css:  'text/css; charset=utf-8',
  js:   'application/javascript; charset=utf-8',
  xml:  'application/xml; charset=utf-8',
};

function guessMimeType(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext = path.slice(dot + 1).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}
