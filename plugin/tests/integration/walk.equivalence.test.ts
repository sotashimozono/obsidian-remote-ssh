import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { ReadCache } from '../../src/cache/ReadCache';
import { DirCache } from '../../src/cache/DirCache';
import { SftpRemoteFsClient } from '../../src/adapter/SftpRemoteFsClient';
import { SftpDataAdapter } from '../../src/adapter/SftpDataAdapter';
import { PathMapper } from '../../src/path/PathMapper';
import { BulkWalker, type RpcConnectionSlice } from '../../src/vault/BulkWalker';
import { establishRpcConnection, type RpcConnection } from '../../src/transport/RpcConnection';
import { deployTestDaemon, LOCAL_DAEMON_BINARY, type DeployedDaemon } from './helpers/deployDaemonOnce';
import { TEST_PRIVATE_KEY, TEST_VAULT } from './helpers/makeAdapter';

/**
 * Phase E1-α.3 — output-equivalence + qualitative benchmark for the
 * fast (`fs.walk`) and fallback (per-folder `adapter.list`) traversal
 * paths in `BulkWalker`.
 *
 * What this proves:
 *   - The migration from BFS-via-list to single-RPC walk is
 *     behaviour-preserving: both paths emit the same set of vault-
 *     relative entries against the same on-disk state.
 *   - The fast path is meaningfully faster on a non-trivial fixture
 *     (logged for visibility — not asserted, since CI runners' wall-
 *     clock is too noisy to gate merges on).
 *
 * The test seeds a per-suite subdir under the daemon's vault root
 * with a deterministic shape (50 folders × 10 files each + a few
 * top-level extras). Both walkers traverse from that subdir relative
 * to the daemon's root.
 */

if (!fs.existsSync(TEST_PRIVATE_KEY)) {
  throw new Error(
    `Integration test keypair missing at ${TEST_PRIVATE_KEY}. ` +
    'Run `npm run sshd:start` from the repo root before `npm run test:integration`.',
  );
}
if (!fs.existsSync(LOCAL_DAEMON_BINARY)) {
  throw new Error(
    `Daemon binary missing at ${LOCAL_DAEMON_BINARY}. ` +
    'Run `npm run build:server` before `npm run test:integration`.',
  );
}

