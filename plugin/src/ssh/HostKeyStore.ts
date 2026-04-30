import * as crypto from 'crypto';
import { logger } from '../util/logger';

/**
 * User decision returned from the on-mismatch prompt threaded into
 * {@link HostKeyStore.verifyAsync} (#132). The async path lets the
 * caller surface a modal and await a real answer from the user
 * before the SSH handshake proceeds.
 */
export type HostKeyMismatchDecision = 'trust' | 'abort';

/**
 * Async callback invoked by {@link HostKeyStore.verifyAsync} when
 * the remote presents a fingerprint that doesn't match the pinned
 * one. Resolves with `'trust'` to forget the old key + pin the new
 * one + proceed, or `'abort'` to refuse the handshake.
 */
export type HostKeyMismatchHandler = (info: {
  host: string;
  port: number;
  oldFp: string;
  newFp: string;
}) => Promise<HostKeyMismatchDecision>;

export class HostKeyStore {
  private store: Map<string, string> = new Map();

  load(savedFingerprints: Record<string, string>) {
    this.store = new Map(Object.entries(savedFingerprints));
  }

  serialize(): Record<string, string> {
    return Object.fromEntries(this.store);
  }

  verify(host: string, port: number, keyBuffer: Buffer): boolean {
    const key = `${host}:${port}`;
    const fingerprint = crypto.createHash('sha256').update(keyBuffer).digest('hex');

    const known = this.store.get(key);
    if (!known) {
      logger.info(`TOFU: Trusting new host key for ${key}: SHA256:${fingerprint.slice(0, 16)}...`);
      this.store.set(key, fingerprint);
      return true;
    }
    if (known !== fingerprint) {
      logger.error(`Host key mismatch for ${key}! Expected ${known.slice(0, 16)}... got ${fingerprint.slice(0, 16)}...`);
      return false;
    }
    return true;
  }

  /**
   * Async sibling of {@link verify} that hands a mismatch off to a
   * user-facing prompt instead of immediately failing (#132).
   *
   * Behaviour table:
   *   - **First-time-trust (no pinned fingerprint)** — pin the new
   *     fingerprint and resolve `true`. Same TOFU semantics as the
   *     sync path; no callback consulted.
   *   - **Match** — resolve `true`.
   *   - **Mismatch + no callback wired** — resolve `false`. Lets
   *     non-UI callers (integration tests, programmatic callers)
   *     keep the existing fail-closed behaviour without coupling to
   *     a modal layer.
   *   - **Mismatch + callback returns `'trust'`** — forget the old
   *     fingerprint, pin the new one, resolve `true`. Equivalent to
   *     `ssh-keygen -R host` followed by reconnect.
   *   - **Mismatch + callback returns `'abort'`** — leave the pinned
   *     fingerprint untouched, resolve `false`.
   *
   * The fingerprint change is logged in both the trust and abort
   * branches so post-mortem audit trails preserve the event
   * regardless of the user's choice.
   */
  async verifyAsync(
    host: string,
    port: number,
    keyBuffer: Buffer,
    onMismatch?: HostKeyMismatchHandler,
  ): Promise<boolean> {
    const key = `${host}:${port}`;
    const fingerprint = crypto.createHash('sha256').update(keyBuffer).digest('hex');

    const known = this.store.get(key);
    if (!known) {
      logger.info(`TOFU: Trusting new host key for ${key}: SHA256:${fingerprint.slice(0, 16)}...`);
      this.store.set(key, fingerprint);
      return true;
    }
    if (known === fingerprint) {
      return true;
    }

    // Mismatch path. Without a handler we keep the old fail-closed
    // behaviour so the change doesn't quietly start trusting things
    // for callers who never opted into the prompt flow.
    logger.error(
      `Host key mismatch for ${key}! ` +
      `Expected ${known.slice(0, 16)}... got ${fingerprint.slice(0, 16)}...`,
    );
    if (!onMismatch) {
      return false;
    }
    let decision: HostKeyMismatchDecision;
    try {
      decision = await onMismatch({ host, port, oldFp: known, newFp: fingerprint });
    } catch (e) {
      // Treat handler errors as abort — a thrown modal is worse than
      // a refused connection because the latter is at least a clean
      // failure mode the user can recover from.
      logger.warn(
        `Host-key mismatch handler threw for ${key}; treating as abort: ` +
        `${(e as Error).message}`,
      );
      return false;
    }
    if (decision === 'trust') {
      logger.warn(
        `User trusted new host key for ${key}; ` +
        `replacing pinned SHA256:${known.slice(0, 16)}... ` +
        `with SHA256:${fingerprint.slice(0, 16)}...`,
      );
      this.store.set(key, fingerprint);
      return true;
    }
    logger.info(`User aborted on host-key mismatch for ${key}; pinned key preserved`);
    return false;
  }

  forget(host: string, port: number) {
    this.store.delete(`${host}:${port}`);
  }
}
