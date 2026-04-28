import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { deployTestDaemon, LOCAL_DAEMON_BINARY, type DeployedDaemon } from './helpers/deployDaemonOnce';
import { TEST_PRIVATE_KEY, TEST_VAULT } from './helpers/makeAdapter';
import { buildRpcClient, watchFor, type RpcClientHandle } from './helpers/multiclientRpc';

/**
 * Phase A3 — multi-client convergence over the RPC transport.
 *
 * One daemon, two clients (each its own SSH session, both sharing the
 * deploy's auth token). Verifies the design promise that the
 * shadow-vault flow's live-update story rests on:
 *
 *   F4 — Client A subscribes to fs.watch; client B's writes (create /
 *        modify / delete) reach A as fs.changed notifications within
 *        a few seconds. Without this, two devices on the same vault
 *        would only see each other's edits on the next manual reload.
 *
 * Skipped automatically when the test keypair or daemon binary isn't
 * present; both come from `npm run sshd:start` + `npm run build:server`
 * (which the integration CI workflow also wires up).
 *
 * The RPC-client / fs.watch wiring lives in `helpers/multiclientRpc.ts`
 * so Phase C's perf bench (M6) and E2E suite (M9) can reuse the same
 * primitives without duplicating session/handshake plumbing.
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

describe('integration: multi-client convergence (RPC transport, fs.watch)', () => {
  let daemon: DeployedDaemon;
  let a: RpcClientHandle;
  let b: RpcClientHandle;
  /** Per-suite subdir under TEST_VAULT, so the watch handler doesn't pick up stray edits from other test files. */
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const subdirAbs = `${TEST_VAULT}/multiclient-rpc-${stamp}`;
  /** Daemon paths are vault-root-relative; the daemon's --vault-root is TEST_VAULT, so subtract that prefix. */
  const subdirRel = `multiclient-rpc-${stamp}`;
  void subdirAbs; // retained for future debugging — daemon paths are relative

  beforeAll(async () => {
    daemon = await deployTestDaemon({ label: 'rpc-multiclient' });
    // One daemon serves the entire TEST_VAULT; both clients share it.
    a = await buildRpcClient(daemon.result.remoteSocketPath, daemon.result.token, 'rpc-multiclient-a');
    b = await buildRpcClient(daemon.result.remoteSocketPath, daemon.result.token, 'rpc-multiclient-b');
    // mkdir the subdir via B (any client works) so subsequent writes succeed.
    await b.conn.rpc.call('fs.mkdir', { path: subdirRel, recursive: true });
  });

  afterAll(async () => {
    try { await a.close(); } catch { /* best effort */ }
    try { await b.close(); } catch { /* best effort */ }
    await daemon.teardown();
  });

  it('F4: client A is notified when client B creates a file', async () => {
    const watcher = await watchFor(a, subdirRel);
    try {
      const target = `${subdirRel}/note.md`;
      await b.conn.rpc.call('fs.write', { path: target, content: 'from B' });
      const event = await watcher.awaitNext(
        (n) => n.path.endsWith('note.md') && n.event === 'created',
      );
      expect(event.event).toBe('created');
      expect(event.path.endsWith('note.md')).toBe(true);
    } finally {
      await watcher.cleanup();
    }
  });

  it('F4: client A is notified when client B modifies an existing file', async () => {
    // Pre-create so the modify is unambiguous (some watcher backends fold
    // create-then-write into a single notification; we want the modify path
    // exercised on its own).
    const target = `${subdirRel}/edit.md`;
    await b.conn.rpc.call('fs.write', { path: target, content: 'v1' });
    // Small breath so the create notification clears before subscribing.
    await new Promise((r) => setTimeout(r, 200));

    const watcher = await watchFor(a, subdirRel);
    try {
      await b.conn.rpc.call('fs.write', { path: target, content: 'v2' });
      const event = await watcher.awaitNext(
        (n) => n.path.endsWith('edit.md') && (n.event === 'modified' || n.event === 'created'),
      );
      // Linux inotify sometimes reports IN_MODIFY for an overwrite as a
      // 'modified' event, sometimes as 'created' depending on the daemon's
      // open flags — accept either as long as the path matches and we got
      // a notification, which is the actual contract the plugin wires up.
      expect(['modified', 'created']).toContain(event.event);
    } finally {
      await watcher.cleanup();
    }
  });

  it('F4: client A is notified when client B deletes a file', async () => {
    const target = `${subdirRel}/doomed.md`;
    await b.conn.rpc.call('fs.write', { path: target, content: 'goodbye' });
    await new Promise((r) => setTimeout(r, 200));

    const watcher = await watchFor(a, subdirRel);
    try {
      await b.conn.rpc.call('fs.remove', { path: target });
      const event = await watcher.awaitNext(
        (n) => n.path.endsWith('doomed.md') && n.event === 'deleted',
      );
      expect(event.event).toBe('deleted');
    } finally {
      await watcher.cleanup();
    }
  });
});
