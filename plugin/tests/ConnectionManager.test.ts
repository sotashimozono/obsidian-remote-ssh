import { describe, expect, it } from 'vitest';
import { ConnectionManager } from '../src/ConnectionManager';

describe('ConnectionManager static helpers', () => {
  it('resolveClientId sanitizes explicit clientId overrides', () => {
    expect(ConnectionManager.resolveClientId({ clientId: '  laptop / dev  ' })).toBe('laptop-dev');
  });

  it('resolveClientId falls back to defaultClientId when clientId is blank or omitted', () => {
    const fromBlank = ConnectionManager.resolveClientId({ clientId: '   ' });
    const fromEmpty = ConnectionManager.resolveClientId({ clientId: '' });
    const fromOmitted = ConnectionManager.resolveClientId({});
    // All three should resolve to the same defaultClientId() value
    expect(fromBlank).toBe(fromEmpty);
    expect(fromEmpty).toBe(fromOmitted);
    // sanitizeClientId is applied: only safe chars, no leading/trailing dash
    expect(fromBlank).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(fromBlank).not.toMatch(/^-|-$/);
  });

  it('formatUserLabel uses trimmed userName + resolved clientId', () => {
    expect(ConnectionManager.formatUserLabel({
      userName: '  alice  ',
      clientId: 'desk 01',
    })).toBe('alice@desk-01');
  });

  it('formatUserLabel falls back when values are blank', () => {
    const label = ConnectionManager.formatUserLabel({ userName: '   ', clientId: '   ' });
    const [name, id] = label.split('@');
    // Both sides of @ must be non-empty
    expect(name).toBeTruthy();
    expect(id).toBeTruthy();
    // clientId side must be sanitized (no spaces, slashes, leading/trailing dashes)
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(id).not.toMatch(/^-|-$/);
  });
});
