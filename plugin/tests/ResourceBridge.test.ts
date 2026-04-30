import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import { ResourceBridge, parseRangeHeader, parseExplicitByteRange } from '../src/adapter/ResourceBridge';

/**
 * End-to-end tests against a real localhost http.Server. The bridge is
 * small enough that mocking would just hide behaviour; spinning up a
 * real server on 127.0.0.1:0 each test is fast (<10ms each) and
 * covers the wire format we actually care about.
 */
describe('ResourceBridge', () => {
  let bridge: ResourceBridge;
  beforeEach(() => { bridge = new ResourceBridge(); });
  afterEach(async () => { await bridge.stop(); });

  it('start picks a random port and returns a hex token', async () => {
    const { port, token } = await bridge.start(async () => new Uint8Array());
    expect(port).toBeGreaterThan(0);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(bridge.isRunning()).toBe(true);
  });

  it('serves a 200 + content for valid token + path', async () => {
    const payload = new TextEncoder().encode('# hello world\n');
    const fetchBinary = async (path: string) => {
      expect(path).toBe('Notes/hi.md');
      return payload;
    };
    await bridge.start(fetchBinary);
    const url = bridge.urlFor('Notes/hi.md');
    const r = await fetchUrl(url);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(Number(r.headers['content-length'])).toBe(payload.byteLength);
    expect(r.body.toString('utf8')).toBe('# hello world\n');
  });

  it('returns 401 for a wrong token', async () => {
    await bridge.start(async () => new Uint8Array());
    const real = new URL(bridge.urlFor('foo.png'));
    const bad = `http://127.0.0.1:${real.port}/r/${'0'.repeat(64)}?p=foo.png`;
    const r = await fetchUrl(bad);
    expect(r.statusCode).toBe(401);
  });

  it('returns 404 for a path that doesn\'t match /r/<hex>', async () => {
    await bridge.start(async () => new Uint8Array());
    const real = new URL(bridge.urlFor('foo.png'));
    const r = await fetchUrl(`http://127.0.0.1:${real.port}/wrong`);
    expect(r.statusCode).toBe(404);
  });

  it('rejects path traversal attempts with 400', async () => {
    await bridge.start(async () => new Uint8Array());
    const real = new URL(bridge.urlFor('foo.png'));
    const evil = `http://127.0.0.1:${real.port}/r/${real.pathname.split('/').pop()}?p=${encodeURIComponent('../etc/passwd')}`;
    const r = await fetchUrl(evil);
    expect(r.statusCode).toBe(400);
  });

  it('rejects absolute paths with 400', async () => {
    await bridge.start(async () => new Uint8Array());
    const real = new URL(bridge.urlFor('foo.png'));
    const evil = `http://127.0.0.1:${real.port}/r/${real.pathname.split('/').pop()}?p=${encodeURIComponent('/etc/passwd')}`;
    const r = await fetchUrl(evil);
    expect(r.statusCode).toBe(400);
  });

  it('rejects empty p parameter with 400', async () => {
    await bridge.start(async () => new Uint8Array());
    const real = new URL(bridge.urlFor('foo.png'));
    const r = await fetchUrl(`http://127.0.0.1:${real.port}/r/${real.pathname.split('/').pop()}`);
    expect(r.statusCode).toBe(400);
  });

  it('rejects non-GET methods with 405', async () => {
    await bridge.start(async () => new Uint8Array());
    const url = new URL(bridge.urlFor('foo.png'));
    const r = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST' },
        res => { res.resume(); resolve({ status: res.statusCode! }); },
      );
      req.on('error', reject);
      req.end();
    });
    expect(r.status).toBe(405);
  });

  it('returns 404 when the fetcher throws', async () => {
    await bridge.start(async () => { throw new Error('not found'); });
    const r = await fetchUrl(bridge.urlFor('missing.png'));
    expect(r.statusCode).toBe(404);
  });

  it('HEAD returns headers but no body', async () => {
    const payload = new TextEncoder().encode('xyzzy');
    await bridge.start(async () => payload);
    const url = new URL(bridge.urlFor('a.txt'));
    const r = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        { host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'HEAD' },
        res => { res.resume(); resolve(res); },
      );
      req.on('error', reject);
      req.end();
    });
    expect(r.statusCode).toBe(200);
    expect(Number(r.headers['content-length'])).toBe(payload.byteLength);
  });

  it('guesses content-type for common extensions', async () => {
    const payload = new Uint8Array([0]);
    await bridge.start(async () => payload);
    const cases = [
      ['x.png',  'image/png'],
      ['x.jpg',  'image/jpeg'],
      ['x.svg',  'image/svg+xml'],
      ['x.pdf',  'application/pdf'],
      ['x.mp3',  'audio/mpeg'],
      ['x.mp4',  'video/mp4'],
      ['x.json', 'application/json'],
      ['x.weird','application/octet-stream'],
      ['noext',  'application/octet-stream'],
    ] as const;
    for (const [path, expected] of cases) {
      const r = await fetchUrl(bridge.urlFor(path));
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toBe(expected);
    }
  });

  it('urlFor throws when not started', () => {
    expect(() => bridge.urlFor('a.png')).toThrow();
  });

  it('start twice is rejected; stop allows restart with a fresh token', async () => {
    const a = await bridge.start(async () => new Uint8Array());
    await expect(bridge.start(async () => new Uint8Array())).rejects.toThrow();
    await bridge.stop();
    const b = await bridge.start(async () => new Uint8Array());
    expect(b.token).not.toBe(a.token);
  });

  it('encoded slashes in the path round-trip correctly', async () => {
    const payload = new TextEncoder().encode('nested');
    let observed = '';
    await bridge.start(async (p) => { observed = p; return payload; });
    const r = await fetchUrl(bridge.urlFor('a/b/c.md'));
    expect(r.statusCode).toBe(200);
    expect(observed).toBe('a/b/c.md');
  });
});

