import * as http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes, timingSafeEqual } from 'crypto';
import { logger } from '../util/logger';
import { isPreconditionFailed } from '../proto/rpcError';
import { errorMessage } from "../util/errorMessage";

/**
 * Async fetcher for vault binary content. The bridge calls this with a
 * vault-relative path; the implementation goes through whatever adapter
 * + cache + transport stack the plugin is using.
 */
export type FetchBinaryFn = (vaultPath: string) => Promise<Uint8Array>;

/**
 * Async fetcher for partial binary reads. Optional: the bridge falls
 * back to {@link FetchBinaryFn} + post-fetch slicing when a request
 * carries a `Range:` header but no range fetcher was wired (= SFTP
 * transport, or a daemon that doesn't advertise `fs.readBinaryRange`).
 *
 * `bytes` may be shorter than the requested `length` when the request
 * runs past EOF; the bridge uses `totalSize` to build the
 * `Content-Range: bytes start-end/<total>` header regardless of how
 * much was actually returned. `mtime` is the source file's mtime at
 * read time, threaded back as `expectedMtime` on follow-up requests
 * so a mid-scrub edit invalidates cleanly (#171).
 *
 * `expectedMtime`, when set, asks the implementation to reject the
 * read with `PreconditionFailed` (-32020) if the remote mtime no
 * longer matches. The bridge passes the cached mtime here on
 * follow-up requests for the same path; on rejection it drops the
 * cache entry and re-issues with `expectedMtime: undefined` so the
 * webview gets a fresh slice rather than a stale one.
 */
export type FetchBinaryRangeFn = (
  vaultPath: string,
  offset: number,
  length: number,
  expectedMtime?: number,
) => Promise<{ bytes: Uint8Array; mtime: number; totalSize: number }>;

/**
 * Async fetcher for daemon-resized image thumbnails. Optional: the
 * bridge falls back to `FetchBinaryFn` when the request asks for a
 * thumbnail but no fetcher is wired (= SFTP transport, or a daemon
 * that doesn't advertise `fs.thumbnail`).
 *
 * The returned `format` lets the bridge set the right MIME type
 * without re-sniffing; PNG is used when the source had alpha so
 * transparency survives.
 */
export type FetchThumbnailFn = (
  vaultPath: string,
  maxDim: number,
) => Promise<{ bytes: Uint8Array; format: 'jpeg' | 'png' }>;

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
/**
 * TTL in ms for entries in the per-path mtime cache. After this much
 * time has elapsed since the last hit the entry is treated as stale
 * and the next range request goes out without `expectedMtime`. 30 s
 * is short enough that an idle scrubbing session doesn't pin
 * arbitrarily-old generations and long enough to cover the typical
 * "scrub a video for a minute" usage pattern. #171.
 */
const MTIME_CACHE_TTL_MS = 30_000;

/**
 * Maximum number of paths kept in the mtime cache. A small cap is
 * enough because the cache is sized to "currently-being-scrubbed
 * media files", which is one or two at a time in practice. When
 * full, the least-recently-used entry is evicted. #171.
 */
const MTIME_CACHE_MAX_ENTRIES = 64;

interface MtimeCacheEntry {
  mtime: number;
  /** Wall-clock ms (`Date.now()`) of the most recent read or write. */
  lastUsed: number;
}

export class ResourceBridge {
  private server: http.Server | null = null;
  private token: string | null = null;
  private port: number | null = null;
  private fetchBinary: FetchBinaryFn | null = null;
  private fetchThumbnail: FetchThumbnailFn | null = null;
  private fetchBinaryRange: FetchBinaryRangeFn | null = null;

  /**
   * Per-path mtime cache for the range fast path (#171). The first
   * range request for a path goes out without `expectedMtime` and
   * caches the daemon's reported mtime; subsequent requests pin to
   * that mtime so the daemon rejects (with `PreconditionFailed`)
   * any slice from a newer file generation rather than silently
   * returning a mismatched mid-stream chunk. On rejection the
   * bridge drops the entry and re-issues without `expectedMtime`,
   * caching the new mtime — so a mid-scrub edit takes one extra
   * round-trip but never produces a corrupt response.
   *
   * Bounded by {@link MTIME_CACHE_MAX_ENTRIES}; entries older than
   * {@link MTIME_CACHE_TTL_MS} since their last hit are treated as
   * stale on read. Cleared on `stop()`.
   */
  private mtimeCache = new Map<string, MtimeCacheEntry>();

