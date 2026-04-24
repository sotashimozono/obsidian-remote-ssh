import { describe, it, expect } from 'vitest';
import { IgnoreFilter } from '../src/sync/IgnoreFilter';

describe('IgnoreFilter', () => {
  it('ignores exact filename match', () => {
    const f = new IgnoreFilter(['.git', '.DS_Store']);
    expect(f.shouldIgnore('.git')).toBe(true);
    expect(f.shouldIgnore('.DS_Store')).toBe(true);
    expect(f.shouldIgnore('notes.md')).toBe(false);
  });

  it('ignores nested path with matching segment', () => {
    const f = new IgnoreFilter(['.git']);
    expect(f.shouldIgnore('subdir/.git')).toBe(true);
    expect(f.shouldIgnore('subdir/.git/config')).toBe(true);
  });

  it('handles wildcard extension pattern', () => {
    const f = new IgnoreFilter(['*.tmp', '*.bak']);
    expect(f.shouldIgnore('file.tmp')).toBe(true);
    expect(f.shouldIgnore('notes/draft.bak')).toBe(true);
    expect(f.shouldIgnore('file.md')).toBe(false);
  });

  it('handles Thumbs.db', () => {
    const f = new IgnoreFilter(['Thumbs.db']);
    expect(f.shouldIgnore('Thumbs.db')).toBe(true);
    expect(f.shouldIgnore('images/Thumbs.db')).toBe(true);
  });

  it('setPatterns updates patterns', () => {
    const f = new IgnoreFilter(['.git']);
    expect(f.shouldIgnore('node_modules')).toBe(false);
    f.setPatterns(['.git', 'node_modules']);
    expect(f.shouldIgnore('node_modules')).toBe(true);
  });

  it('empty pattern list ignores nothing', () => {
    const f = new IgnoreFilter([]);
    expect(f.shouldIgnore('.git')).toBe(false);
    expect(f.shouldIgnore('anything')).toBe(false);
  });
});
