import { describe, it, expect, beforeEach } from 'vitest';
import { FileIndex } from '../src/sync/FileIndex';
import { DiffCalculator } from '../src/sync/DiffCalculator';
import type { FileEntry } from '../src/types';

const file = (relativePath: string, mtime: number, size = 100): FileEntry => ({
  relativePath, mtime, size, isDirectory: false,
});

describe('DiffCalculator', () => {
  let index: FileIndex;
  let calc: DiffCalculator;

  beforeEach(() => {
    index = new FileIndex();
    calc = new DiffCalculator(index);
  });

  it('schedules new remote file for download', () => {
    const result = calc.compute([file('notes/a.md', 1000)]);
    expect(result.toDownload).toHaveLength(1);
    expect(result.toDownload[0].relativePath).toBe('notes/a.md');
    expect(result.conflicts).toHaveLength(0);
  });

  it('skips unchanged file (same mtime within tolerance)', () => {
    index.updateRemote('notes/a.md', { mtime: 1000, size: 100 });
    index.updateLocal('notes/a.md', { mtime: 1000, size: 100 });
    const result = calc.compute([file('notes/a.md', 1001)]);
    expect(result.toDownload).toHaveLength(0);
  });

  it('downloads when remote mtime differs beyond tolerance', () => {
    index.updateRemote('notes/a.md', { mtime: 1000, size: 100 });
    index.updateLocal('notes/a.md', { mtime: 1000, size: 100 });
    const result = calc.compute([file('notes/a.md', 5000)]);
    expect(result.toDownload).toHaveLength(1);
  });

  it('detects conflict when both local and remote changed', () => {
    // knownRemote = 1000, knownLocal = 6000 (user edited locally, diff > tolerance)
    // new remote listing = 8000 (someone else also edited remotely)
    index.updateRemote('notes/a.md', { mtime: 1000, size: 100 });
    index.updateLocal('notes/a.md', { mtime: 6000, size: 110 });
    const result = calc.compute([file('notes/a.md', 8000)]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].relativePath).toBe('notes/a.md');
    expect(result.toDownload).toHaveLength(0);
  });

  it('marks local-only file for upload', () => {
    index.updateLocal('notes/local-only.md', { mtime: 1000, size: 50 });
    const result = calc.compute([]);
    expect(result.toUpload).toContain('notes/local-only.md');
  });

  it('marks remote-deleted file for local delete', () => {
    index.updateRemote('notes/gone.md', { mtime: 1000, size: 50 });
    const result = calc.compute([]);
    expect(result.toDeleteLocal).toContain('notes/gone.md');
  });

  it('handles directory entries gracefully', () => {
    const dir: FileEntry = { relativePath: 'notes', mtime: 1000, size: 0, isDirectory: true };
    const result = calc.compute([dir]);
    expect(result.toDownload).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it('handles multiple files at once', () => {
    // new remote file + unchanged file
    index.updateRemote('b.md', { mtime: 1000, size: 100 });
    index.updateLocal('b.md', { mtime: 1000, size: 100 });
    const result = calc.compute([file('a.md', 9000), file('b.md', 1001)]);
    expect(result.toDownload).toHaveLength(1);
    expect(result.toDownload[0].relativePath).toBe('a.md');
  });
});
