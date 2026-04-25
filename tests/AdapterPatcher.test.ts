import { describe, it, expect } from 'vitest';
import { AdapterPatcher } from '../src/adapter/AdapterPatcher';

describe('AdapterPatcher', () => {
  it('replaces named methods and routes calls through the replacement', () => {
    const target: { greet(name: string): string; shout?(name: string): string } = {
      greet: (name) => `hello, ${name}`,
    };
    const replacement = {
      greet(this: { suffix: string }, name: string) { return `hi ${name}${this.suffix}`; },
      suffix: '!',
    };
    const patcher = new AdapterPatcher(target, replacement);
    patcher.patch(['greet']);
    expect(target.greet('souta')).toBe('hi souta!');
  });

  it('binds the replacement to its own host so this resolves correctly', () => {
    const target: { value(): number } = { value: () => 1 };
    const replacement = {
      multiplier: 7,
      value(this: { multiplier: number }) { return this.multiplier; },
    };
    const patcher = new AdapterPatcher(target, replacement);
    patcher.patch(['value']);
    expect(target.value()).toBe(7);
  });

  it('restore puts the original methods back', () => {
    const target = { greet: (name: string) => `original ${name}` };
    const replacement = { greet: (name: string) => `replaced ${name}` };
    const patcher = new AdapterPatcher(target, replacement);
    patcher.patch(['greet']);
    expect(target.greet('x')).toBe('replaced x');
    patcher.restore();
    expect(target.greet('x')).toBe('original x');
  });

  it('isPatched reflects the current state', () => {
    const target = { greet: () => 'a' };
    const replacement = { greet: () => 'b' };
    const patcher = new AdapterPatcher(target, replacement);
    expect(patcher.isPatched()).toBe(false);
    patcher.patch(['greet']);
    expect(patcher.isPatched()).toBe(true);
    patcher.restore();
    expect(patcher.isPatched()).toBe(false);
  });

  it('throws when patch is called twice without an intervening restore', () => {
    const target = { greet: () => 'a' };
    const replacement = { greet: () => 'b' };
    const patcher = new AdapterPatcher(target, replacement);
    patcher.patch(['greet']);
    expect(() => patcher.patch(['greet'])).toThrow(/already patched/);
  });

  it('rolls back partial swaps if patch encounters a non-function replacement', () => {
    const target: Record<string, unknown> = {
      a: () => 'orig-a',
      b: () => 'orig-b',
    };
    // "b" is missing on the replacement on purpose.
    const replacement: Record<string, unknown> = {
      a: () => 'new-a',
    };
    const patcher = new AdapterPatcher(target, replacement);
    expect(() => patcher.patch(['a', 'b'] as never)).toThrow(/is not a function/);
    expect((target.a as () => string)()).toBe('orig-a');
    expect((target.b as () => string)()).toBe('orig-b');
    expect(patcher.isPatched()).toBe(false);
  });

  it('preserves the value of an originally-undefined property and restores it as undefined', () => {
    const target: Record<string, unknown> = { a: 1 }; // no `greet` originally
    const replacement = { greet: () => 'hi' };
    const patcher = new AdapterPatcher(target, replacement);
    patcher.patch(['greet']);
    expect((target.greet as () => string)()).toBe('hi');
    patcher.restore();
    expect(target.greet).toBeUndefined();
  });

  it('restore is a no-op when not patched', () => {
    const target = { greet: () => 'orig' };
    const replacement = { greet: () => 'new' };
    const patcher = new AdapterPatcher(target, replacement);
    expect(() => patcher.restore()).not.toThrow();
    expect(target.greet()).toBe('orig');
  });

  it('supports patching multiple methods at once', () => {
    const target = {
      a: () => 'orig-a',
      b: () => 'orig-b',
      c: () => 'orig-c',
    };
    const replacement = {
      a: () => 'new-a',
      b: () => 'new-b',
      c: () => 'new-c',
    };
    const patcher = new AdapterPatcher(target, replacement);
    patcher.patch(['a', 'c']); // skip b
    expect(target.a()).toBe('new-a');
    expect(target.b()).toBe('orig-b');
    expect(target.c()).toBe('new-c');
    patcher.restore();
    expect(target.a()).toBe('orig-a');
    expect(target.c()).toBe('orig-c');
  });
});
