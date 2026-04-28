import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { setupClientPair, TEST_PRIVATE_KEY } from './helpers/makeAdapter';
import { SftpClient } from '../../src/ssh/SftpClient';
import { AuthResolver } from '../../src/ssh/AuthResolver';
import { SecretStore } from '../../src/ssh/SecretStore';
import { HostKeyStore } from '../../src/ssh/HostKeyStore';
import { buildTestProfile } from './helpers/makeAdapter';

/**
 * Phase A1 — multi-client convergence over the SFTP transport.
 *
 * Two `SftpDataAdapter` instances, each with its own clientId and its
 * own SSH session, both pointed at the same remote vault subdir.
 * Verifies the two design promises shadow-vault depends on:
 *
 *   F1 — Shared content (markdown, attachments, …) converges: a write
 *        from client A is visible to client B and vice versa.
 *   F2 — Per-client UI state (PathMapper-private paths like
 *        `.obsidian/workspace.json`) lands in distinct subtrees on the
 *        remote so the clients don't clobber each other.
 *   F3 — Delete + rename are observed across clients (after cache
 *        invalidation, which an RPC-mode client would get for free
 *        via `fs.changed`; in pure SFTP we drive it manually here to
 *        isolate the protocol-level behaviour from the cache layer).
 *
 * RPC-mode `fs.watch` cross-client notifications live in PR A3
 * (`multiclient.rpc.test.ts`) — this file deliberately stays inside
 * the SFTP envelope so it can run without the Go daemon.
 */

if (!fs.existsSync(TEST_PRIVATE_KEY)) {
  throw new Error(
    `Integration test keypair missing at ${TEST_PRIVATE_KEY}. ` +
    'Run `npm run sshd:start` from the repo root before `npm run test:integration`.',
  );
}

