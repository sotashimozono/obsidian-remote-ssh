import { describe, it, expect } from 'vitest';
import { StartupReadGate } from '../src/adapter/StartupReadGate';

/** A stand-in for Obsidian's native adapter: methods on the prototype, as there. */
class NativeAdapter {
  calls: string[] = [];
  read(path: string) { this.calls.push(`native.read ${path}`); return Promise.reject(new Error(`ENOENT ${path}`)); }
  readBinary(path: string) { this.calls.push(`native.readBinary ${path}`); return Promise.resolve(new ArrayBuffer(0)); }
  exists(path: string) { this.calls.push(`native.exists ${path}`); return Promise.resolve(false); }
  stat(path: string) { this.calls.push(`native.stat ${path}`); return Promise.resolve(null); }
  list(path: string) { this.calls.push(`native.list ${path}`); return Promise.resolve({ files: [], folders: [] }); }
  write(path: string, _data: string) { this.calls.push(`native.write ${path}`); return Promise.resolve(); }
  rename(from: string, to: string) { this.calls.push(`native.rename ${from} ${to}`); return Promise.resolve(); }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { layoutReady?: boolean } = {}) {
  const adapter = new NativeAdapter();
  let ready = opts.layoutReady ?? true;
  const gate = new StartupReadGate(adapter as unknown as Record<string, unknown>, {
    configDir: '.obsidian',
    layoutReady: () => ready,
  });
  gate.install();
  /** What `AdapterManager.patch` does: take the gate off, then patch in the remote adapter. */
  const patchRemote = () => {
    gate.uninstall();
    const remote = adapter as unknown as Record<string, unknown>;
    remote.read = (p: string) => { adapter.calls.push(`remote.read ${p}`); return Promise.resolve(`content of ${p}`); };
  };
  return { adapter, gate, patchRemote, setReady: (v: boolean) => { ready = v; } };
}

