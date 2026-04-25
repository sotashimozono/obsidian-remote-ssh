import { describe, it, expect, beforeEach } from 'vitest';
import { SecretStore } from '../src/ssh/SecretStore';

describe('SecretStore', () => {
  let store: SecretStore;

  beforeEach(() => { store = new SecretStore(); });

  it('set and get round-trip', () => {
    store.set('profile1:password', 'correct-horse-battery-staple');
    expect(store.get('profile1:password')).toBe('correct-horse-battery-staple');
  });

  it('returns undefined for unknown ref', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('has() returns true only for stored refs', () => {
    store.set('key', 'value');
    expect(store.has('key')).toBe(true);
    expect(store.has('other')).toBe(false);
  });

  it('delete removes the entry', () => {
    store.set('key', 'secret');
    store.delete('key');
    expect(store.get('key')).toBeUndefined();
    expect(store.has('key')).toBe(false);
  });

  it('serialize + load round-trip preserves values', () => {
    store.set('a', 'alpha');
    store.set('b', 'beta');
    const blob = store.serialize();

    const store2 = new SecretStore();
    store2.load(blob);
    expect(store2.get('a')).toBe('alpha');
    expect(store2.get('b')).toBe('beta');
  });

  it('different values produce different ciphertext', () => {
    store.set('k1', 'secret-a');
    store.set('k2', 'secret-b');
    const blob = store.serialize();
    expect(blob['k1'].data).not.toBe(blob['k2'].data);
  });

  it('same value encrypted twice produces different ciphertext (random IV)', () => {
    const store2 = new SecretStore();
    store.set('k', 'same-secret');
    store2.set('k', 'same-secret');
    const b1 = store.serialize();
    const b2 = store2.serialize();
    expect(b1['k'].iv).not.toBe(b2['k'].iv);
  });

  it('tampered data returns undefined gracefully', () => {
    store.set('k', 'value');
    const blob = store.serialize();
    // Corrupt the ciphertext
    blob['k'].data = 'deadbeef'.repeat(4);
    const store2 = new SecretStore();
    store2.load(blob);
    expect(store2.get('k')).toBeUndefined();
  });

  it('load on undefined starts empty', () => {
    store.load(undefined);
    expect(store.has('anything')).toBe(false);
  });
});