describe('ResourceBridge — thumbnail path', () => {
  let bridge: ResourceBridge;
  beforeEach(() => { bridge = new ResourceBridge(); });
  afterEach(async () => { await bridge.stop(); });

  it('urlFor adds ?thumb=N when opts.thumbMaxDim is set', async () => {
    await bridge.start(async () => new Uint8Array());
    const url = bridge.urlFor('photos/cover.jpg', { thumbMaxDim: 1024 });
    expect(url).toMatch(/[?&]thumb=1024(&|$)/);
  });

  it('urlFor omits the thumb param when no opts are passed', async () => {
    await bridge.start(async () => new Uint8Array());
    const url = bridge.urlFor('photos/cover.jpg');
    expect(url).not.toMatch(/[?&]thumb=/);
  });

  it('serves the thumbnail bytes when ?thumb=N is set and a fetcher is wired', async () => {
    const jpegBytes = new TextEncoder().encode('fake-jpeg-bytes');
    const fetchBinary = async () => { throw new Error('binary path should not be called'); };
    const fetchThumbnail = async (path: string, maxDim: number) => {
      expect(path).toBe('photos/cover.jpg');
      expect(maxDim).toBe(512);
      return { bytes: jpegBytes, format: 'jpeg' as const };
    };
    await bridge.start(fetchBinary, fetchThumbnail);
    const url = bridge.urlFor('photos/cover.jpg', { thumbMaxDim: 512 });
    const r = await fetchUrl(url);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.body.toString('utf8')).toBe('fake-jpeg-bytes');
  });

  it('serves PNG content-type when fetcher reports format=png', async () => {
    const pngBytes = new TextEncoder().encode('fake-png-bytes');
    const fetchThumbnail = async () => ({ bytes: pngBytes, format: 'png' as const });
    await bridge.start(async () => new Uint8Array(), fetchThumbnail);
    const r = await fetchUrl(bridge.urlFor('logo.png', { thumbMaxDim: 256 }));
    expect(r.headers['content-type']).toBe('image/png');
  });

  it('falls back to fetchBinary when fetchThumbnail throws', async () => {
    const fullBytes = new TextEncoder().encode('original-jpeg');
    const fetchBinary = async (path: string) => {
      expect(path).toBe('photos/cover.jpg');
      return fullBytes;
    };
    const fetchThumbnail = async () => { throw new Error('daemon refused'); };
    await bridge.start(fetchBinary, fetchThumbnail);
    const r = await fetchUrl(bridge.urlFor('photos/cover.jpg', { thumbMaxDim: 1024 }));
    expect(r.statusCode).toBe(200);
    expect(r.body.toString('utf8')).toBe('original-jpeg');
    // MIME guess by extension survives the fallback.
    expect(r.headers['content-type']).toBe('image/jpeg');
  });

  it('falls back to fetchBinary when no thumbnail fetcher was wired (= SFTP transport)', async () => {
    const fullBytes = new TextEncoder().encode('original');
    await bridge.start(async () => fullBytes /* no fetchThumbnail */);
    const r = await fetchUrl(bridge.urlFor('photos/cover.jpg', { thumbMaxDim: 1024 }));
    expect(r.statusCode).toBe(200);
    expect(r.body.toString('utf8')).toBe('original');
  });

  it('rejects ?thumb=0 with 400', async () => {
    await bridge.start(async () => new Uint8Array(), async () => ({ bytes: new Uint8Array(), format: 'jpeg' }));
    const real = new URL(bridge.urlFor('x.jpg'));
    const url = `http://127.0.0.1:${real.port}${real.pathname}?p=x.jpg&thumb=0`;
    const r = await fetchUrl(url);
    expect(r.statusCode).toBe(400);
  });

  it('rejects non-numeric ?thumb with 400', async () => {
    await bridge.start(async () => new Uint8Array(), async () => ({ bytes: new Uint8Array(), format: 'jpeg' }));
    const real = new URL(bridge.urlFor('x.jpg'));
    const url = `http://127.0.0.1:${real.port}${real.pathname}?p=x.jpg&thumb=abc`;
    const r = await fetchUrl(url);
    expect(r.statusCode).toBe(400);
  });
});

