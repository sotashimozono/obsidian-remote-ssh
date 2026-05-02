import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'crypto';
import { HostKeyStore } from '../src/ssh/HostKeyStore';

/**
 * Helper: derive the sha256 hex of a Buffer the same way HostKeyStore
 * does, so assertions don't have to hardcode magic constants.
 */
function fp(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('HostKeyStore — sync verify (existing TOFU path)', () => {
  it('first-time-trusts an unknown host and pins the fingerprint', () => {
    const store = new HostKeyStore();
    const key = Buffer.from('host-key-bytes-1');
    expect(store.verify('example.com', 22, key)).toBe(true);
    expect(store.serialize()).toEqual({ 'example.com:22': fp(key) });
  });

  it('returns true on a subsequent matching key', () => {
    const store = new HostKeyStore();
    const key = Buffer.from('host-key-bytes-1');
    store.verify('example.com', 22, key);
    expect(store.verify('example.com', 22, key)).toBe(true);
  });

  it('returns false on fingerprint mismatch (fail-closed)', () => {
    const store = new HostKeyStore();
    store.verify('example.com', 22, Buffer.from('host-key-bytes-1'));
    expect(store.verify('example.com', 22, Buffer.from('different-key'))).toBe(false);
  });

  it('forget() clears the pin so the next verify re-trusts', () => {
    const store = new HostKeyStore();
    store.verify('example.com', 22, Buffer.from('host-key-bytes-1'));
    store.forget('example.com', 22);
    expect(store.serialize()).toEqual({});
    // After forget, a different key first-time-trusts again.
    expect(store.verify('example.com', 22, Buffer.from('different-key'))).toBe(true);
  });

  it('keys host:port pairs separately', () => {
    const store = new HostKeyStore();
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    expect(store.verify('host.example', 22, a)).toBe(true);
    expect(store.verify('host.example', 2222, b)).toBe(true);
    // Same host, different port → independent pin.
    expect(store.serialize()).toEqual({
      'host.example:22':   fp(a),
      'host.example:2222': fp(b),
    });
  });

  it('load() rehydrates from a serialised record', () => {
    const store = new HostKeyStore();
    const key = Buffer.from('seeded');
    store.load({ 'cached.example:22': fp(key) });
    // Seeded fingerprint matches → true.
    expect(store.verify('cached.example', 22, key)).toBe(true);
    // Different key against the seeded host → mismatch (false).
    expect(store.verify('cached.example', 22, Buffer.from('other'))).toBe(false);
  });
});

describe('HostKeyStore — verifyAsync (#132 mismatch-prompt path)', () => {
  it('first-time-trusts (no callback consulted) on an unknown host', async () => {
    const store = new HostKeyStore();
    const onMismatch = vi.fn();
    const key = Buffer.from('first-time-key');
    expect(await store.verifyAsync('new.example', 22, key, onMismatch)).toBe(true);
    expect(onMismatch).not.toHaveBeenCalled();
    expect(store.serialize()).toEqual({ 'new.example:22': fp(key) });
  });

  it('returns true on a matching pinned key (no callback consulted)', async () => {
    const store = new HostKeyStore();
    const key = Buffer.from('matching-key');
    store.verify('match.example', 22, key); // pin
    const onMismatch = vi.fn();
    expect(await store.verifyAsync('match.example', 22, key, onMismatch)).toBe(true);
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it('returns false (fail-closed) on mismatch when no callback is supplied', async () => {
    const store = new HostKeyStore();
    store.verify('mismatch.example', 22, Buffer.from('original-key'));
    expect(
      await store.verifyAsync('mismatch.example', 22, Buffer.from('new-key')),
    ).toBe(false);
    // Pin is preserved (no callback => no trust decision => no rotation).
    expect(store.serialize()['mismatch.example:22']).toBe(fp(Buffer.from('original-key')));
  });

  it('replaces the pin and returns true when the callback chooses trust', async () => {
    const store = new HostKeyStore();
    const oldKey = Buffer.from('original');
    const newKey = Buffer.from('rotated');
    store.verify('rotate.example', 22, oldKey);

    const onMismatch = vi.fn(async (info: { host: string; port: number; oldFp: string; newFp: string }) => {
      expect(info.host).toBe('rotate.example');
      expect(info.port).toBe(22);
      expect(info.oldFp).toBe(fp(oldKey));
      expect(info.newFp).toBe(fp(newKey));
      return 'trust' as const;
    });

    expect(await store.verifyAsync('rotate.example', 22, newKey, onMismatch)).toBe(true);
    expect(onMismatch).toHaveBeenCalledTimes(1);
    // After trust, the new fingerprint replaces the old one.
    expect(store.serialize()['rotate.example:22']).toBe(fp(newKey));
  });

  it('preserves the pin and returns false when the callback chooses abort', async () => {
    const store = new HostKeyStore();
    const oldKey = Buffer.from('keep-this');
    const newKey = Buffer.from('rejected');
    store.verify('abort.example', 22, oldKey);

    const onMismatch = vi.fn(async () => 'abort' as const);

    expect(await store.verifyAsync('abort.example', 22, newKey, onMismatch)).toBe(false);
    expect(onMismatch).toHaveBeenCalledTimes(1);
    // Pin must not move on abort — that would silently let an
    // attacker who got past one prompt also displace the trusted
    // fingerprint for next time.
    expect(store.serialize()['abort.example:22']).toBe(fp(oldKey));
  });

  it('treats a thrown callback as abort (defence in depth)', async () => {
    const store = new HostKeyStore();
    const oldKey = Buffer.from('pinned');
    store.verify('throw.example', 22, oldKey);

    const onMismatch = vi.fn(async () => {
      throw new Error('modal blew up');
    });

    expect(
      await store.verifyAsync('throw.example', 22, Buffer.from('new'), onMismatch),
    ).toBe(false);
    // Pin preserved despite handler error.
    expect(store.serialize()['throw.example:22']).toBe(fp(oldKey));
  });

  it('calls onFirstTime on first connection when handler is provided', async () => {
    const store = new HostKeyStore();
    const key = Buffer.from('first-key');
    const onFirstTime = vi.fn(async () => 'trust' as const);
    expect(await store.verifyAsync('new.example', 22, key, undefined, onFirstTime)).toBe(true);
    expect(onFirstTime).toHaveBeenCalledTimes(1);
    expect(onFirstTime).toHaveBeenCalledWith(expect.objectContaining({
      host: 'new.example', port: 22, fingerprint: fp(key),
    }));
    expect(store.serialize()['new.example:22']).toBe(fp(key));
  });

  it('trust-once: accepts session-only, does not persist', async () => {
    const store = new HostKeyStore();
    const key = Buffer.from('session-key');
    const onFirstTime = vi.fn(async () => 'trust-once' as const);
    expect(await store.verifyAsync('once.example', 22, key, undefined, onFirstTime)).toBe(true);
    expect(store.serialize()['once.example:22']).toBeUndefined();
    // Session trust still accepted by sync verify
    expect(store.verify('once.example', 22, key)).toBe(true);
  });

  it('reject: returns false and does not pin', async () => {
    const store = new HostKeyStore();
    const key = Buffer.from('rejected-key');
    const onFirstTime = vi.fn(async () => 'reject' as const);
    expect(await store.verifyAsync('reject.example', 22, key, undefined, onFirstTime)).toBe(false);
    expect(store.serialize()).toEqual({});
  });

  it('treats a thrown onFirstTime handler as reject', async () => {
    const store = new HostKeyStore();
    const key = Buffer.from('throw-key');
    const onFirstTime = vi.fn(async () => { throw new Error('modal closed'); });
    expect(await store.verifyAsync('throw2.example', 22, key, undefined, onFirstTime)).toBe(false);
    expect(store.serialize()).toEqual({});
  });

  it('after trust, a subsequent verifyAsync with the same new key matches without prompting', async () => {
    const store = new HostKeyStore();
    store.verify('flow.example', 22, Buffer.from('v1'));
    const newKey = Buffer.from('v2');
    const onMismatch = vi.fn(async () => 'trust' as const);

    // First call: prompts, user trusts, pin rotates.
    await store.verifyAsync('flow.example', 22, newKey, onMismatch);
    // Second call with the same key now matches the (rotated) pin.
    expect(await store.verifyAsync('flow.example', 22, newKey, onMismatch)).toBe(true);
    // Callback was only consulted on the first call, not the second.
    expect(onMismatch).toHaveBeenCalledTimes(1);
  });
});
