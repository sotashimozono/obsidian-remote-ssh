import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { SftpClient } from '../../src/ssh/SftpClient';
import { AuthResolver } from '../../src/ssh/AuthResolver';
import { SecretStore } from '../../src/ssh/SecretStore';
import { HostKeyStore } from '../../src/ssh/HostKeyStore';
import { establishRpcConnection, type RpcConnection } from '../../src/transport/RpcConnection';
import { deployTestDaemon, LOCAL_DAEMON_BINARY, type DeployedDaemon } from './helpers/deployDaemonOnce';
import { buildTestProfile, TEST_PRIVATE_KEY, TEST_VAULT } from './helpers/makeAdapter';
import type { FsChangedParams } from '../../src/proto/types';

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

/** One client's RPC stack: dedicated SSH session + auth-handshaken RPC connection. */
interface RpcClientHandle {
  ssh: SftpClient;
  conn: RpcConnection;
  /** Disconnect both layers. */
  close(): Promise<void>;
}

/**
 * Build one RPC client against an already-deployed daemon. Each call
 * spins up its own SSH session so the two clients don't share a TCP
 * channel — closer to two real devices.
 */
async function buildRpcClient(
  socketPath: string,
  token: string,
  label: string,
): Promise<RpcClientHandle> {
  const ssh = new SftpClient(new AuthResolver(new SecretStore()), new HostKeyStore());
  await ssh.connect(buildTestProfile(label));
  const stream = await ssh.openUnixStream(socketPath);
  const conn = await establishRpcConnection({ stream, token });
  return {
    ssh,
    conn,
    async close() {
      try { conn.close();        } catch { /* best effort */ }
      try { await ssh.disconnect(); } catch { /* best effort */ }
    },
  };
}

/**
 * Subscribe `client` to `fs.watch` on the given path and return a
 * helper that resolves the next notification matching `predicate`.
 * Times out (default 5 s) so a missing notification fails fast
 * instead of hanging the whole suite.
 *
 * The returned `cleanup` unsubscribes + drops the local handler so
 * stale notifications from earlier tests don't leak into later ones.
 */
async function watchFor(
  client: RpcClientHandle,
  path: string,
): Promise<{
  awaitNext: (predicate: (n: FsChangedParams) => boolean, timeoutMs?: number) => Promise<FsChangedParams>;
  cleanup: () => Promise<void>;
}> {
  const subId: string = (await client.conn.rpc.call('fs.watch', { path, recursive: true })).subscriptionId;
  const queue: FsChangedParams[] = [];
  const waiters: Array<{ predicate: (n: FsChangedParams) => boolean; resolve: (n: FsChangedParams) => void }> = [];
  const dispose = client.conn.rpc.onNotification('fs.changed', (n) => {
    if (n.subscriptionId !== subId) return;
    // Fan out to anyone whose predicate matches; drain the queue so
    // late-arriving waiters can still pick up earlier matches.
    queue.push(n);
    for (const w of waiters.splice(0)) {
      const idx = queue.findIndex(w.predicate);
      if (idx >= 0) {
        const [hit] = queue.splice(idx, 1);
        w.resolve(hit);
      } else {
        waiters.push(w);
      }
    }
  });

  return {
    awaitNext(predicate, timeoutMs = 5_000) {
      const idx = queue.findIndex(predicate);
      if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
      return new Promise<FsChangedParams>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`watchFor: no matching fs.changed within ${timeoutMs}ms; queue=${JSON.stringify(queue)}`)),
          timeoutMs,
        );
        waiters.push({
          predicate,
          resolve: (n) => { clearTimeout(timer); resolve(n); },
        });
      });
    },
    async cleanup() {
      try { await client.conn.rpc.call('fs.unwatch', { subscriptionId: subId }); }
      catch { /* daemon may already be torn down */ }
      dispose();
    },
  };
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
