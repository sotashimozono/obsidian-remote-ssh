import { describe, it, expect } from 'vitest';
import { errorMessage, asError } from '../src/util/errorMessage';

describe('errorMessage', () => {
  it('returns the message property when passed an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('coerces a string to string unchanged', () => {
    expect(errorMessage('plain string')).toBe('plain string');
  });

  it('coerces a number via String()', () => {
    expect(errorMessage(42)).toBe('42');
  });

  it('coerces null via String()', () => {
    expect(errorMessage(null)).toBe('null');
  });

  it('coerces undefined via String()', () => {
    expect(errorMessage(undefined)).toBe('undefined');
  });

  it('returns an empty string for an Error with no message', () => {
    expect(errorMessage(new Error())).toBe('');
  });
});

describe('asError', () => {
  it('returns the same Error instance when passed an Error', () => {
    const e = new Error('original');
    expect(asError(e)).toBe(e);
  });

  it('wraps a string in a new Error', () => {
    const result = asError('raw string');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('raw string');
  });

  it('wraps a number in a new Error using String()', () => {
    const result = asError(99);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('99');
  });

  it('wraps null in a new Error', () => {
    const result = asError(null);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('null');
  });

  it('preserves subclass instances (TypeError, etc.) unchanged', () => {
    const e = new TypeError('type mismatch');
    expect(asError(e)).toBe(e);
    expect(asError(e)).toBeInstanceOf(TypeError);
  });
});
