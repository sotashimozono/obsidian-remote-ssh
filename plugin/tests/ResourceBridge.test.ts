import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { ResourceBridge } from '../src/adapter/ResourceBridge';

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

/**
 * Tiny GET helper that resolves with status + headers + body. Avoids
 * pulling in a fetch polyfill — vitest's `node` environment doesn't
 * always have one configured here.
 */
function fetchUrl(rawUrl: string): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const u = new URL(rawUrl);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' },
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