describe('integration: BulkWalker — fs.walk / adapter.list output equivalence', () => {
  let daemon: DeployedDaemon;
  let conn: RpcConnection;
  let adapter: SftpDataAdapter;

  /** Per-suite subdir under TEST_VAULT, vault-root-relative slug for walker calls. */
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const subdirRel = `walk-eq-${stamp}`;
  const subdirAbs = `${TEST_VAULT}/${subdirRel}`;

  beforeAll(async () => {
    daemon = await deployTestDaemon({ label: 'walk-equiv' });

    // Adapter shares the daemon's SSH session and treats TEST_VAULT
    // (the daemon's --vault-root) as its remoteBasePath, so paths
    // passed to `walker.walk(subdirRel)` resolve identically against
    // both the daemon (vault-root-relative) and the adapter
    // (remoteBasePath-relative). PathMapper is null because the
    // fixture deliberately avoids `.obsidian/...` redirected paths;
    // the equivalence we care about lives in the shared subtree.
    adapter = new SftpDataAdapter(
      new SftpRemoteFsClient(daemon.ssh),
      TEST_VAULT,
      new ReadCache(),
      new DirCache(),
      'walk-equiv',
      new PathMapper('walk-equiv'),
      null,
      null,
    );

    // Seed a deterministic fixture in one shell command — much faster
    // than 500 sequential `fs.write` round-trips.
    //
    // Layout:
    //   <subdir>/
    //   ├── README.md
    //   ├── notes.md
    //   ├── img/  (1 file)
    //   └── area-{0..49}/
    //       ├── note-{0..9}.md   (10 files each = 500 total)
    //       └── sub/             (1 nested folder per area)
    //           └── deep.md
    //
    // Total: 1 + 1 + 1 (file) + 50 areas × (10 files + 1 sub + 1 deep) + 1 img dir
    //      = 3 top entries + 50 dirs + 50 sub dirs + 500 leaf files + 50 deep files + 1 img file
    //      = 654 entries — well below the 50_000 default cap.
    const seedScript = `
      set -e
      mkdir -p ${shQuote(subdirAbs)}/img
      echo readme > ${shQuote(subdirAbs)}/README.md
      echo notes > ${shQuote(subdirAbs)}/notes.md
      echo png > ${shQuote(subdirAbs)}/img/cover.png
      for i in $(seq 0 49); do
        d=${shQuote(subdirAbs)}/area-$i
        mkdir -p "$d/sub"
        for j in $(seq 0 9); do
          echo "area $i note $j" > "$d/note-$j.md"
        done
        echo "deep $i" > "$d/sub/deep.md"
      done
    `;
    const seedRes = await daemon.ssh.exec(seedScript);
    if (seedRes.exitCode !== 0) {
      throw new Error(`fixture seed failed (exit ${seedRes.exitCode}): ${seedRes.stderr}`);
    }

    // Open the RPC connection on the same SSH session the daemon was
    // deployed through — exactly the production connect-time pattern.
    const stream = await daemon.ssh.openUnixStream(daemon.result.remoteSocketPath);
    conn = await establishRpcConnection({ stream, token: daemon.result.token });
  });

  afterAll(async () => {
    try { conn?.close(); } catch { /* best effort */ }
    // Best-effort cleanup of the per-suite fixture; leaving it lying
    // around on a long-lived test sshd would just bloat /home/tester/vault.
    try { await daemon.ssh.exec(`rm -rf ${shQuote(subdirAbs)}`); } catch { /* best effort */ }
    await daemon.teardown();
  });

  it('rpc-walk and fallback-list emit the same set of paths', async () => {
    const rpcConn: RpcConnectionSlice = {
      info: { capabilities: conn.info.capabilities },
      rpc: conn.rpc as unknown as RpcConnectionSlice['rpc'],
    };
    const fastWalker     = new BulkWalker({ adapter, rpcConnection: rpcConn });
    const fallbackWalker = new BulkWalker({ adapter /* no rpcConnection */ });

    const fast     = await fastWalker.walk(subdirRel);
    const fallback = await fallbackWalker.walk(subdirRel);

    // Sanity: source labels reflect which path actually ran.
    expect(fast.source).toBe('rpc-walk');
    expect(fast.truncated).toBe(false);
    expect(fast.fastPathError).toBeNull();
    expect(fallback.source).toBe('fallback-list');

    const fastPaths     = fast.entries.map(e => e.path).sort();
    const fallbackPaths = fallback.entries.map(e => e.path).sort();

    // The actual equivalence claim. Output the diff (if any) on
    // failure so debugging across two transports doesn't require
    // re-running by hand.
    expect(fastPaths.length).toBe(fallbackPaths.length);
    expect(fastPaths).toEqual(fallbackPaths);

    // Fast path emits real mtime + size; fallback emits zeros (matches
    // pre-walker behaviour, intentionally). Spot-check a known file.
    const readme = fast.entries.find(e => e.path === `${subdirRel}/README.md`);
    expect(readme).toBeDefined();
    expect(readme!.isDirectory).toBe(false);
    expect(readme!.mtime).toBeGreaterThan(0);
    expect(readme!.size).toBeGreaterThan(0);

    // Qualitative benchmark — logged so the integration job's output
    // shows the speedup, but never asserted (CI runner timing is too
    // noisy to gate merges on).
    const speedup = fallback.walkMs / Math.max(1, fast.walkMs);
    // eslint-disable-next-line no-console
    console.log(
      `BulkWalker walk-${fast.entries.length}-entries: ` +
      `fast=${fast.walkMs}ms, fallback=${fallback.walkMs}ms, ` +
      `speedup=${speedup.toFixed(1)}x`,
    );
  });
});

/** Single-quote a path for safe interpolation into `sh -c`. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