/**
 * Tiny GET helper that resolves with status + headers + body. Avoids
 * pulling in a fetch polyfill — vitest's `node` environment doesn't
 * always have one configured here.
 */
function fetchUrl(
  rawUrl: string,
  extraHeaders: http.OutgoingHttpHeaders = {},
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const u = new URL(rawUrl);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: extraHeaders,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          statusCode: res.statusCode!,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('parseRangeHeader', () => {
  it('parses an explicit start-end range', () => {
    expect(parseRangeHeader('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
  });

  it('parses an open-ended range as start..total-1', () => {
    expect(parseRangeHeader('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('parses a suffix range as last N bytes', () => {
    expect(parseRangeHeader('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('clamps an end past total-1', () => {
    expect(parseRangeHeader('bytes=100-9999', 1000)).toEqual({ start: 100, end: 999 });
  });

  it('rejects malformed headers as invalid', () => {
    expect(parseRangeHeader('items=0-100', 1000)).toBe('invalid');
    expect(parseRangeHeader('bytes=', 1000)).toBe('invalid');
    expect(parseRangeHeader('bytes=-', 1000)).toBe('invalid');
    expect(parseRangeHeader('bytes=abc-100', 1000)).toBe('invalid');
    expect(parseRangeHeader('bytes=0-50,100-150', 1000)).toBe('invalid');
  });

  it('rejects a start past total', () => {
    expect(parseRangeHeader('bytes=2000-', 1000)).toBe('invalid');
  });

  it('rejects start > end', () => {
    expect(parseRangeHeader('bytes=200-100', 1000)).toBe('invalid');
  });

  it('rejects a suffix range of 0 bytes', () => {
    expect(parseRangeHeader('bytes=-0', 1000)).toBe('invalid');
  });

  it('rejects all ranges on an empty resource', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toBe('invalid');
  });
});

describe('ResourceBridge Range responses', () => {
  let bridge: ResourceBridge;
  beforeEach(() => { bridge = new ResourceBridge(); });
  afterEach(async () => { await bridge.stop(); });

  it('advertises Accept-Ranges: bytes on a regular 200 response', async () => {
    await bridge.start(async () => new TextEncoder().encode('hello world'));
    const r = await fetchUrl(bridge.urlFor('a.txt'));
    expect(r.statusCode).toBe(200);
    expect(r.headers['accept-ranges']).toBe('bytes');
  });

  it('serves 206 Partial Content for a valid Range', async () => {
    const payload = new TextEncoder().encode('hello world'); // 11 bytes
    await bridge.start(async () => payload);
    const r = await fetchUrl(bridge.urlFor('a.txt'), { Range: 'bytes=6-10' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 6-10/11');
    expect(Number(r.headers['content-length'])).toBe(5);
    expect(r.body.toString('utf8')).toBe('world');
  });

  it('serves 206 for a suffix range', async () => {
    const payload = new TextEncoder().encode('hello world');
    await bridge.start(async () => payload);
    const r = await fetchUrl(bridge.urlFor('a.txt'), { Range: 'bytes=-5' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 6-10/11');
    expect(r.body.toString('utf8')).toBe('world');
  });

  it('serves 206 for an open-ended range', async () => {
    const payload = new TextEncoder().encode('hello world');
    await bridge.start(async () => payload);
    const r = await fetchUrl(bridge.urlFor('a.txt'), { Range: 'bytes=6-' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 6-10/11');
    expect(r.body.toString('utf8')).toBe('world');
  });

  it('returns 416 with Content-Range: bytes */N for an invalid range', async () => {
    const payload = new TextEncoder().encode('hello world');
    await bridge.start(async () => payload);
    const r = await fetchUrl(bridge.urlFor('a.txt'), { Range: 'bytes=2000-3000' });
    expect(r.statusCode).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */11');
  });

  it('clamps a too-large end and serves 206', async () => {
    const payload = new TextEncoder().encode('hello world');
    await bridge.start(async () => payload);
    const r = await fetchUrl(bridge.urlFor('a.txt'), { Range: 'bytes=6-9999' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 6-10/11');
    expect(r.body.toString('utf8')).toBe('world');
  });
});

// ─── #134 — fetchBinaryRange fast path ──────────────────────────────────

describe('parseExplicitByteRange (#134)', () => {
  it('parses an explicit bytes=N-M as { start, length }', () => {
    expect(parseExplicitByteRange('bytes=0-99')).toEqual({ start: 0, length: 100 });
    expect(parseExplicitByteRange('bytes=100-199')).toEqual({ start: 100, length: 100 });
    expect(parseExplicitByteRange('bytes=5-5')).toEqual({ start: 5, length: 1 });
  });

  it('returns null for forms that need the total size to parse', () => {
    expect(parseExplicitByteRange('bytes=500-')).toBeNull();
    expect(parseExplicitByteRange('bytes=-100')).toBeNull();
    expect(parseExplicitByteRange('bytes=-')).toBeNull();
    expect(parseExplicitByteRange('bytes=')).toBeNull();
  });

  it('returns null for malformed headers', () => {
    expect(parseExplicitByteRange('items=0-100')).toBeNull();
    expect(parseExplicitByteRange('bytes=abc-100')).toBeNull();
    expect(parseExplicitByteRange('bytes=0-50,100-150')).toBeNull();
  });

  it('returns null for start > end (RFC 7233 unsatisfiable)', () => {
    expect(parseExplicitByteRange('bytes=200-100')).toBeNull();
  });
});

describe('ResourceBridge — fetchBinaryRange fast path (#134)', () => {
  let bridge: ResourceBridge;
  beforeEach(() => { bridge = new ResourceBridge(); });
  afterEach(async () => { await bridge.stop(); });

  it('routes Range:bytes=N-M to fetchBinaryRange when wired (= no full-file fetch)', async () => {
    const fullFileFetcher = vi.fn(async (_p: string) => new TextEncoder().encode('XXXXXXXXXXX'));
    const rangeFetcher = vi.fn(async (path: string, offset: number, length: number) => {
      expect(path).toBe('big.bin');
      expect(offset).toBe(6);
      expect(length).toBe(5);
      // Daemon returns the requested slice + the true total size of
      // the whole file. The bridge should use the totalSize to build
      // Content-Range, NOT call back into fullFileFetcher.
      return {
        bytes:     new TextEncoder().encode('world'),
        mtime:     1234,
        totalSize: 11,
      };
    });
    await bridge.start(fullFileFetcher, undefined, rangeFetcher);
    const r = await fetchUrl(bridge.urlFor('big.bin'), { Range: 'bytes=6-10' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 6-10/11');
    expect(r.body.toString('utf8')).toBe('world');
    expect(rangeFetcher).toHaveBeenCalledTimes(1);
    expect(fullFileFetcher).not.toHaveBeenCalled();
  });

  it('falls back to fetchBinary when no fetchBinaryRange was wired (= SFTP transport)', async () => {
    const fullFileFetcher = vi.fn(async () => new TextEncoder().encode('hello world'));
    await bridge.start(fullFileFetcher);
    const r = await fetchUrl(bridge.urlFor('a.txt'), { Range: 'bytes=6-10' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 6-10/11');
    expect(r.body.toString('utf8')).toBe('world');
    expect(fullFileFetcher).toHaveBeenCalledTimes(1);
  });

  it('falls back to fetchBinary for bytes=N- (open-ended needs total size)', async () => {
    const fullFileFetcher = vi.fn(async () => new TextEncoder().encode('hello world'));
    const rangeFetcher = vi.fn(async () => ({
      bytes: new Uint8Array(), mtime: 0, totalSize: 0,
    }));
    await bridge.start(fullFileFetcher, undefined, rangeFetcher);
    const r = await fetchUrl(bridge.urlFor('a.txt'), { Range: 'bytes=6-' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 6-10/11');
    expect(rangeFetcher).not.toHaveBeenCalled();
    expect(fullFileFetcher).toHaveBeenCalledTimes(1);
  });

  it('falls back to fetchBinary for bytes=-N (suffix needs total size)', async () => {
    const fullFileFetcher = vi.fn(async () => new TextEncoder().encode('hello world'));
    const rangeFetcher = vi.fn(async () => ({
      bytes: new Uint8Array(), mtime: 0, totalSize: 0,
    }));
    await bridge.start(fullFileFetcher, undefined, rangeFetcher);
    const r = await fetchUrl(bridge.urlFor('a.txt'), { Range: 'bytes=-5' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 6-10/11');
    expect(rangeFetcher).not.toHaveBeenCalled();
    expect(fullFileFetcher).toHaveBeenCalledTimes(1);
  });

  it('returns 416 when the daemon reports the start is past EOF', async () => {
    const fullFileFetcher = vi.fn(async () => new Uint8Array());
    const rangeFetcher = vi.fn(async () => ({
      bytes: new Uint8Array(), mtime: 0, totalSize: 100,
    }));
    await bridge.start(fullFileFetcher, undefined, rangeFetcher);
    const r = await fetchUrl(bridge.urlFor('a.txt'), { Range: 'bytes=200-300' });
    expect(r.statusCode).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */100');
    expect(fullFileFetcher).not.toHaveBeenCalled();
  });

  it('falls back to fetchBinary when the range fetcher throws (e.g. daemon mid-deploy)', async () => {
    const fullFileFetcher = vi.fn(async () => new TextEncoder().encode('hello world'));
    const rangeFetcher = vi.fn(async () => {
      throw new Error('method not registered');
    });
    await bridge.start(fullFileFetcher, undefined, rangeFetcher);
    const r = await fetchUrl(bridge.urlFor('a.txt'), { Range: 'bytes=6-10' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 6-10/11');
    expect(r.body.toString('utf8')).toBe('world');
    expect(rangeFetcher).toHaveBeenCalledTimes(1);
    expect(fullFileFetcher).toHaveBeenCalledTimes(1);
  });

  it('handles a daemon-clamped past-EOF response (returned slice shorter than requested)', async () => {
    const fullFileFetcher = vi.fn(async () => new Uint8Array());
    const rangeFetcher = vi.fn(async () => ({
      // Asked for 100 bytes; daemon only had 20 left after offset.
      bytes:     new TextEncoder().encode('hello-clamped-to-EOF'), // 20 bytes
      mtime:     0,
      totalSize: 100,
    }));
    await bridge.start(fullFileFetcher, undefined, rangeFetcher);
    const r = await fetchUrl(bridge.urlFor('a.txt'), { Range: 'bytes=80-179' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 80-99/100');
    expect(Number(r.headers['content-length'])).toBe(20);
    expect(r.body.toString('utf8')).toBe('hello-clamped-to-EOF');
  });

  it('does not invoke fetchBinaryRange when there is no Range header', async () => {
    const fullFileFetcher = vi.fn(async () => new TextEncoder().encode('hello world'));
    const rangeFetcher = vi.fn(async () => ({
      bytes: new Uint8Array(), mtime: 0, totalSize: 0,
    }));
    await bridge.start(fullFileFetcher, undefined, rangeFetcher);
    const r = await fetchUrl(bridge.urlFor('a.txt'));
    expect(r.statusCode).toBe(200);
    expect(r.body.toString('utf8')).toBe('hello world');
    expect(rangeFetcher).not.toHaveBeenCalled();
    expect(fullFileFetcher).toHaveBeenCalledTimes(1);
  });
});

// ─── #171 — expectedMtime threading + retry on PreconditionFailed ────────

describe('ResourceBridge — fetchBinaryRange mtime cache (#171)', () => {
  let bridge: ResourceBridge;
  beforeEach(() => { bridge = new ResourceBridge(); });
  afterEach(async () => { await bridge.stop(); });

  it('first request flows without expectedMtime; the response\'s mtime is cached', async () => {
    const fullFileFetcher = vi.fn(async () => new Uint8Array());
    const rangeFetcher = vi.fn(async (
      _p: string, _o: number, _l: number, _expected?: number,
    ) => ({
      bytes: new TextEncoder().encode('abcde'), mtime: 1000, totalSize: 11,
    }));
    await bridge.start(fullFileFetcher, undefined, rangeFetcher);
    const r = await fetchUrl(bridge.urlFor('movie.mp4'), { Range: 'bytes=0-4' });
    expect(r.statusCode).toBe(206);
    expect(rangeFetcher).toHaveBeenCalledTimes(1);
    expect(rangeFetcher.mock.calls[0]).toEqual(['movie.mp4', 0, 5, undefined]);
  });

  it('passes the cached mtime as expectedMtime on follow-up requests for the same path', async () => {
    const fullFileFetcher = vi.fn(async () => new Uint8Array());
    const rangeFetcher = vi.fn(async (
      _p: string, _o: number, _l: number, _expected?: number,
    ) => ({
      bytes: new TextEncoder().encode('abcde'), mtime: 1000, totalSize: 11,
    }));
    await bridge.start(fullFileFetcher, undefined, rangeFetcher);
    await fetchUrl(bridge.urlFor('movie.mp4'), { Range: 'bytes=0-4' });
    await fetchUrl(bridge.urlFor('movie.mp4'), { Range: 'bytes=5-9' });
    expect(rangeFetcher).toHaveBeenCalledTimes(2);
    // First call: no precondition (priming the cache).
    expect(rangeFetcher.mock.calls[0]).toEqual(['movie.mp4', 0, 5, undefined]);
    // Second call: precondition pinned to the first response's mtime.
    expect(rangeFetcher.mock.calls[1]).toEqual(['movie.mp4', 5, 5, 1000]);
  });

  it('on PreconditionFailed, drops the cache entry, re-issues without expectedMtime, and serves the fresh slice', async () => {
    const fullFileFetcher = vi.fn(async () => new Uint8Array());
    let callCount = 0;
    const rangeFetcher = vi.fn(async (
      _p: string, _o: number, _l: number, expected?: number,
    ) => {
      callCount += 1;
      if (callCount === 1) {
        return { bytes: new TextEncoder().encode('OLD..'), mtime: 1000, totalSize: 11 };
      }
      // Second call: bridge passed expectedMtime: 1000 (from cache).
      // The remote was edited; daemon throws PreconditionFailed.
      if (callCount === 2 && expected === 1000) {
        // Mimic the RPC error shape — { code: -32020 } is enough for
        // the duck-type check in `isPreconditionFailed`.
        throw Object.assign(new Error('precondition failed'), { code: -32020 });
      }
      // Retry: bridge re-issues with expectedMtime: undefined and
      // gets the fresh slice + new mtime.
      expect(expected).toBeUndefined();
      return { bytes: new TextEncoder().encode('NEW..'), mtime: 2000, totalSize: 11 };
    });
    await bridge.start(fullFileFetcher, undefined, rangeFetcher);
    // Prime the cache.
    await fetchUrl(bridge.urlFor('movie.mp4'), { Range: 'bytes=0-4' });
    // Mid-scrub edit happens here. The next request rejects then retries.
    const r = await fetchUrl(bridge.urlFor('movie.mp4'), { Range: 'bytes=0-4' });
    expect(r.statusCode).toBe(206);
    expect(r.body.toString('utf8')).toBe('NEW..');
    expect(rangeFetcher).toHaveBeenCalledTimes(3);
    // Subsequent request after recovery should pin to the new mtime
    // (2000), not the dropped 1000 — proves the retry's response
    // mtime was cached.
    await fetchUrl(bridge.urlFor('movie.mp4'), { Range: 'bytes=5-9' });
    expect(rangeFetcher.mock.calls[3]).toEqual(['movie.mp4', 5, 5, 2000]);
  });

  it('non-PreconditionFailed errors propagate to the legacy fall-back path (no retry)', async () => {
    // A non-precondition fetcher error (e.g. transport hiccup) is
    // already handled by the existing fall-back to fetchBinary — this
    // test confirms the new retry logic doesn't swallow it or call
    // the fetcher twice.
    const fullFileFetcher = vi.fn(async () => new TextEncoder().encode('hello world'));
    const rangeFetcher = vi.fn(async () => {
      throw new Error('transient transport error');
    });
    await bridge.start(fullFileFetcher, undefined, rangeFetcher);
    const r = await fetchUrl(bridge.urlFor('a.txt'), { Range: 'bytes=6-10' });
    expect(r.statusCode).toBe(206);
    expect(r.body.toString('utf8')).toBe('world');
    expect(rangeFetcher).toHaveBeenCalledTimes(1);
    expect(fullFileFetcher).toHaveBeenCalledTimes(1);
  });

  it('TTL expiry: a stale cached mtime is dropped on read so the next request flows without expectedMtime', async () => {
    vi.useFakeTimers();
    try {
      const fullFileFetcher = vi.fn(async () => new Uint8Array());
      const rangeFetcher = vi.fn(async (
        _p: string, _o: number, _l: number, _expected?: number,
      ) => ({
        bytes: new TextEncoder().encode('abcde'), mtime: 1000, totalSize: 11,
      }));
      await bridge.start(fullFileFetcher, undefined, rangeFetcher);
      // Prime the cache at t=0.
      await fetchUrl(bridge.urlFor('movie.mp4'), { Range: 'bytes=0-4' });
      // Advance 31 seconds — past the 30 s TTL.
      vi.setSystemTime(new Date(Date.now() + 31_000));
      await fetchUrl(bridge.urlFor('movie.mp4'), { Range: 'bytes=5-9' });
      expect(rangeFetcher).toHaveBeenCalledTimes(2);
      // Both calls flowed without expectedMtime — first one priming,
      // second one finding a stale entry that was dropped on read.
      expect(rangeFetcher.mock.calls[0][3]).toBeUndefined();
      expect(rangeFetcher.mock.calls[1][3]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('LRU evict: at the max-entries cap, the least-recently-used path is dropped from the cache', async () => {
    // The cap is 64. Prime 65 distinct paths in order; the first one
    // becomes the LRU and is evicted, so a follow-up request for it
    // re-enters the cache-miss path (= no expectedMtime).
    const fullFileFetcher = vi.fn(async () => new Uint8Array());
    const rangeFetcher = vi.fn(async (
      path: string, _o: number, _l: number, _expected?: number,
    ) => ({
      // Each path gets a distinct mtime so we can tell which entry
      // the second-to-last call pinned against. Match only the first
      // run of digits so `p64.mp4` becomes `64`, not `644`.
      bytes: new TextEncoder().encode('abcde'),
      mtime: 1000 + parseInt(path.match(/\d+/)![0], 10),
      totalSize: 11,
    }));
    await bridge.start(fullFileFetcher, undefined, rangeFetcher);
    for (let i = 0; i < 65; i++) {
      await fetchUrl(bridge.urlFor(`p${i}.mp4`), { Range: 'bytes=0-4' });
    }
    // p0 should now be evicted. Re-request it: the call must pass
    // expectedMtime: undefined (cache miss), proving eviction.
    rangeFetcher.mockClear();
    await fetchUrl(bridge.urlFor('p0.mp4'), { Range: 'bytes=0-4' });
    expect(rangeFetcher.mock.calls[0][3]).toBeUndefined();
    // Conversely p64 (the most recent) should still be cached.
    rangeFetcher.mockClear();
    await fetchUrl(bridge.urlFor('p64.mp4'), { Range: 'bytes=0-4' });
    expect(rangeFetcher.mock.calls[0][3]).toBe(1000 + 64);
  });
});
