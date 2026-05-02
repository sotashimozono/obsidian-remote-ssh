import { vi } from 'vitest';

/**
 * Factory for a mock of Node's `fs/promises` surface used by src/.
 * Every method is a vi.fn(). Import this in tests that need to stub
 * filesystem access without touching the real disk.
 *
 * Usage:
 *   vi.mock('fs/promises', () => makeMockFsPromises());
 *   const fsp = await import('fs/promises');
 *   (fsp.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('hi'));
 */
export function makeMockFsPromises() {
  return {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    readdir: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
    access: vi.fn(),
    copyFile: vi.fn(),
    mkdtemp: vi.fn(),
    realpath: vi.fn(),
  };
}

export type MockFsPromises = ReturnType<typeof makeMockFsPromises>;

/**
 * A pre-built Stats-shaped object for use with mocked `stat` / `lstat`.
 * Fields default to a regular file; override individual properties per test.
 */
export function makeStatResult(overrides: Partial<{
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
}> = {}): Record<string, unknown> {
  const o = {
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    size: 0,
    mtimeMs: 1_000_000_000_000,
    ctimeMs: 1_000_000_000_000,
    mode: 0o100644,
    ...overrides,
  };
  return {
    ...o,
    isFile: () => o.isFile,
    isDirectory: () => o.isDirectory,
    isSymbolicLink: () => o.isSymbolicLink,
  };
}
