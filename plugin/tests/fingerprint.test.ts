import { describe, it, expect } from 'vitest';
import { formatFingerprint } from '../src/util/fingerprint';

describe('formatFingerprint', () => {
  it('formats a lowercase hex string into colon-separated pairs', () => {
    expect(formatFingerprint('aabbcc')).toBe('aa:bb:cc');
  });

  it('lowercases uppercase input', () => {
    expect(formatFingerprint('AABBCC')).toBe('aa:bb:cc');
  });

  it('strips non-hex characters before formatting', () => {
    expect(formatFingerprint('aa:bb:cc')).toBe('aa:bb:cc');
  });

  it('handles a full sha256 hex string (32 bytes)', () => {
    const hex = 'a'.repeat(64);
    const result = formatFingerprint(hex);
    expect(result.split(':').length).toBe(32);
    expect(result).toBe(Array(32).fill('aa').join(':'));
  });

  it('returns empty string for empty input', () => {
    expect(formatFingerprint('')).toBe('');
  });
});
