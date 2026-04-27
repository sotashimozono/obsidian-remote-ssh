import { describe, it, expect } from 'vitest';
import { WindowSpawner, type UrlOpener } from '../src/shadow/WindowSpawner';

function recordingOpener() {
  const calls: string[] = [];
  const opener: UrlOpener = { openUrl(url) { calls.push(url); } };
  return { opener, calls };
}

describe('WindowSpawner', () => {
  it('builds an obsidian://open?path=… URL with the encoded vault path', () => {
    const { opener, calls } = recordingOpener();
    const spawner = new WindowSpawner(opener);
    const url = spawner.spawn('C:\\Users\\alice\\.obsidian-remote\\vaults\\p1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(url);
    expect(url.startsWith('obsidian://open?path=')).toBe(true);
    expect(url).toContain(encodeURIComponent('C:\\Users\\alice\\.obsidian-remote\\vaults\\p1'));
  });

  it('encodes characters that would otherwise break the URL', () => {
    const { opener, calls } = recordingOpener();
    const spawner = new WindowSpawner(opener);
    spawner.spawn('/path/with spaces/and?question&amp');
    expect(calls[0]).toContain(encodeURIComponent('/path/with spaces/and?question&amp'));
    // Spaces / `?` / `&` must NOT appear unencoded after `path=`.
    const after = calls[0].slice('obsidian://open?path='.length);
    expect(after).not.toMatch(/[ ?&]/);
  });

  it('returns the URL it fired (so callers can log or surface it)', () => {
    const { opener } = recordingOpener();
    const url = new WindowSpawner(opener).spawn('/a/b');
    expect(url).toBe('obsidian://open?path=' + encodeURIComponent('/a/b'));
  });
});