describe('StartupReadGate', () => {
  it('holds a note read until the remote adapter is in, then serves it remotely', async () => {
    const { adapter, gate, patchRemote } = setup();

    const read = adapter.read('Daily/today.md');
    await settle();
    expect(adapter.calls, 'nothing reached the empty shadow folder').toEqual([]);

    patchRemote();
    gate.open();

    await expect(read).resolves.toBe('content of Daily/today.md');
    expect(adapter.calls).toEqual(['remote.read Daily/today.md']);
  });

  it('leaves writes alone: replayed onto the remote later, they could overwrite newer notes', async () => {
    const { adapter } = setup();

    await adapter.write('new.md', 'x');
    await adapter.rename('a.md', 'b.md');

    expect(adapter.calls).toEqual(['native.write new.md', 'native.rename a.md b.md']);
  });

  it('passes config-dir paths straight to the native adapter: settings live on the shadow disk', async () => {
    const { adapter } = setup();

    await adapter.exists('.obsidian/plugins/x/data.json');
    await adapter.stat('.obsidian');

    expect(adapter.calls).toEqual(['native.exists .obsidian/plugins/x/data.json', 'native.stat .obsidian']);
  });

  it('falls back to the native adapter when opened without a patch (the connect failed)', async () => {
    const { adapter, gate } = setup();

    const read = adapter.read('note.md');
    gate.open();

    await expect(read).rejects.toThrow('ENOENT note.md');
    expect(adapter.calls).toEqual(['native.read note.md']);
  });

  it('passes everything through before layout-ready, so Obsidian never waits on a held call', async () => {
    // The connect starts at layout-ready: holding a call Obsidian awaits on the
    // way there would deadlock startup.
    const { adapter, setReady } = setup({ layoutReady: false });

    await adapter.exists('note.md');
    setReady(true);
    void adapter.exists('later.md');
    await settle();

    expect(adapter.calls).toEqual(['native.exists note.md']);
  });

  it('leaves a wrapper another plugin put on top of it, which then passes through', async () => {
    // A plugin loaded after remote-ssh, or enabled while the gate is on, may
    // wrap the gate's member: uninstall must not drop that wrapper.
    const { adapter, gate } = setup();
    const gated = adapter.exists.bind(adapter);
    const theirs = (p: string) => { adapter.calls.push(`theirs.exists ${p}`); return gated(p); };
    (adapter as unknown as Record<string, unknown>).exists = theirs;

    gate.open();

    expect(adapter.exists).toBe(theirs);
    await expect(adapter.exists('n.md')).resolves.toBe(false);
    expect(adapter.calls).toEqual(['theirs.exists n.md', 'native.exists n.md']);
  });

  it('a held call under a foreign wrapper is not sent through that wrapper twice', async () => {
    // A wrapper with side effects (counting, transforming) must run once.
    const { adapter, gate } = setup();
    const gated = adapter.exists.bind(adapter);
    const theirs = (p: string) => { adapter.calls.push(`theirs.exists ${p}`); return gated(p); };
    (adapter as unknown as Record<string, unknown>).exists = theirs;

    const held = adapter.exists('a.md');
    gate.open();                                     // the connect failed: no patch
    await held;

    expect(adapter.calls).toEqual(['theirs.exists a.md', 'native.exists a.md']);
  });

  it('a held call under a foreign wrapper goes to the remote member once patched in', async () => {
    const { adapter, gate } = setup();
    const gated = adapter.read.bind(adapter);
    (adapter as unknown as Record<string, unknown>).read = (p: string) => gated(p);
    const held = adapter.read('a.md');

    gate.uninstall();                                 // what patch() does first
    (adapter as unknown as Record<string, unknown>).read = (p: string) => Promise.resolve(`remote ${p}`);
    gate.open();

    await expect(held).resolves.toBe('remote a.md');
  });

  it('captures a wrapper another plugin installed earlier, and puts it back', async () => {
    // Plugins wrap adapter members in their own onload; the gate goes on at
    // layout-ready, after them, so their wrapper is what it must preserve.
    const adapter = new NativeAdapter();
    const theirs = function (this: NativeAdapter, p: string) { this.calls.push(`theirs.exists ${p}`); return Promise.resolve(true); };
    (adapter as unknown as Record<string, unknown>).exists = theirs;
    const gate = new StartupReadGate(adapter as unknown as Record<string, unknown>, {
      configDir: '.obsidian', layoutReady: () => true,
    });
    gate.install();

    gate.open();

    expect(adapter.exists).toBe(theirs);
    await expect(adapter.exists('n.md')).resolves.toBe(true);
  });

  it('uninstall puts the native members back, so a patcher captures and restores those', () => {
    const { adapter, gate } = setup();
    expect(Object.prototype.hasOwnProperty.call(adapter, 'read')).toBe(true);

    gate.uninstall();

    expect(Object.prototype.hasOwnProperty.call(adapter, 'read')).toBe(false);
    expect(adapter.read).toBe(NativeAdapter.prototype.read);
  });

  it('after opening, calls go straight to whatever the adapter holds now', async () => {
    const { adapter, gate, patchRemote } = setup();
    patchRemote();
    gate.open();

    await expect(adapter.read('n.md')).resolves.toBe('content of n.md');
    expect(adapter.calls).toEqual(['remote.read n.md']);
  });

  it('open takes the wrappers off, so a later patch captures the native members', () => {
    // e.g. the first connect failed and a retry patches in the remote adapter.
    const { adapter, gate } = setup();

    gate.open();

    expect(Object.prototype.hasOwnProperty.call(adapter, 'read')).toBe(false);
  });

  it('open and uninstall are idempotent', async () => {
    const { adapter, gate } = setup();
    gate.open();
    gate.open();
    gate.uninstall();

    await expect(adapter.exists('n.md')).resolves.toBe(false);
  });
});