/** Read an ArrayBuffer-returning adapter call as a UTF-8 string. */
function decode(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('utf8');
}
/** Convert a UTF-8 string into the ArrayBuffer the adapter expects. */
function encode(s: string): ArrayBuffer {
  const b = Buffer.from(s, 'utf8');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

describe('integration: multi-client convergence (SFTP transport)', () => {
  let pair: Awaited<ReturnType<typeof setupClientPair>>;
  /** Raw SFTP session used to assert wire-level layout — bypasses both adapters' caches and PathMappers. */
  let observer: SftpClient;

  beforeAll(async () => {
    pair = await setupClientPair({ testLabel: 'sftp-conv' });
    const auth = new AuthResolver(new SecretStore());
    observer = new SftpClient(auth, new HostKeyStore());
    await observer.connect(buildTestProfile('sftp-conv-observer'));
  });

  afterAll(async () => {
    try { await observer.disconnect(); } catch { /* best effort */ }
    await pair.cleanup();
  });

  // ─── F1: shared content convergence ────────────────────────────────────

  it('F1: client B sees what A wrote to a shared path', async () => {
    await pair.a.adapter.write('shared/from-a.md', 'hello from A');
    const listing = await pair.b.adapter.list('shared');
    expect(listing.files).toContain('shared/from-a.md');
    const content = await pair.b.adapter.read('shared/from-a.md');
    expect(content).toBe('hello from A');
  });

  it('F1: A sees B\'s overwrite after invalidating its cache', async () => {
    await pair.a.adapter.write('shared/pingpong.md', 'A v1');
    expect(await pair.a.adapter.read('shared/pingpong.md')).toBe('A v1');

    await pair.b.adapter.write('shared/pingpong.md', 'B v2');

    // In SFTP-only mode there's no fs.changed push — A's ReadCache still
    // holds the stale "A v1". Cross-client cache invalidation is the job
    // of the RPC fs.watch path; here we simulate the notification A would
    // have received so the test pins down "the protocol converges, the
    // cache is the only thing that needed a hint".
    pair.a.adapter.invalidateRemotePath('shared/pingpong.md');

    expect(await pair.a.adapter.read('shared/pingpong.md')).toBe('B v2');
  });

  it('F1: binary round-trip survives intact between clients', async () => {
    const payload = Buffer.alloc(8 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) % 256;
    const ab = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);

    await pair.a.adapter.writeBinary('shared/blob.bin', ab);
    const got = await pair.b.adapter.readBinary('shared/blob.bin');

    expect(got.byteLength).toBe(payload.length);
    expect(Buffer.from(got).equals(payload)).toBe(true);
  });

  // ─── F2: per-client PathMapper isolation ───────────────────────────────

  it('F2: each client\'s `.obsidian/workspace.json` writes to its own subtree on the wire', async () => {
    await pair.a.adapter.write('.obsidian/workspace.json', '{"who":"alpha"}');
    await pair.b.adapter.write('.obsidian/workspace.json', '{"who":"beta"}');

    // Wire-level assertion: two distinct files, one per clientId.
    const userDir = `${pair.vaultRoot}/.obsidian/user`;
    const userEntries = await observer.list(userDir);
    const userNames = userEntries.map(e => e.name).sort();
    expect(userNames).toEqual(['alpha', 'beta']);

    const alphaContent = (await observer.readBinary(`${userDir}/alpha/workspace.json`)).toString('utf8');
    const betaContent  = (await observer.readBinary(`${userDir}/beta/workspace.json`)).toString('utf8');
    expect(alphaContent).toBe('{"who":"alpha"}');
    expect(betaContent).toBe('{"who":"beta"}');

    // And from each client's own view: they read back what they wrote,
    // not the other client's value.
    expect(await pair.a.adapter.read('.obsidian/workspace.json')).toBe('{"who":"alpha"}');
    expect(await pair.b.adapter.read('.obsidian/workspace.json')).toBe('{"who":"beta"}');
  });

  it('F2: listing `.obsidian/` from a client hides the foreign-client subtrees', async () => {
    // Both private writes already happened in the previous test, so
    // `.obsidian/user/alpha` and `.obsidian/user/beta` both exist.
    // Each client should see workspace.json in its `.obsidian/` listing
    // (merged from its own subtree) but NOT the bare `user` directory
    // (which would leak the existence of other clients).
    const aListing = await pair.a.adapter.list('.obsidian');
    expect(aListing.folders).not.toContain('.obsidian/user');
    expect(aListing.files).toContain('.obsidian/workspace.json');

    const bListing = await pair.b.adapter.list('.obsidian');
    expect(bListing.folders).not.toContain('.obsidian/user');
    expect(bListing.files).toContain('.obsidian/workspace.json');
  });

  // ─── F3: delete + rename converge ──────────────────────────────────────

  it('F3: a delete by B is visible to A after cache invalidation', async () => {
    await pair.a.adapter.write('shared/transient.md', 'doomed');
    expect(await pair.b.adapter.exists('shared/transient.md')).toBe(true);

    await pair.b.adapter.remove('shared/transient.md');

    // Same caveat as F1 ping-pong: A's caches need the hint.
    pair.a.adapter.invalidateRemotePath('shared/transient.md');

    expect(await pair.a.adapter.exists('shared/transient.md')).toBe(false);
  });

  it('F3: a rename by A is visible to B (old gone, new present)', async () => {
    await pair.a.adapter.write('shared/old-name.md', 'rename me');
    expect(await pair.b.adapter.exists('shared/old-name.md')).toBe(true);

    await pair.a.adapter.rename('shared/old-name.md', 'shared/new-name.md');

    pair.b.adapter.invalidateRemotePath('shared/old-name.md');
    pair.b.adapter.invalidateRemotePath('shared/new-name.md');

    expect(await pair.b.adapter.exists('shared/old-name.md')).toBe(false);
    expect(await pair.b.adapter.exists('shared/new-name.md')).toBe(true);
    expect(await pair.b.adapter.read('shared/new-name.md')).toBe('rename me');
  });
});
