import { describe, it, expect } from 'vitest';
import { ConnectionManager } from '../src/ConnectionManager';

// The static helpers on ConnectionManager are pure functions — no SSH
// connection needed. Testing them covers the 0% branch for the module.

describe('ConnectionManager.resolveClientId', () => {
  it('returns a sanitized id from the override when clientId is non-empty', () => {
    const id = ConnectionManager.resolveClientId({ clientId: '  my-laptop  ' });
    // sanitizeClientId lowercases and replaces non-alphanumeric with '-'
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(id).toContain('my');
    expect(id).toContain('laptop');
  });

  it('falls back to the OS hostname when clientId is an empty string', () => {
    const id = ConnectionManager.resolveClientId({ clientId: '' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('falls back to the OS hostname when clientId property is absent', () => {
    const id = ConnectionManager.resolveClientId({});
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});

describe('ConnectionManager.formatUserLabel', () => {
  it('returns "userName@clientId" when both settings are provided', () => {
    const label = ConnectionManager.formatUserLabel({ clientId: 'laptop', userName: 'alice' });
    expect(label).toContain('@');
    expect(label).toContain('alice');
    expect(label).toContain('laptop');
  });

  it('uses the OS username when userName is an empty string', () => {
    const label = ConnectionManager.formatUserLabel({ clientId: 'laptop', userName: '' });
    expect(label).toMatch(/@laptop$/);
  });

  it('uses the OS username when userName property is absent', () => {
    const label = ConnectionManager.formatUserLabel({ clientId: 'laptop' });
    expect(label).toMatch(/@laptop$/);
  });

  it('uses OS hostname for clientId when clientId is empty', () => {
    const label = ConnectionManager.formatUserLabel({ clientId: '', userName: 'alice' });
    expect(label).toMatch(/^alice@/);
  });
});