  /**
   * Start the HTTP server and return the chosen port + token. Calling
   * `start` while already running is an error; `stop` first.
   *
   * `fetchThumbnail` is optional: when supplied, requests with a
   * `?thumb=N` query string get served from the daemon's resize path;
   * when omitted, the bridge falls back to `fetchBinary` for the same
   * URL (so the webview's `<img>` still renders, just without the
   * bandwidth + CPU savings).
   *
   * `fetchBinaryRange` is optional: when supplied, requests with a
   * `Range:` header are served from a single `fs.readBinaryRange` RPC
   * (= true partial read, no full-file allocation); when omitted, the
   * bridge falls back to fetching the full file via `fetchBinary` and
   * slicing post-hoc (the existing path; correct but bandwidth-
   * expensive on >ReadCache-sized files like long videos and big PDFs).
   */
  async start(
    fetchBinary: FetchBinaryFn,
    fetchThumbnail?: FetchThumbnailFn,
    fetchBinaryRange?: FetchBinaryRangeFn,
  ): Promise<StartResult> {
    if (this.server) {
      throw new Error('ResourceBridge already started');
    }
    this.token = randomBytes(32).toString('hex');
    this.fetchBinary = fetchBinary;
    this.fetchThumbnail = fetchThumbnail ?? null;
    this.fetchBinaryRange = fetchBinaryRange ?? null;

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = server;

    return new Promise<StartResult>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server = null;
        this.token = null;
        this.fetchBinary = null;
        this.fetchThumbnail = null;
        this.fetchBinaryRange = null;
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
    this.fetchThumbnail = null;
    this.fetchBinaryRange = null;
    this.mtimeCache.clear();

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
   *
   * Pass `opts.thumbMaxDim` to ask for a daemon-resized thumbnail
   * (longer side capped at that many pixels). The bridge serves the
   * resized bytes if `fetchThumbnail` is wired and the daemon honours
   * the request; otherwise it transparently falls back to the full
   * binary so the webview still renders something.
   */
  urlFor(vaultPath: string, opts?: { thumbMaxDim?: number }): string {
    if (!this.server || !this.token || this.port === null) {
      throw new Error('ResourceBridge not started');
    }
    const encoded = encodeURIComponent(vaultPath);
    const thumb =
      opts?.thumbMaxDim != null && opts.thumbMaxDim > 0
        ? `&thumb=${opts.thumbMaxDim}`
        : '';
    return `http://127.0.0.1:${this.port}/r/${this.token}?p=${encoded}${thumb}`;
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
    if (!this.token || !constantTimeEqualHex(m[1], this.token)) {
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
    if (!this.fetchBinary) {
      res.writeHead(503).end();
      return;
    }

    const thumbStr = url.searchParams.get('thumb');
    if (thumbStr !== null && this.fetchThumbnail) {
      if (await this.serveThumbnail(req, res, rawPath, thumbStr)) return;
    }

    if (this.fetchBinaryRange && req.headers.range) {
      if (await this.serveRangeFastPath(req, res, rawPath, req.headers.range)) return;
    }

    await this.serveFullBinary(req, res, rawPath);
  }

  /** Serve a daemon-resized thumbnail. Returns true if served. */
  private async serveThumbnail(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawPath: string,
    thumbStr: string,
  ): Promise<boolean> {
    const maxDim = parseInt(thumbStr, 10);
    if (!Number.isFinite(maxDim) || maxDim <= 0) {
      res.writeHead(400).end('bad thumb');
      return true;
    }
    try {
      const { bytes, format } = await this.fetchThumbnail!(rawPath, maxDim);
      const contentType = format === 'png' ? 'image/png' : 'image/jpeg';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': bytes.byteLength,
        'Cache-Control': 'no-store',
      });
      sendBody(req, res, bytes);
      return true;
    } catch (e) {
      logger.warn(
        `ResourceBridge: thumbnail failed for "${rawPath}" maxDim=${maxDim}: ` +
        `${errorMessage(e)}; falling back to full binary`,
      );
      return false;
    }
  }

