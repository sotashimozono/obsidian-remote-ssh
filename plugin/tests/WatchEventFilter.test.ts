import { describe, it, expect } from 'vitest';
import { interpretWatchEvent } from '../src/path/WatchEventFilter';
import { PathMapper } from '../src/path/PathMapper';

describe('interpretWatchEvent', () => {
  it('passes ordinary vault paths through unchanged', () => {
    const m = new PathMapper('host-a');
    expect(interpretWatchEvent('Notes/foo.md', m)).toEqual({
      vaultPath: 'Notes/foo.md', remotePath: 'Notes/foo.md',
    });
  });

  it('translates our own per-client subtree back to the vault path', () => {
    const m = new PathMapper('host-a');
    expect(interpretWatchEvent('.obsidian/user/host-a/workspace.json', m)).toEqual({
      vaultPath: '.obsidian/workspace.json',
      remotePath: '.obsidian/user/host-a/workspace.json',
    });
  });

  it('drops events from another client\'s subtree', () => {
    const m = new PathMapper('host-a');
    expect(interpretWatchEvent('.obsidian/user/host-b/workspace.json', m)).toBeNull();
  });

  it('drops events on the bare user/ directory', () => {
    const m = new PathMapper('host-a');
    expect(interpretWatchEvent('.obsidian/user', m)).toBeNull();
  });

  it('drops atomic-write tmp file artefacts at any depth', () => {
    const m = new PathMapper('host-a');
    expect(interpretWatchEvent('.rsh-write-abcd.tmp', m)).toBeNull();
    expect(interpretWatchEvent('Notes/.rsh-write-9999.tmp', m)).toBeNull();
    expect(interpretWatchEvent('docs/sub/.rsh-write-xyz.tmp', m)).toBeNull();
  });

  it('does NOT drop a file that just happens to mention the tmp pattern mid-path', () => {
    // Suspiciously named user content shouldn't be filtered.
    const m = new PathMapper('host-a');
    expect(interpretWatchEvent('Notes/.rsh-write-real.md', m)).not.toBeNull();
    expect(interpretWatchEvent('rsh-write-template.md', m)).not.toBeNull();
  });

  it('passes events through unchanged when no PathMapper is attached', () => {
    expect(interpretWatchEvent('.obsidian/user/host-z/workspace.json', null))
      .toEqual({
        vaultPath: '.obsidian/user/host-z/workspace.json',
        remotePath: '.obsidian/user/host-z/workspace.json',
      });
  });

  it('passes shared .obsidian content (hotkeys, plugins, …) through unchanged', () => {
    const m = new PathMapper('host-a');
    expect(interpretWatchEvent('.obsidian/hotkeys.json', m)).toEqual({
      vaultPath: '.obsidian/hotkeys.json',
      remotePath: '.obsidian/hotkeys.json',
    });
    expect(interpretWatchEvent('.obsidian/plugins/myplugin/data.json', m)).toEqual({
      vaultPath: '.obsidian/plugins/myplugin/data.json',
      remotePath: '.obsidian/plugins/myplugin/data.json',
    });
  });
});
