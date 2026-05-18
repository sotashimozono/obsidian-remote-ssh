import * as net from 'node:net';

/**
 * Docker test-sshd reachability gate, shared by the connect-lifecycle /
 * connect-failure / reconnect specs.
 *
 * These specs HARD-FAIL (never skip) when sshd is down: a broken
 * connect must not pass CI green — that is precisely how 1.0.49
 * shipped broken. Keeping this in one place stops the three specs
 * from drifting apart (they previously each carried a verbatim copy).
 */

export const SSHD_HOST = '127.0.0.1';
export const SSHD_PORT = 2222;

/** One-shot TCP probe — resolves if the port accepts a connection. */
function probeSshd(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sock = net
      .connect({ host: SSHD_HOST, port: SSHD_PORT })
      .setTimeout(5_000)
      .once('connect', () => { sock.destroy(); resolve(); })
      .once('timeout', () => { sock.destroy(); reject(new Error('timeout')); })
      .once('error', reject);
  });
}

export async function assertSshdReachable(): Promise<void> {
  await probeSshd().catch((e) => {
    throw new Error(
      `docker test sshd not reachable at ${SSHD_HOST}:${SSHD_PORT} ` +
      `(${(e as Error).message}). Run \`npm run sshd:start\` first. ` +
      `This spec HARD-FAILS instead of skipping — a broken connect ` +
      `must not pass CI green (that is how 1.0.49 shipped broken).`,
    );
  });
}

/**
 * Poll until sshd accepts connections again, or throw after
 * `timeoutMs`. `npm run sshd:start` exits 0 the moment `docker
 * compose up -d` returns — the container's sshd is NOT yet accepting
 * connections at that point. Without this wait the reconnect spec's
 * recovery assertion times out and blames the *plugin* ("reconnect
 * must recover") when the real fault is "the harness never brought
 * sshd back". This makes that failure attributable.
 */
export async function waitForSshdReachable(
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'unknown';
  while (Date.now() < deadline) {
    try {
      await probeSshd();
      return;
    } catch (e) {
      lastErr = (e as Error).message;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  throw new Error(
    `sshd did not become reachable at ${SSHD_HOST}:${SSHD_PORT} within ` +
    `${timeoutMs}ms after restart (last: ${lastErr}). This is a HARNESS ` +
    `fault (sshd:start ran but the container never came back), NOT a ` +
    `plugin reconnect failure — fix the docker test sshd, not the plugin.`,
  );
}
