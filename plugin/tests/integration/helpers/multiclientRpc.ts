import { SftpClient } from '../../../src/ssh/SftpClient';
import { AuthResolver } from '../../../src/ssh/AuthResolver';
import { SecretStore } from '../../../src/ssh/SecretStore';
import { HostKeyStore } from '../../../src/ssh/HostKeyStore';
import { establishRpcConnection, type RpcConnection } from '../../../src/transport/RpcConnection';
import { buildTestProfile } from './makeAdapter';
import type { FsChangedParams } from '../../../src/proto/types';

/**
 * Per-client RPC stack: a dedicated SSH session + an auth-handshaken
 * RpcConnection layered on top of a unix-socket stream to the daemon.
 *
 * Each handle owns its own SSH session, so two handles backed by the
 * same daemon do NOT share a TCP channel — closer to two real devices
 * touching the vault from different machines, which is the property
 * Phase A3 (multi-client convergence) and Phase C (sync-latency / UI
 * reflection) both depend on.
 */
export interface RpcClientHandle {
  ssh: SftpClient;
  conn: RpcConnection;
  /** Disconnect both layers. Idempotent under best-effort error handling. */
  close(): Promise<void>;
}

/**
 * Build one RPC client against an already-deployed daemon.
 *
 * `socketPath` and `token` come from the daemon deploy
 * (`DeployResult.remoteSocketPath` / `.token`). `label` is folded into
 * the SshProfile id so logs say which test owns the session.
 */
export async function buildRpcClient(
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
 * Subscribe `client` to `fs.watch` on `path` (recursive) and return a
 * helper that resolves the next notification matching `predicate`.
 *
 * `awaitNext` walks the queue first so a notification that arrived
 * before the caller registered its predicate is still picked up.
 * `drain` empties the queue and returns whatever was buffered — used
 * by callers that need a fresh starting point (e.g. after a setup
 * write whose own notifications would otherwise false-match the next
 * `awaitNext`).
 * `cleanup` unsubscribes + drops the local handler so stale events
 * from earlier tests don't leak into later ones.
 *
 * Default timeout is generous (5 s); failures throw with the queued
 * payloads attached so a missing notification is debuggable.
 */
export async function watchFor(
  client: RpcClientHandle,
  path: string,
): Promise<{
  awaitNext: (predicate: (n: FsChangedParams) => boolean, timeoutMs?: number) => Promise<FsChangedParams>;
  drain: () => FsChangedParams[];
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
    drain() {
      const out = queue.splice(0);
      return out;
    },
    async cleanup() {
      try { await client.conn.rpc.call('fs.unwatch', { subscriptionId: subId }); }
      catch { /* daemon may already be torn down */ }
      dispose();
    },
  };
}