  /**
   * Serve an explicit `bytes=N-M` range via `fs.readBinaryRange` without
   * loading the full file. Returns true if served; false falls through
   * to the full-binary path.
   */
  private async serveRangeFastPath(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawPath: string,
    rangeHeader: string,
  ): Promise<boolean> {
    const explicit = parseExplicitByteRange(rangeHeader);
    if (explicit === null) return false;
    const fetchRange = this.fetchBinaryRange!;
    try {
      // Pin follow-up requests to the cached generation so the daemon
      // rejects mid-stream edits with PreconditionFailed (#171).
      const expectedMtime = this.lookupMtime(rawPath);
      let result;
      try {
        result = await fetchRange(rawPath, explicit.start, explicit.length, expectedMtime);
      } catch (e) {
        if (expectedMtime !== undefined && isPreconditionFailed(e)) {
          logger.info(
            `ResourceBridge: mtime mismatch for "${rawPath}" ${rangeHeader}; ` +
            `dropping cache and re-issuing without expectedMtime`,
          );
          this.mtimeCache.delete(rawPath);
          result = await fetchRange(rawPath, explicit.start, explicit.length, undefined);
        } else {
          throw e;
        }
      }
      this.storeMtime(rawPath, result.mtime);
      const totalSize = result.totalSize;
      if (explicit.start >= totalSize) {
        res.writeHead(416, {
          'Content-Range': `bytes */${totalSize}`,
          'Cache-Control': 'no-store',
        }).end();
        return true;
      }
      const sliceLen = result.bytes.byteLength;
      const end = explicit.start + sliceLen - 1;
      res.writeHead(206, {
        'Content-Type': guessMimeType(rawPath),
        'Content-Length': sliceLen,
        'Content-Range': `bytes ${explicit.start}-${end}/${totalSize}`,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      });
      sendBody(req, res, result.bytes);
      return true;
    } catch (e) {
      logger.warn(
        `ResourceBridge: fs.readBinaryRange failed for "${rawPath}" ` +
        `${rangeHeader}: ${errorMessage(e)}; falling back to full binary`,
      );
      return false;
    }
  }

  /** Fetch the full file and serve it, with legacy Range support. */
  private async serveFullBinary(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawPath: string,
  ): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fetchBinary!(rawPath);
    } catch (e) {
      logger.warn(`ResourceBridge: read failed for "${rawPath}": ${errorMessage(e)}`);
      res.writeHead(404).end();
      return;
    }

    const contentType = guessMimeType(rawPath);
    const total = bytes.byteLength;
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
      sendBody(req, res, bytes);
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
    sendBody(req, res, bytes.subarray(start, end + 1));
  }

  /**
   * Read a non-stale entry from {@link mtimeCache}. A hit refreshes
   * `lastUsed` so a continuously-scrubbed file doesn't TTL-expire.
   * Returns `undefined` for misses and for entries older than
   * {@link MTIME_CACHE_TTL_MS}; the stale entry is dropped on the
   * spot so the next caller goes through the cache-miss path.
   */
  private lookupMtime(vaultPath: string): number | undefined {
    const entry = this.mtimeCache.get(vaultPath);
    if (!entry) return undefined;
    const now = Date.now();
    if (now - entry.lastUsed > MTIME_CACHE_TTL_MS) {
      this.mtimeCache.delete(vaultPath);
      return undefined;
    }
    entry.lastUsed = now;
    return entry.mtime;
  }

  /**
   * Insert (or refresh) a path's mtime, then evict the
   * least-recently-used entry if the map exceeds
   * {@link MTIME_CACHE_MAX_ENTRIES}. The cache only sees range
   * requests, so churn is naturally bounded; the eviction here is
   * defensive against pathological access patterns.
   */
  private storeMtime(vaultPath: string, mtime: number): void {
    const now = Date.now();
    // Map preserves insertion order; deleting + re-setting puts the
    // entry at the back so the eviction sweep below picks the true
    // LRU. Without the delete, an in-place update would leave the
    // entry in its original slot and we'd evict a more-recently-used
    // path next time the cap is hit.
    this.mtimeCache.delete(vaultPath);
    this.mtimeCache.set(vaultPath, { mtime, lastUsed: now });
    if (this.mtimeCache.size > MTIME_CACHE_MAX_ENTRIES) {
      const oldest = this.mtimeCache.keys().next();
      if (!oldest.done) this.mtimeCache.delete(oldest.value);
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
 * Parse a `Range:` header WITHOUT knowing the resource's total size,
 * for the {@link FetchBinaryRangeFn} fast path (#134) that fetches
 * the slice in a single round-trip and learns the total from the
 * daemon's response.
 *
 * Only the **explicit** form `bytes=N-M` is handled — the only
 * widely-used shape that doesn't require advance knowledge of the
 * resource size. `bytes=N-` (open-ended) needs total to compute
 * `end`, and `bytes=-N` (suffix) needs total to compute `start`;
 * both forms return `null` so the caller can fall back to the
 * full-file path that has total in hand.
 *
 * Returns `null` for non-explicit forms or syntax errors; returns
 * `{ start, length }` for an explicit `bytes=N-M`. Length is `M-N+1`
 * (inclusive end). The daemon clamps past-EOF reads, so callers do
 * not need to bound `length` against any local size estimate.
 */
export function parseExplicitByteRange(
  headerValue: string,
): { start: number; length: number } | null {
  const m = /^bytes=(\d+)-(\d+)$/.exec(headerValue.trim());
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start) return null;
  return { start, length: end - start + 1 };
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

/** Write body or end empty for HEAD requests. */
function sendBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bytes: Uint8Array,
): void {
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
}

function guessMimeType(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext = path.slice(dot + 1).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}
