import { describe, expect, it } from 'vitest';
import { ConnectionManager } from '../src/ConnectionManager';

describe('ConnectionManager static helpers', () => {
  it('resolveClientId sanitizes explicit clientId overrides', () => {
    expect(ConnectionManager.resolveClientId({ clientId: '  laptop / dev  ' })).toBe('laptop-dev');
  });

  it('formatUserLabel uses trimmed userName + resolved clientId', () => {
    expect(ConnectionManager.formatUserLabel({
      userName: '  alice  ',
      clientId: 'desk 01',
    })).toBe('alice@desk-01');
  });

  it('formatUserLabel falls back when values are blank', () => {
    const label = ConnectionManager.formatUserLabel({ userName: '   ', clientId: '   ' });
    expect(label).toMatch(/^.+@.+$/);
  });
});
